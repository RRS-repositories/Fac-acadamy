import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { STAFF, mockFetch, renderApp } from './helpers.jsx';

/*
 * The dashboard notice for an academy that has GROWN since the trainee
 * finished it (migration 0013).
 *
 * Every stage, count and date here is invented test data — no real training
 * content appears in this repo, and the bundle never holds any either.
 *
 * What these assert, mostly, is that the browser DECIDES NOTHING. `grownSince`
 * is the server's answer; the notice appears when it is true and stays away
 * when it is false, even when the counts on the payload would suggest
 * otherwise.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stage(overrides) {
  return {
    code: 'x1',
    title: 'Test stage',
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
    lessonCount: 1,
    recordingCount: 0,
    recordingsWithMedia: 0,
    ...overrides,
  };
}

/** An academy of three modules, two of them already passed. */
function grownTrack(deptOverrides = {}, stageOverrides = {}) {
  return {
    track: 'ADMIN',
    waitingForTrack: false,
    stages: [
      stage({ code: 'c1', title: 'Core stage', position: 1 }),
      stage({
        code: 'd1',
        title: 'Module one',
        displayNum: 'A1',
        level: null,
        dept: 'ADMIN',
        position: 2,
      }),
      stage({
        code: 'd3',
        title: 'The new module',
        displayNum: 'A2',
        level: null,
        dept: 'ADMIN',
        position: 3,
        state: 'available',
        pct: 0,
        attempts: 0,
        best: null,
        ...stageOverrides,
      }),
      stage({
        code: 'd2',
        title: 'Module two',
        displayNum: 'A3',
        level: null,
        dept: 'ADMIN',
        position: 4,
      }),
    ],
    levels: [
      {
        level: 1,
        name: 'Test level',
        weeks: null,
        accomplishment: 'Test accomplishment',
        description: null,
        completedAt: '2026-09-12T09:00:00.000Z',
        completedCount: 1,
        currentCount: 1,
        grownSince: false,
      },
    ],
    depts: [
      {
        code: 'ADMIN',
        name: 'Test Academy',
        icon: null,
        accomplishment: null,
        description: null,
        completedAt: '2026-09-12T09:00:00.000Z',
        completedCount: 2,
        currentCount: 3,
        grownSince: true,
        ...deptOverrides,
      },
    ],
  };
}

function showDashboard(track) {
  mockFetch({
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, track],
    'GET /api/certs': [200, { certificates: [] }],
  });
  renderApp('/');
}

function notice() {
  return screen.queryByRole('heading', { name: /grown/i });
}

describe('an academy that has grown since the trainee finished it', () => {
  it('says what happened, in plain words, and that the old certificate stands', async () => {
    showDashboard(grownTrack());

    const heading = await screen.findByRole('heading', {
      name: 'This has grown since you finished it',
    });
    const section = heading.closest('section');
    expect(within(section).getByText(/still valid and stays valid/i)).toBeInTheDocument();
    expect(within(section).getByText('Test Academy')).toBeInTheDocument();
    // The date, the size then, the size now, and what to do about it. Read off
    // the whole section, because the sentence is interpolated across nodes.
    expect(section.textContent).toMatch(
      /You finished this on 12 Sept? 2026, when it had 2 modules\. It now has 3\./,
    );
    expect(section.textContent).toMatch(
      /Pass the 1 new module and you will be issued an up-to-date certificate\./,
    );
  });

  it('stays away when the server says it has not grown', async () => {
    showDashboard(grownTrack({ grownSince: false }));

    expect(await screen.findByRole('heading', { name: /Welcome back/ })).toBeInTheDocument();
    expect(notice()).toBeNull();
  });

  it('stays away when the completion is there but its size is not known', async () => {
    // A completion from before the scope was recorded, whose size could not be
    // inferred: the server sends grownSince false, and nothing is claimed.
    showDashboard(grownTrack({ completedCount: null, grownSince: false }));

    expect(await screen.findByRole('heading', { name: /Welcome back/ })).toBeInTheDocument();
    expect(notice()).toBeNull();
  });

  it('does not tell somebody to pass a module they have already passed', async () => {
    // The narrow case where the new module went live before the academy began
    // recording what a completion covered, and they have since done it.
    showDashboard(grownTrack({}, { state: 'done', attempts: 1, best: 88, pct: 88 }));

    const heading = await screen.findByRole('heading', {
      name: 'This has grown since you finished it',
    });
    const section = heading.closest('section');
    expect(section.textContent).toMatch(/You have already passed everything in it/);
    expect(section.textContent).not.toMatch(/Pass the/);
  });
});
