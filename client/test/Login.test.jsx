import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGER, QR_DATA_URL, STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

const ENROL_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function openLogin(path = '/login') {
  renderApp(path);
  await screen.findByRole('heading', { name: 'Sign in to start training' });
}

function signIn(email = 'trainee.a@example.com', password = 'any-password') {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

async function enterCode(button, code = '123456') {
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: button }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login', () => {
  it('shows the brand panel, no staff/manager tabs, no passcode, no mock picker', async () => {
    mockFetch();
    await openLogin();
    expect(screen.getByRole('heading', { name: /started at stage/i })).toBeInTheDocument();
    expect(screen.queryByText(/passcode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /manager/i })).not.toBeInTheDocument();
  });

  it('asks for email and password before calling sign-in', async () => {
    const fetchMock = mockFetch();
    await openLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your work email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/login')).toHaveLength(0);
  });

  it('returning user: password, then code, then lands on the home page', async () => {
    const fetchMock = mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [200, { me: STAFF }],
    });
    await openLogin();
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument();

    const [[, loginInit]] = callsTo(fetchMock, 'POST', '/api/auth/login');
    expect(loginInit.credentials).toBe('same-origin');
    expect(JSON.parse(loginInit.body)).toEqual({
      email: 'trainee.a@example.com',
      password: 'any-password',
    });

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Trainee' })).toBeInTheDocument();
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    const [[, mfaInit]] = callsTo(fetchMock, 'POST', '/api/auth/mfa');
    expect(mfaInit.credentials).toBe('same-origin');
    expect(JSON.parse(mfaInit.body)).toEqual({ code: '123456' });
  });

  it('after sign-in goes to the page in ?next=', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [200, { me: MANAGER }],
    });
    await openLogin('/login?next=%2Fmanager');
    signIn('manager.b@example.com');
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    await enterCode('Verify and sign in');
    expect(
      await screen.findByRole('heading', { name: 'Management area — coming in Section 07' }),
    ).toBeInTheDocument();
  });

  it('ignores a ?next= that points off-site', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [200, { me: STAFF }],
    });
    await openLogin('/login?next=%2F%2Fevil.example.com');
    signIn();
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    await enterCode('Verify and sign in');
    expect(await screen.findByRole('heading', { name: 'Welcome, Trainee' })).toBeInTheDocument();
  });

  it('first sign-in shows the real QR image, the grouped key and the 3 steps', async () => {
    mockFetch({
      'POST /api/auth/login': [
        200,
        {
          next: 'enrol',
          enrol: {
            qrDataUrl: QR_DATA_URL,
            secret: ENROL_SECRET,
            issuer: 'FAC Academy',
            account: 'trainee.a@example.com',
          },
        },
      ],
      'POST /api/auth/mfa': [200, { me: STAFF }],
    });
    await openLogin();
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator' }),
    ).toBeInTheDocument();

    const qr = screen.getByRole('img', { name: /qr code/i });
    expect(qr.tagName).toBe('IMG');
    expect(qr).toHaveAttribute('src', QR_DATA_URL);
    expect(screen.getByText(/can't scan it/i)).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(screen.getByText(/install an authenticator app/i)).toBeInTheDocument();
    expect(screen.getByText('Scan this QR code with the app.')).toBeInTheDocument();
    expect(screen.getByText('Enter the 6-digit code the app shows.')).toBeInTheDocument();

    await enterCode('Turn on and sign in');
    expect(await screen.findByRole('heading', { name: 'Welcome, Trainee' })).toBeInTheDocument();
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

  it('a wrong code shows its message and stays on the code step', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [401, { error: 'invalid_code' }],
    });
    await openLogin();
    signIn();
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    await enterCode('Verify and sign in', '000000');
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work");
    expect(
      screen.getByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveValue('');
  });

  it('mfa_required sends the user back to the first step', async () => {
    mockFetch({
      'POST /api/auth/login': [200, { next: 'challenge' }],
      'POST /api/auth/mfa': [401, { error: 'mfa_required' }],
    });
    await openLogin();
    signIn();
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    await enterCode('Verify and sign in');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to start training' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your sign-in took too long. Please start again.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('redirects to / when already signed in', async () => {
    mockFetch({ 'GET /api/me': [200, { me: STAFF }] });
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'Welcome, Trainee' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Sign in to start training' })).toBeNull(),
    );
  });
});
