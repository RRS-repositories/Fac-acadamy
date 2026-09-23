import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';
import { sanitizeLessonHtml } from '../src/components/training/LessonBody.jsx';

/*
 * The lesson reader. Every string it shows comes from the mocked API — the
 * markup below is invented for the test and is not the prototype's content.
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
    lessonCount: 2,
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

function lesson(overrides = {}) {
  return {
    id: 11,
    title: 'Alpha lesson',
    bodyHtml: '<p>Invented body paragraph one.</p>',
    position: 1,
    read: false,
    ...overrides,
  };
}

function stageResponse(lessons) {
  return {
    stage: trackStage(),
    lessons,
    recordings: [],
    quiz: {
      questionCount: 5,
      passMark: 70,
      attempts: 0,
      best: null,
      passed: false,
      unlocked: false,
      blockedBy: 'lessons',
    },
  };
}

function routes(stage) {
  return {
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, TRACK],
    'GET /api/stage/s1': [200, stage],
  };
}

describe('Lesson reader', () => {
  it('renders the body HTML the API served and marks the lesson read', async () => {
    // The server is the source of truth: it starts unread and answers "read"
    // once the POST has landed, so the refetch has to agree with the tick.
    const state = { read: false };
    const fetchMock = mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, TRACK],
      'GET /api/stage/s1': () => [
        200,
        stageResponse([
          lesson({ read: state.read }),
          lesson({ id: 12, title: 'Beta lesson', position: 2 }),
        ]),
      ],
      'POST /api/lesson/11/read': () => {
        state.read = true;
        return [204, undefined];
      },
    });

    renderApp('/stage/s1/lesson/11');

    expect(await screen.findByRole('heading', { name: 'Alpha lesson' })).toBeInTheDocument();
    expect(screen.getByText('Invented body paragraph one.')).toBeInTheDocument();
    expect(screen.getByText('Lesson 1 of 2 · Stage 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark lesson complete ✓' }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/lesson/11/read')).toHaveLength(1));
    expect(await screen.findByText('✓ Marked as read')).toBeInTheDocument();
  });

  it('prev/next moves between lessons and scrolls to the top every time', async () => {
    const lessons = [
      lesson({ read: true }),
      lesson({ id: 12, title: 'Beta lesson', position: 2, read: true }),
    ];
    mockFetch(routes(stageResponse(lessons)));
    const scrollTo = vi.spyOn(window, 'scrollTo');

    renderApp('/stage/s1/lesson/11');
    await screen.findByRole('heading', { name: 'Alpha lesson' });

    scrollTo.mockClear();
    fireEvent.click(screen.getByRole('link', { name: 'Next lesson →' }));
    expect(await screen.findByRole('heading', { name: 'Beta lesson' })).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalled();

    scrollTo.mockClear();
    fireEvent.click(screen.getByRole('link', { name: '← Previous' }));
    expect(await screen.findByRole('heading', { name: 'Alpha lesson' })).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalled();
  });

  it('offers the quiz once every lesson in the stage is read', async () => {
    const lessons = [
      lesson({ read: true }),
      lesson({ id: 12, title: 'Beta lesson', position: 2, read: true }),
    ];
    mockFetch(routes(stageResponse(lessons)));

    renderApp('/stage/s1/lesson/12');

    const link = await screen.findByRole('link', { name: 'Continue to the quiz →' });
    expect(link).toHaveAttribute('href', '/stage/s1/quiz');
  });
});

describe('sanitizeLessonHtml', () => {
  it('strips a <script>, an onclick and a javascript: URL', () => {
    const dirty =
      '<p>Kept text.</p><script>window.pwned = 1;</script>' +
      '<button onclick="alert(1)">Press</button>' +
      '<a href="javascript:alert(2)">Link</a>';
    const clean = sanitizeLessonHtml(dirty);

    expect(clean).toContain('Kept text.');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('window.pwned');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('Press');
    expect(clean).toContain('Link');
  });

  it('keeps ordinary markup, classes and inline styles', () => {
    const clean = sanitizeLessonHtml(
      '<div class="callout key" style="display:none"><b>Note</b>Body</div>',
    );
    expect(clean).toContain('class="callout key"');
    expect(clean).toContain('style="display:none"');
  });
});

describe('interactive lesson markup (invented, not prototype content)', () => {
  const TABS =
    '<div class="doc-tabs">' +
    '<button id="tabGood" class="on" onclick="showDemo(\'good\')">Replica A</button>' +
    '<button id="tabBad" onclick="showDemo(\'bad\')">Replica B</button>' +
    '</div>' +
    '<div id="demoGood"><p>Replica A contents</p></div>' +
    '<div id="demoBad" style="display:none"><p>Replica B contents</p></div>';

  const SEARCH =
    '<input type="text" placeholder="Type to search" oninput="filterDemo(this.value)">' +
    '<div id="demoList">' +
    '<div class="sg-item" data-k="alpha row one">Alpha row</div>' +
    '<div class="sg-item" data-k="beta row two">Beta row</div>' +
    '</div>';

  it('toggles DSAR-style replica tabs without any inline handler', async () => {
    mockFetch(routes(stageResponse([lesson({ bodyHtml: TABS })])));
    const { container } = renderApp('/stage/s1/lesson/11');

    await screen.findByRole('heading', { name: 'Alpha lesson' });
    const good = container.querySelector('#demoGood');
    const bad = container.querySelector('#demoBad');
    expect(bad.style.display).toBe('none');
    expect(good.style.display).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Replica B' }));
    expect(bad.style.display).toBe('');
    expect(good.style.display).toBe('none');
    expect(container.querySelector('#tabBad').className).toContain('on');

    fireEvent.click(screen.getByRole('button', { name: 'Replica A' }));
    expect(good.style.display).toBe('');
    expect(bad.style.display).toBe('none');
  });

  it('filters Status-Guide-style rows as the trainee types', async () => {
    mockFetch(routes(stageResponse([lesson({ bodyHtml: SEARCH })])));
    const { container } = renderApp('/stage/s1/lesson/11');

    await screen.findByRole('heading', { name: 'Alpha lesson' });
    const rows = container.querySelectorAll('.sg-item');
    const box = container.querySelector('input[type="text"]');

    fireEvent.input(box, { target: { value: 'beta' } });
    expect(rows[0].style.display).toBe('none');
    expect(rows[1].style.display).toBe('');

    fireEvent.input(box, { target: { value: '' } });
    expect(rows[0].style.display).toBe('');
    expect(rows[1].style.display).toBe('');
  });
});
