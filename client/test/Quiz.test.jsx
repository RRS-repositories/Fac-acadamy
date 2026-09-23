import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

/*
 * The quiz and its result view. Questions, options and grading all come from
 * the mocked API; the strings below are invented for the test.
 *
 * The scroll assertion is CHECKLIST 05: "Answer 5 quiz questions scrolled
 * mid-page → scroll position never jumps".
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.scrollTo = () => {};
});

function trackStage(overrides = {}) {
  return {
    code: 's1',
    title: 'Stage One',
    blurb: 'An invented blurb.',
    displayNum: '1',
    level: 1,
    dept: null,
    position: 1,
    state: 'available',
    pct: 0,
    attempts: 0,
    best: null,
    passMark: 70,
    lessonCount: 1,
    recordingCount: 0,
    recordingsWithMedia: 0,
    ...overrides,
  };
}

const TRACK = {
  track: 'CS',
  waitingForTrack: false,
  stages: [
    trackStage(),
    trackStage({ code: 's2', title: 'Stage Two', displayNum: '2', position: 2 }),
  ],
};

const STAGE = {
  stage: trackStage(),
  lessons: [{ id: 11, title: 'Alpha lesson', bodyHtml: '<p>Body.</p>', position: 1, read: true }],
  recordings: [],
  quiz: {
    questionCount: 5,
    passMark: 70,
    attempts: 0,
    best: null,
    passed: false,
    unlocked: true,
    blockedBy: null,
  },
};

const QUESTIONS = [1, 2, 3, 4, 5].map((n) => ({
  id: 100 + n,
  prompt: `Invented question ${n}?`,
  options: [1, 2, 3, 4].map((o) => ({ id: 1000 + n * 10 + o, text: `Q${n} option ${o}` })),
}));

const QUIZ = { stageCode: 's1', passMark: 70, questions: QUESTIONS };

function result({ passed, reveal }) {
  return {
    attemptId: 1,
    pct: passed ? 80 : 40,
    passed,
    correctCount: passed ? 4 : 2,
    total: 5,
    perQuestion: QUESTIONS.map((q, i) => ({
      questionId: q.id,
      correct: passed ? i < 4 : i < 2,
      correctOptionId: reveal ? q.options[0].id : null,
    })),
  };
}

function routes(extra = {}) {
  return {
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, TRACK],
    'GET /api/stage/s1': [200, STAGE],
    'GET /api/stage/s1/quiz': [200, QUIZ],
    ...extra,
  };
}

/** Pick the first option of every question, in order. */
function answerEverything() {
  const radios = screen.getAllByRole('radio');
  for (let q = 0; q < 5; q += 1) fireEvent.click(radios[q * 4]);
}

describe('Quiz attempt', () => {
  it('never moves the page when an answer is selected', async () => {
    mockFetch(routes());
    let scrollY = 400;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    const scrollTo = vi.fn((options) => {
      scrollY = typeof options === 'object' && options ? (options.top ?? scrollY) : 0;
    });

    renderApp('/stage/s1/quiz');
    await screen.findByText('Invented question 1?');

    // The trainee has scrolled down the page before answering.
    scrollY = 400;
    window.scrollTo = scrollTo;

    const radios = screen.getAllByRole('radio');
    for (let q = 0; q < 5; q += 1) {
      const before = window.scrollY;
      fireEvent.click(radios[q * 4]);
      expect(window.scrollY).toBe(before);
    }
    expect(scrollY).toBe(400);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByText('5/5 answered')).toBeInTheDocument();
  });

  it('keeps the question heading inside its card, as the first thing in it', async () => {
    mockFetch(routes());
    renderApp('/stage/s1/quiz');
    await screen.findByText('Invented question 1?');

    const cards = screen.getAllByTestId('question-card');
    expect(cards).toHaveLength(5);

    cards.forEach((card, i) => {
      // The heading is a real descendant of the card, not a sibling above it.
      const heading = screen.getByText(`Invented question ${i + 1}?`).closest('h2');
      expect(heading).not.toBeNull();
      expect(card).toContainElement(heading);
      // …and it is the card's first child, so nothing sits above the question.
      expect(card.firstElementChild).toBe(heading);
      // A <legend> is painted on the fieldset's border box: it escapes the
      // card's padding and leaves that padding as a gap. Never again.
      expect(card.tagName).not.toBe('FIELDSET');
      expect(card.querySelector('legend')).toBeNull();
      // The first option follows the heading directly — no spacer between.
      expect(card.children[1]).toHaveTextContent(`Q${i + 1} option 1`);
      // The group is still announced with the question as its name.
      expect(card).toHaveAttribute('aria-labelledby', heading.id);
    });
  });

  it('keeps submit disabled until every question is answered', async () => {
    mockFetch(routes());
    renderApp('/stage/s1/quiz');
    await screen.findByText('Invented question 1?');

    const submit = screen.getByRole('button', { name: 'Submit answers' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('0/5 answered')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('radio')[0]);
    expect(screen.getByText('1/5 answered')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    answerEverything();
    expect(submit).toBeEnabled();
  });

  it('submits every answer as { questionId, optionId } in the API order', async () => {
    const fetchMock = mockFetch(
      routes({ 'POST /api/stage/s1/quiz': [200, result({ passed: true, reveal: true })] }),
    );
    renderApp('/stage/s1/quiz');
    await screen.findByText('Invented question 1?');

    answerEverything();
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/stage/s1/quiz')).toHaveLength(1));
    const [[, init]] = callsTo(fetchMock, 'POST', '/api/stage/s1/quiz');
    expect(JSON.parse(init.body)).toEqual({
      answers: QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id })),
    });
  });
});

describe('Quiz result', () => {
  async function submitAndSee(graded) {
    mockFetch(routes({ 'POST /api/stage/s1/quiz': [200, graded] }));
    renderApp('/stage/s1/quiz');
    await screen.findByText('Invented question 1?');
    answerEverything();
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    await screen.findByRole('heading', { name: 'Answer review' });
  }

  it('after a FAIL shows right/wrong only — never a correct answer (D3)', async () => {
    await submitAndSee(result({ passed: false, reveal: false }));

    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Not quite — 70% needed' })).toBeInTheDocument();
    expect(screen.getAllByText('Correct')).toHaveLength(2);
    expect(screen.getAllByText('Incorrect')).toHaveLength(3);
    // The reveal is the whole point of D3: nothing may be marked as the answer.
    expect(screen.queryAllByTestId('correct-answer')).toHaveLength(0);
    expect(screen.queryByText('Correct answer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next stage →' })).not.toBeInTheDocument();
  });

  it('after a PASS shows which option was correct, and the way on', async () => {
    await submitAndSee(result({ passed: true, reveal: true }));

    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stage 1 passed 🎉' })).toBeInTheDocument();
    expect(screen.getAllByTestId('correct-answer')).toHaveLength(5);
    expect(screen.getAllByText('Correct answer — you chose this')).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'Next stage →' })).toHaveAttribute('href', '/stage/s2');
    expect(screen.getByRole('link', { name: 'Back to my training' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('reviews each question in the same card as the attempt screen', async () => {
    await submitAndSee(result({ passed: false, reveal: false }));

    const cards = screen.getAllByTestId('question-card');
    expect(cards).toHaveLength(5);
    cards.forEach((card, i) => {
      const heading = screen.getByRole('heading', { name: `Invented question ${i + 1}?` });
      expect(card).toContainElement(heading);
      expect(card.querySelector('legend')).toBeNull();
      expect(card.firstElementChild).toContainElement(heading);
    });
  });

  it('Try again starts a fresh attempt with nothing selected', async () => {
    await submitAndSee(result({ passed: false, reveal: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Invented question 1?')).toBeInTheDocument();
    expect(screen.getByText('0/5 answered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
    expect(screen.getAllByRole('radio').every((radio) => !radio.checked)).toBe(true);
  });
});
