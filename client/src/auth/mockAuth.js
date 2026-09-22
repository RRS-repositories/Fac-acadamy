// MOCK ONLY: stands in for the real sign-in API until Section 03.
// There are no real credentials here. The outcome of each step is chosen by
// the scenario switcher on the login page, so every state can be reviewed.
// S03 replaces these two functions with calls to POST /api/auth/login and
// POST /api/auth/mfa; the page itself should not need to change.

export const MOCK_SCENARIOS = [
  { id: 'returning', label: 'Returning user: asks for the 6-digit code' },
  { id: 'first-login', label: 'First sign-in: set up the authenticator' },
  { id: 'bad-password', label: 'Wrong email or password' },
  { id: 'locked', label: 'Locked after too many attempts' },
  { id: 'disabled', label: 'Account disabled by a manager' },
];

// The one code the mock always rejects, so the "wrong code" state can be seen.
export const MOCK_REJECTED_CODE = '000000';

const MOCK_DELAY_MS = 350;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A throwaway base32 key, new on every call. Real keys are generated and
// stored encrypted on the server (S03).
function randomBase32(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export async function mockSignIn({ email }, scenario) {
  await wait(MOCK_DELAY_MS);
  if (scenario === 'bad-password') return { ok: false, error: 'invalid_credentials' };
  if (scenario === 'locked') return { ok: false, error: 'locked' };
  if (scenario === 'disabled') return { ok: false, error: 'disabled' };
  if (scenario === 'first-login') {
    return {
      ok: true,
      next: 'enrol',
      enrol: { issuer: 'FAC Academy', account: email, secret: randomBase32(32) },
    };
  }
  return { ok: true, next: 'challenge' };
}

export async function mockVerifyCode(code) {
  await wait(MOCK_DELAY_MS);
  if (code === MOCK_REJECTED_CODE) return { ok: false, error: 'invalid_code' };
  return { ok: true };
}
