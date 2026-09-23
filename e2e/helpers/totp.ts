import { authenticator } from 'otplib';

// Real TOTP codes, generated the way a phone would. The server's parameters are
// in server/src/modules/auth/totp.ts: SHA-1, 6 digits, a 30-second step and a
// one-step window either side.
//
// The server also stores the step it last accepted and refuses anything at or
// before it (replay protection), so the SAME account cannot sign in twice with
// the same code — and, because the window reaches only one step ahead, no more
// than twice inside one 30-second step. `nextCode` therefore remembers the last
// step it handed out per secret and waits for the clock when it has to.

const STEP_SECONDS = 30;
const STEP_MS = STEP_SECONDS * 1000;

const base = authenticator.clone({ step: STEP_SECONDS, digits: 6 });

export function stepAt(ms: number = Date.now()): number {
  return Math.floor(ms / STEP_MS);
}

export function codeForStep(secret: string, step: number): string {
  return base.clone({ epoch: step * STEP_MS }).generate(secret);
}

/** A secret as the enrolment screen prints it: base32 in four-character groups. */
export function normaliseSecret(printed: string): string {
  return printed.replace(/\s+/g, '').toUpperCase();
}

const lastStep = new Map<string, number>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * A code the server will accept for this secret right now, waiting for the
 * clock if the previous code used up the window.
 */
export async function nextCode(secret: string): Promise<string> {
  const key = normaliseSecret(secret);
  for (;;) {
    const now = stepAt();
    const previous = lastStep.get(key);
    const wanted = previous === undefined ? now : Math.max(now, previous + 1);
    // The server accepts current-1 .. current+1 only.
    if (wanted <= now + 1) {
      lastStep.set(key, wanted);
      return codeForStep(key, wanted);
    }
    // Wait until the clock reaches the step before the one we need.
    await sleep((wanted - 1) * STEP_MS - Date.now() + 250);
  }
}

/** Forget a secret's step memory (after the account's authenticator is reset). */
export function forgetSecret(secret: string): void {
  lastStep.delete(normaliseSecret(secret));
}
