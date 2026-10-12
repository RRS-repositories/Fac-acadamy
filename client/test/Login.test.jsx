import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGER, STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

// After sign-in the trainee lands on the dashboard, which reads /api/track
// (S05). One invented stage is enough for these sign-in checks.
const TRACK = {
  'GET /api/track': [
    200,
    {
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
    },
  ],
};

// The management area (S07) once a manager lands on it. Its own screen tests
// live in Manager.test.jsx, so an empty roster is enough here.
const MANAGER_AREA = {
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

async function openLogin(path = '/login') {
  const rendered = renderApp(path);
  await screen.findByRole('heading', { name: 'Sign in to start training' });
  return rendered;
}

function tab(name) {
  return screen.getByRole('tab', { name });
}

function signIn(email = 'trainee.a@example.com', password = 'any-password') {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Login', () => {
  it('shows the brand panel, no passcode field and no mock picker', async () => {
    mockFetch();
    await openLogin();
    expect(screen.getByRole('heading', { name: /started at stage/i })).toBeInTheDocument();
    expect(screen.queryByText(/passcode/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/passcode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();

    // The card's only password field is the account password.
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs).toHaveLength(1);
    expect(passwordInputs[0]).toBe(screen.getByLabelText('Password'));

    // Choosing Manager must never turn into a second secret to type.
    fireEvent.click(tab('Manager'));
    expect(screen.queryByText(/passcode/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it('shows the prototype tabs, staff first, and swaps the heading and subtitle', async () => {
    mockFetch();
    await openLogin();

    const staffTab = tab(/staff member/i);
    const managerTab = tab('Manager');
    expect(staffTab).toHaveTextContent(/👤\s*Staff member/);
    expect(managerTab).toHaveTextContent(/🛡\s*Manager/);
    expect(staffTab).toHaveAttribute('aria-selected', 'true');
    expect(managerTab).toHaveAttribute('aria-selected', 'false');
    expect(
      screen.getByText(
        'Use your CRM email and password. IT sets your account up before your first day.',
      ),
    ).toBeInTheDocument();

    // What has already been typed survives the switch.
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'manager.b@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'half-typed' } });

    fireEvent.click(managerTab);
    expect(screen.getByRole('heading', { name: 'Manager sign in' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Management access: live trainee view, scores, authorisation and account control.',
      ),
    ).toBeInTheDocument();
    expect(tab('Manager')).toHaveAttribute('aria-selected', 'true');
    expect(tab(/staff member/i)).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText('Work email')).toHaveValue('manager.b@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('half-typed');

    fireEvent.click(tab(/staff member/i));
    expect(screen.getByRole('heading', { name: 'Sign in to start training' })).toBeInTheDocument();
  });

  it('remembers the tab on this device and defaults to staff', async () => {
    mockFetch();
    const first = await openLogin();
    expect(tab(/staff member/i)).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('Manager'));
    first.unmount();

    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'Manager sign in' })).toBeInTheDocument();
    expect(tab('Manager')).toHaveAttribute('aria-selected', 'true');
  });

  it('asks for email and password before calling sign-in', async () => {
    const fetchMock = mockFetch();
    await openLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your work email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/login')).toHaveLength(0);
  });

  it('signs in in one step: email + password, then straight to the home page', async () => {
    const fetchMock = mockFetch({
      ...TRACK,
      'POST /api/auth/login': [200, { me: STAFF }],
    });
    await openLogin();
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Customer Service')).toBeInTheDocument();

    const [[, loginInit]] = callsTo(fetchMock, 'POST', '/api/auth/login');
    expect(loginInit.credentials).toBe('same-origin');
    expect(JSON.parse(loginInit.body)).toEqual({
      email: 'trainee.a@example.com',
      password: 'any-password',
    });

    // Sign-in is one call. Nothing else under /api/auth is asked for (the
    // keep-alive heartbeat is on a timer, not part of signing in).
    const authCalls = fetchMock.mock.calls.filter(
      ([path]) => String(path).startsWith('/api/auth/') && path !== '/api/auth/heartbeat',
    );
    expect(authCalls.map(([path]) => String(path))).toEqual(['/api/auth/login']);
  });

  it('never asks for an authenticator app, a QR code or a code', async () => {
    mockFetch({ ...TRACK, 'POST /api/auth/login': [200, { me: STAFF }] });
    await openLogin();
    const noSecondStep = () => {
      expect(screen.queryByText(/authenticator/i)).toBeNull();
      expect(screen.queryByText(/qr code/i)).toBeNull();
      expect(screen.queryByText(/6-digit/i)).toBeNull();
      expect(screen.queryByLabelText(/code/i)).toBeNull();
      expect(screen.queryByRole('img', { name: /qr/i })).toBeNull();
    };
    noSecondStep();
    fireEvent.click(tab('Manager'));
    noSecondStep();
    fireEvent.click(tab(/staff member/i));
    signIn();
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });
    noSecondStep();
  });

  it('after sign-in goes to the page in ?next=', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { me: MANAGER }],
      ...MANAGER_AREA,
    });
    await openLogin('/login?next=%2Fmanager');
    signIn('manager.b@example.com');
    expect(await screen.findByRole('heading', { name: 'Trainee roster' })).toBeInTheDocument();
  });

  it('manager tab + a manager account lands on the roster', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { me: MANAGER }],
      ...MANAGER_AREA,
    });
    await openLogin();
    fireEvent.click(tab('Manager'));
    signIn('manager.b@example.com');
    expect(await screen.findByRole('heading', { name: 'Trainee roster' })).toBeInTheDocument();
  });

  // The account decides where you land, not the tab. A manager who picked the
  // Staff tab still gets the roster: the dashboard is what they open the
  // academy for, and their own training is a sidebar link away.
  it('staff tab + a manager account STILL lands on the roster', async () => {
    mockFetch({
      ...TRACK,
      'POST /api/auth/login': [200, { me: MANAGER }],
    });
    await openLogin();
    signIn('manager.b@example.com');
    expect(await screen.findByRole('heading', { name: /trainee roster/i })).toBeInTheDocument();
    // And no calm line: this account does have management access.
    expect(screen.queryByText(/doesn't have management access/i)).not.toBeInTheDocument();
  });

  it('manager tab + a staff account lands on training with one calm line and no manager UI', async () => {
    const fetchMock = mockFetch({
      ...TRACK,
      'POST /api/auth/login': [200, { me: STAFF }],
    });
    await openLogin();
    fireEvent.click(tab('Manager'));
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();

    // The tab changes nothing about the request itself.
    const [[, loginInit]] = callsTo(fetchMock, 'POST', '/api/auth/login');
    expect(JSON.parse(loginInit.body)).toEqual({
      email: 'trainee.a@example.com',
      password: 'any-password',
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      "You're signed in. This account doesn't have management access, so here is your training.",
    );
    expect(screen.queryByRole('link', { name: 'Management' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trainee roster' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/manager'))).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('an explicit ?next= beats the manager tab', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { me: MANAGER }],
      ...MANAGER_AREA,
    });
    await openLogin('/login?next=%2Fstatus-guide');
    fireEvent.click(tab('Manager'));
    signIn('manager.b@example.com');
    expect(await screen.findByRole('heading', { name: /status guide/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trainee roster' })).not.toBeInTheDocument();
  });

  it('ignores a ?next= that points off-site', async () => {
    mockFetch({
      ...TRACK,
      'POST /api/auth/login': [200, { me: STAFF }],
    });
    await openLogin('/login?next=%2F%2Fevil.example.com');
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
  });

  it.each([
    [401, { error: 'invalid_credentials' }, "don't match a CRM account"],
    [423, { error: 'locked' }, 'Too many failed attempts'],
    [403, { error: 'disabled' }, 'has been disabled'],
    [403, { error: 'not_approved' }, "Your CRM account isn't approved yet. Ask IT."],
    [429, { error: 'rate_limited' }, 'Too many attempts from this device. Wait a minute'],
    [503, { error: 'auth_unavailable' }, 'Sign-in is temporarily unavailable.'],
    [503, { flag: 'off' }, "The training portal isn't open yet."],
    [500, undefined, 'Something went wrong. Please try again.'],
  ])(
    'sign-in %i %j shows the right message and clears the password',
    async (status, body, message) => {
      mockFetch({ 'POST /api/auth/login': [status, body] });
      await openLogin();
      signIn();
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByLabelText('Password')).toHaveValue('');
      expect(screen.getByLabelText('Work email')).toHaveValue('trainee.a@example.com');
    },
  );

  it('redirects to / when already signed in', async () => {
    mockFetch({ ...TRACK, 'GET /api/me': [200, { me: STAFF }] });
    renderApp('/login');
    expect(
      await screen.findByRole('heading', { name: 'Welcome back, Trainee' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Sign in to start training' })).toBeNull(),
    );
  });
});
