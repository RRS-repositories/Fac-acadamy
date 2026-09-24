import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { STAFF, mockFetch, renderApp } from './helpers.jsx';

/*
 * The stage view, against a mocked /api/stage/:code. All invented test data:
 * no lesson body, question or answer belongs in this repo.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const TRACK = {
  track: 'CS',
  waitingForTrack: false,
  stages: [
    {
      code: 'a1',
      title: 'Alpha stage',
      blurb: 'A test blurb.',
      displayNum: '1',
      level: 1,
      dept: null,
      position: 1,
      state: 'done',
      pct: 90,
      attempts: 1,
      best: 90,
      passMark: 80,
      lessonCount: 2,
      recordingCount: 0,
      recordingsWithMedia: 0,
    },
    {
      code: 'a2',
      title: 'Bravo stage',
      blurb: 'Another test blurb.',
      displayNum: '2',
      level: 1,
      dept: null,
      position: 2,
      state: 'available',
      pct: 0,
      attempts: 0,
      best: null,
      passMark: 80,
      lessonCount: 2,
      recordingCount: 2,
      recordingsWithMedia: 1,
    },
  ],
};

const STAGE_A2 = {
  stage: TRACK.stages[1],
  lessons: [
    { id: 11, title: 'First test lesson', bodyHtml: '<p>test</p>', position: 1, read: true },
    { id: 12, title: 'Second test lesson', bodyHtml: '<p>test</p>', position: 2, read: false },
  ],
  recordings: [
    {
      id: 21,
      title: 'Test recording one',
      description: 'A recorded example.',
      durationSecs: 125,
      mediaType: 'AUDIO',
      comingSoon: false,
      listened: false,
    },
    {
      id: 22,
      title: 'Test recording two',
      description: 'Not ready yet.',
      durationSecs: null,
      mediaType: 'AUDIO',
      comingSoon: true,
      listened: false,
    },
  ],
  quiz: {
    questionCount: 5,
    passMark: 80,
    attempts: 0,
    best: null,
    passed: false,
    unlocked: false,
    blockedBy: 'lessons',
  },
};

function signedIn(routes) {
  return mockFetch({
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, TRACK],
    ...routes,
  });
}

function main() {
  return within(screen.getByRole('main'));
}

describe('Stage view', () => {
  it('shows the header, the step pills, the lessons and the recordings', async () => {
    signedIn({ 'GET /api/stage/a2': [200, STAGE_A2] });
    renderApp('/stage/a2');

    expect(
      await screen.findByRole('heading', { name: 'Bravo stage', level: 1 }),
    ).toBeInTheDocument();
    expect(main().getByText('Another test blurb.')).toBeInTheDocument();

    const pills = within(screen.getByRole('navigation', { name: 'Stage steps' }));
    expect(pills.getByText('Lessons (1/2)')).toBeInTheDocument();
    // Only the one recording with media counts toward the recordings step.
    expect(pills.getByText('Call recordings (0/1)')).toBeInTheDocument();
    expect(pills.getByText(/Exam · pass 80%/)).toBeInTheDocument();

    const first = main().getByRole('link', { name: /First test lesson/ });
    expect(first).toHaveAttribute('href', '/stage/a2/lesson/11');
    expect(main().getByRole('link', { name: /Second test lesson/ })).toHaveAttribute(
      'href',
      '/stage/a2/lesson/12',
    );
    // The read tick is on the lesson the API marked as read.
    expect(first.textContent).toContain('Read');
  });

  it('shows a coming-soon recording greyed out, and it does not block the quiz', async () => {
    const unlockedQuiz = {
      ...STAGE_A2,
      lessons: STAGE_A2.lessons.map((l) => ({ ...l, read: true })),
      quiz: { ...STAGE_A2.quiz, unlocked: true, blockedBy: null },
    };
    signedIn({ 'GET /api/stage/a2': [200, unlockedQuiz] });
    renderApp('/stage/a2');
    await screen.findByRole('heading', { name: 'Bravo stage', level: 1 });

    const comingSoon = document.querySelector('[data-recording="22"]');
    expect(comingSoon.getAttribute('data-coming-soon')).toBe('true');
    expect(within(comingSoon).getByText('Coming soon')).toBeInTheDocument();
    expect(comingSoon.className).toContain('opacity-');
    expect(within(comingSoon).queryByRole('button')).toBeNull();

    // The un-listened recording never gates the quiz (decision D4).
    expect(main().getByRole('link', { name: 'Start the stage quiz →' })).toHaveAttribute(
      'href',
      '/stage/a2/quiz',
    );
  });

  it('disables the quiz with a reason while blockedBy is "lessons"', async () => {
    signedIn({ 'GET /api/stage/a2': [200, STAGE_A2] });
    renderApp('/stage/a2');
    await screen.findByRole('heading', { name: 'Bravo stage', level: 1 });

    expect(main().getByRole('button', { name: 'Quiz locked' })).toBeDisabled();
    expect(main().queryByRole('link', { name: /Start the stage quiz/ })).toBeNull();
    expect(
      main().getByText('Read every lesson in this stage to unlock the quiz.'),
    ).toBeInTheDocument();
  });

  it('renders the locked state for a 403, with no stage content', async () => {
    signedIn({ 'GET /api/stage/a2': [403, { error: 'locked', requires: 'a1' }] });
    renderApp('/stage/a2');

    expect(
      await screen.findByRole('heading', { name: 'This stage is locked' }),
    ).toBeInTheDocument();
    // The 403 body names the prerequisite, which is a stage they can already see.
    expect(main().getByText(/Pass Stage 1 — Alpha stage/)).toBeInTheDocument();
    // Nothing from the stage itself reaches the page.
    expect(main().queryByText(/test lesson/i)).toBeNull();
    expect(main().queryByText(/Test recording/i)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Stage steps' })).toBeNull();
  });

  it('renders a plain message for a stage on another track', async () => {
    signedIn({ 'GET /api/stage/zz': [404, { error: 'not_found' }] });
    renderApp('/stage/zz');

    expect(
      await screen.findByRole('heading', { name: "That stage isn't part of your programme" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Stage steps' })).toBeNull();
  });
});
