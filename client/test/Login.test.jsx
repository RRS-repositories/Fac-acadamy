import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Login from '../src/pages/auth/Login.jsx';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Login />
    </MemoryRouter>,
  );
}

function pickScenario(label) {
  fireEvent.change(screen.getByLabelText(/mock preview/i), {
    target: { value: label },
  });
}

function signIn(email = 'trainee.a@example.com', password = 'any-password') {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('Login (mock)', () => {
  it('shows the brand panel and no staff/manager tabs or passcode', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: /started at stage/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to start training' })).toBeInTheDocument();
    expect(screen.queryByText(/passcode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /manager/i })).not.toBeInTheDocument();
  });

  it('asks for email and password before calling sign-in', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your work email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });

  it('returning user: password, then code, then signed in', async () => {
    renderLogin();
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: "You're signed in" })).toBeInTheDocument();
  });

  it('rejects a wrong code and stays on the code step', async () => {
    renderLogin();
    signIn();
    await screen.findByRole('heading', { name: 'Enter your authenticator code' });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work");
    expect(
      screen.getByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument();
  });

  it('first sign-in shows authenticator set-up with a manual key', async () => {
    renderLogin();
    pickScenario('first-login');
    signIn();
    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /qr code/i })).toBeInTheDocument();
    expect(screen.getByText(/can't scan it/i)).toBeInTheDocument();
  });

  it.each([
    ['bad-password', "don't match a CRM account"],
    ['locked', 'Too many failed attempts'],
    ['disabled', 'has been disabled'],
  ])('%s shows the right message and clears the password', async (scenario, message) => {
    renderLogin();
    pickScenario(scenario);
    signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
