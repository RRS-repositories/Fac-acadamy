import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { MANAGER, STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

// The dashboard at "/" reads /api/track (S05). One invented stage is enough
// for the routing and auth checks in this file.
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
      state: 'available',
      pct: 0,
      attempts: 0,
      best: null,
      passMark: 80,
      lessonCount: 1,
      recordingCount: 0,
      recordingsWithMedia: 0,
    },
  ],
};

// Enough of the manager API (S07) for the routing checks: the roster screen
// itself is covered in Manager.test.jsx.
const MANAGER_ROUTES = {
  'GET /api/manager/roster?includeDisabled=true': [
    200,
    {
      trainees: [],
      counts: { total: 0, active: 0, disabled: 0, onlineNow: 0, waitingForTrack: 0 },
    },
  ],
  'GET /api/manager/stuck': [200, { trainees: [] }],
  'GET /api/manager/config': [
    200,
    { stage1AuthRequired: true, academyV2: true, provisioning: false },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App routing and auth guards', () => {
  it('home shows the first name, the track label and a sign-out button', async () => {
    const fetchMock = mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, TRACK],
    });
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    const [[, init]] = callsTo(fetchMock, 'GET', '/api/me');
    expect(init.credentials).toBe('same-origin');
  });

  it('RequireAuth sends a signed-out visitor to /login and back after sign-in', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [200, { me: MANAGER }],
      ...MANAGER_ROUTES,
    });
    renderApp('/manager');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to start training' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trainee roster' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'manager.b@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Trainee roster' })).toBeInTheDocument();
  });

  it('RequireManager blocks STAFF with a plain message and no manager content', async () => {
    mockFetch({ 'GET /api/me': [200, { me: STAFF }], ...MANAGER_ROUTES });
    renderApp('/manager');
    expect(
      await screen.findByRole('heading', { name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trainee roster' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('RequireManager lets a MANAGER in', async () => {
    mockFetch({ 'GET /api/me': [200, { me: MANAGER }], ...MANAGER_ROUTES });
    renderApp('/manager');
    expect(await screen.findByRole('heading', { name: 'Trainee roster' })).toBeInTheDocument();
  });

  it('no track yet: shows the waiting screen, then the home page once a track is set', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let me = { ...STAFF, track: null };
    const fetchMock = mockFetch({
      'GET /api/me': () => [200, { me }],
      'GET /api/track': [200, TRACK],
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: "You're signed in." })).toBeInTheDocument();
    expect(
      screen.getByText(/Your manager will assign your training programme shortly/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument();

    me = { ...STAFF, track: 'SALES' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'GET', '/api/me').length).toBeGreaterThanOrEqual(2);
  });

  it('sign out calls the logout endpoint and returns to the sign-in page', async () => {
    const fetchMock = mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, TRACK],
      'POST /api/auth/logout': [204],
    });
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to start training' }),
    ).toBeInTheDocument();
    const calls = callsTo(fetchMock, 'POST', '/api/auth/logout');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].credentials).toBe('same-origin');
  });

  it('sends a heartbeat every 60 s while signed in and the tab is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, TRACK],
      'POST /api/auth/heartbeat': [204],
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });
    expect(callsTo(fetchMock, 'POST', '/api/auth/heartbeat')).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsTo(fetchMock, 'POST', '/api/auth/heartbeat')).toHaveLength(1);
  });

  it('shows "not open yet" while the ACADEMY_V2 flag is off', async () => {
    mockFetch({ 'GET /api/me': [503, { flag: 'off' }] });
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: "The training portal isn't open yet." }),
    ).toBeInTheDocument();
  });

  it('shows the not-found page for an unknown route', async () => {
    mockFetch();
    renderApp('/no-such-page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
