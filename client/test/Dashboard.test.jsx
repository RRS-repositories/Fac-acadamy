import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { STAFF, mockFetch, renderApp } from './helpers.jsx';

/*
 * The dashboard, against a mocked /api/track. Every stage, state, score and
 * count here is invented test data — no real training content appears in this
 * repo, and the bundle never holds any either.
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
    state: 'locked',
    pct: 0,
    attempts: 0,
    best: null,
    passMark: 80,
    lessonCount: 2,
    recordingCount: 0,
    recordingsWithMedia: 0,
    ...overrides,
  };
}

const AGENT_TRACK = {
  track: 'CS',
  waitingForTrack: false,
  stages: [
    stage({
      code: 'a1',
      title: 'Alpha stage',
      displayNum: '1',
      level: 1,
      position: 1,
      state: 'done',
      attempts: 2,
      best: 90,
      pct: 90,
    }),
    stage({
      code: 'a2',
      title: 'Bravo stage',
      displayNum: '2',
      level: 1,
      position: 2,
      state: 'available',
    }),
    stage({
      code: 'a3',
      title: 'Charlie stage',
      displayNum: '3',
      level: 1,
      position: 3,
      state: 'locked',
    }),
    stage({
      code: 'b1',
      title: 'Delta stage',
      displayNum: '4',
      level: 2,
      position: 4,
      state: 'locked',
    }),
  ],
};

const DEPT_TRACK = {
  track: 'ADMIN',
  waitingForTrack: false,
  stages: [
    stage({
      code: 'c1',
      title: 'Core stage',
      displayNum: '1',
      level: 1,
      position: 1,
      state: 'done',
      attempts: 1,
      best: 85,
    }),
    stage({
      code: 'dA1',
      title: 'Department module one',
      displayNum: 'A1',
      level: null,
      dept: 'ADMIN',
      position: 2,
      state: 'available',
    }),
  ],
};

/** The dashboard's own region, so rail entries never answer a query. */
function main() {
  return within(screen.getByRole('main'));
}

function cardFor(code) {
  const card = document.querySelector(`[data-stage="${code}"]`);
  expect(card).not.toBeNull();
  return card;
}

describe('Dashboard', () => {
  it('groups the stages by level and shows each state from /api/track', async () => {
    mockFetch({ 'GET /api/me': [200, { me: STAFF }], 'GET /api/track': [200, AGENT_TRACK] });
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
    expect(main().getByRole('heading', { name: /Level 1/ })).toBeInTheDocument();
    expect(main().getByRole('heading', { name: /Level 2/ })).toBeInTheDocument();

    const level1 = document.querySelector('[data-level="1"]');
    expect(
      within(level1)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Alpha stage', 'Bravo stage', 'Charlie stage']);
    expect(cardFor('a1').getAttribute('data-state')).toBe('done');
    expect(cardFor('a2').getAttribute('data-state')).toBe('available');
    expect(cardFor('a3').getAttribute('data-state')).toBe('locked');

    // Best score and attempts come straight off the payload.
    expect(within(cardFor('a1')).getByText(/best 90%/)).toBeInTheDocument();
    expect(within(cardFor('a1')).getByText(/2 attempts/)).toBeInTheDocument();
    expect(within(cardFor('a1')).getByRole('link', { name: 'Review stage' })).toHaveAttribute(
      'href',
      '/stage/a1',
    );
  });

  it('puts the pulse on the first available stage and on no other card', async () => {
    mockFetch({ 'GET /api/me': [200, { me: STAFF }], 'GET /api/track': [200, AGENT_TRACK] });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });

    const pulsingCards = [...document.querySelectorAll('[data-stage]')].filter(
      (card) => card.querySelector('[data-pulse="next-up"]') !== null,
    );
    expect(pulsingCards.map((c) => c.getAttribute('data-stage'))).toEqual(['a2']);

    const cta = within(cardFor('a2')).getByRole('link', { name: /Begin the next module/ });
    expect(cta).toHaveAttribute('href', '/stage/a2');
    // Glow only: the pulse animates box-shadow, never a transform.
    expect(cta.className).toContain('animate-pulse-glow');
    expect(cta.className).not.toMatch(/\btranslate|\bscale-/);
  });

  it('locked cards say only the generic line and never name another stage', async () => {
    mockFetch({ 'GET /api/me': [200, { me: STAFF }], 'GET /api/track': [200, AGENT_TRACK] });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });

    const locked = cardFor('a3');
    const cta = within(locked).getByRole('button', {
      name: 'Complete the previous stage to unlock',
    });
    expect(cta).toBeDisabled();
    // The card knows nothing about what comes after it.
    expect(locked.textContent).not.toContain('Delta stage');
    expect(locked.textContent).not.toContain('Bravo stage');
    expect(within(locked).queryByRole('link')).toBeNull();
  });

  it('renders the department section for a department track', async () => {
    mockFetch({
      'GET /api/me': [200, { me: { ...STAFF, track: 'ADMIN' } }],
      'GET /api/track': [200, DEPT_TRACK],
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });

    const dept = document.querySelector('[data-section="dept"]');
    expect(dept).not.toBeNull();
    expect(
      within(dept).getByRole('heading', { name: 'Your Department Training' }),
    ).toBeInTheDocument();
    expect(within(dept).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Department module one',
    );
    expect(within(dept).getByText('Module A1')).toBeInTheDocument();
    expect(cardFor('dA1').getAttribute('data-state')).toBe('available');
  });

  it('shows the waiting-for-track screen when the API says there is no track', async () => {
    mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, { track: null, waitingForTrack: true, stages: [] }],
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: "You're signed in." })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome back/)).not.toBeInTheDocument();
  });
});
