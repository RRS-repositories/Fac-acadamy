import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

/*
 * The video library on the dashboard: the shelf of videos that belong to no
 * stage (user decision, 19 Oct).
 *
 * Every title and description here is invented test data. No real training
 * content lives in this repo and none reaches the bundle.
 *
 * What these mostly assert is the two rules the feature exists under, because
 * they are the ones a later change could quietly break:
 *
 *   * nothing here is a NoSeekPlayer, so the browser's own controls are
 *     present and seeking is free;
 *   * nothing here is reported, so the section posts NOTHING — no beacon, no
 *     progress, no credit towards any stage.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stage(overrides) {
  return {
    code: 'c1',
    title: 'Core stage',
    blurb: 'A test blurb.',
    displayNum: '1',
    level: 1,
    dept: null,
    position: 1,
    state: 'available',
    pct: 0,
    attempts: 0,
    best: null,
    passMark: 80,
    lessonCount: 1,
    recordingCount: 0,
    recordingsWithMedia: 0,
    ...overrides,
  };
}

const TRACK = {
  track: 'ADMIN',
  waitingForTrack: false,
  stages: [stage({})],
};

function video(overrides) {
  return { id: 1, title: 'Test video one', description: null, durationSecs: 359, ...overrides };
}

/** The dashboard, with whatever the library endpoint is told to answer. */
function showDashboard(libraryEntry) {
  const routes = {
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, TRACK],
    'GET /api/certs': [200, { certificates: [] }],
  };
  if (libraryEntry !== undefined) routes['GET /api/videos'] = libraryEntry;
  const fetchMock = mockFetch(routes);
  renderApp('/');
  return fetchMock;
}

function section() {
  const heading = screen.queryByRole('heading', { name: /Training Videos/i });
  return heading === null ? null : heading.closest('section');
}

describe('the video library on the dashboard', () => {
  it('lists every video with its title', async () => {
    showDashboard([
      200,
      {
        videos: [
          video({ id: 7, title: 'Test video one', durationSecs: 359 }),
          video({ id: 8, title: 'Test video two', durationSecs: 545 }),
          video({ id: 9, title: 'Test video three', durationSecs: 579 }),
        ],
      },
    ]);

    await screen.findByRole('heading', { name: /Training Videos/i });
    const panel = section();
    expect(within(panel).getByRole('heading', { name: 'Test video one' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Test video two' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Test video three' })).toBeInTheDocument();
    expect(within(panel).getAllByText(/^Length /)).toHaveLength(3);
    // The count beside the heading agrees with the list, pluralised.
    expect(panel.textContent).toContain('3 videos');
  });

  it('shows a length as m:ss, and leaves it out when the server does not know it', async () => {
    showDashboard([
      200,
      {
        videos: [
          video({ id: 7, title: 'Known length', durationSecs: 359 }),
          video({ id: 8, title: 'Unknown length', durationSecs: null }),
        ],
      },
    ]);

    await screen.findByRole('heading', { name: /Training Videos/i });
    const panel = section();
    // 359s is 5:59 — floored, not rounded up to 6:00.
    expect(within(panel).getByText('Length 5:59')).toBeInTheDocument();
    // One length on the page, not two: an unreadable duration is omitted
    // rather than shown as a dash or a guess.
    expect(within(panel).getAllByText(/^Length /)).toHaveLength(1);
  });

  it('gives each video the browser controls and free seeking, never a no-seek player', async () => {
    showDashboard([200, { videos: [video({ id: 7, title: 'Test video one' })] }]);

    await screen.findByRole('heading', { name: /Training Videos/i });
    const player = screen.getByTestId('library-video-7');
    expect(player.tagName).toBe('VIDEO');
    // The whole point of the library: the controls are the browser's own.
    expect(player).toHaveAttribute('controls');
    expect(player.getAttribute('src')).toBe('/api/videos/7/stream');
    // Announced as something, not just "video".
    expect(player).toHaveAttribute('aria-label', 'Training video: Test video one');
  });

  it('reports nothing: no beacon, no progress, no credit', async () => {
    const fetchMock = showDashboard([
      200,
      { videos: [video({ id: 7 }), video({ id: 8, title: 'Test video two' })] },
    ]);

    await screen.findByRole('heading', { name: /Training Videos/i });
    // Not one POST anywhere. If a later change adds a beacon to this path it
    // becomes a way to pay a stage's listening gate without visiting it.
    const posted = fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'POST');
    expect(posted).toEqual([]);
    expect(callsTo(fetchMock, 'POST', '/api/media/7/progress')).toEqual([]);
    expect(callsTo(fetchMock, 'POST', '/api/videos/7/progress')).toEqual([]);
  });

  it('renders nothing at all when the shelf is empty — not even a heading', async () => {
    showDashboard([200, { videos: [] }]);

    // Wait for the dashboard itself, so this is not passing on a blank render.
    await screen.findByText(/Work through each stage in order/);
    expect(section()).toBeNull();
    expect(screen.queryByText(/Training Videos/i)).toBeNull();
  });

  it('stays out of the way when the endpoint fails, and the training still shows', async () => {
    showDashboard([500, { error: 'unknown' }]);

    await screen.findByText(/Work through each stage in order/);
    expect(section()).toBeNull();
  });

  it('stays out of the way on a server that has no such endpoint yet (404)', async () => {
    // No 'GET /api/videos' route at all: mockFetch answers 404, which is what
    // every deployment looks like until the route ships.
    showDashboard(undefined);

    await screen.findByText(/Work through each stage in order/);
    expect(section()).toBeNull();
  });

  it('does not trust a malformed list', async () => {
    // `durationSecs` as a string is the shape a careless server change makes.
    showDashboard([
      200,
      { videos: [{ id: 7, title: 'Bad', description: null, durationSecs: '5' }] },
    ]);

    await screen.findByText(/Work through each stage in order/);
    expect(section()).toBeNull();
  });
});
