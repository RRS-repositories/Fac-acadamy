import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.js';

// The API allows FIVE sign-in attempts a minute from one IP address
// (server/src/modules/auth/limits.ts, DEFAULT_LOGIN_LIMITS.perIpPerMinute), and
// every worker in this suite signs in from 127.0.0.1. Without a gate, four
// workers starting together would spend their attempts in a second and the
// fifth sign-in would be a 429 that has nothing to do with the thing under
// test.
//
// So sign-ins are metered across the whole run: at most four attempts in any
// rolling minute (one under the limit, leaving a spare for a retry), shared
// between processes through one small file under e2e/.state. The lock is a
// directory, because mkdir is atomic on every platform this runs on.

const LOCK_DIR = path.join(STATE_DIR, 'signin.lock');
const LOG_FILE = path.join(STATE_DIR, 'signin-attempts.json');
const WINDOW_MS = 60_000;
/** One below the server's five, so a retry never tips the run over. */
export const ATTEMPTS_PER_WINDOW = 4;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function withLock<T>(fn: () => T): T | null {
  try {
    mkdirSync(LOCK_DIR, { recursive: false });
  } catch {
    return null; // somebody else holds it; the caller retries
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function readLog(): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Clears the meter. Called once by the global setup. */
export function resetSignInMeter(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(LOCK_DIR, { recursive: true, force: true });
  writeFileSync(LOG_FILE, '[]', 'utf8');
}

/**
 * Waits until a sign-in attempt is allowed, then books it. Returns once the
 * caller may POST /api/auth/login.
 */
export async function claimSignInSlot(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  for (;;) {
    const waitMs = withLock(() => {
      const now = Date.now();
      const recent = readLog().filter((t) => now - t < WINDOW_MS);
      if (recent.length < ATTEMPTS_PER_WINDOW) {
        recent.push(now);
        writeFileSync(LOG_FILE, JSON.stringify(recent), 'utf8');
        return 0;
      }
      const oldest = Math.min(...recent);
      return WINDOW_MS - (now - oldest) + 250;
    });
    if (waitMs === 0) return;
    await sleep(waitMs === null ? 100 : waitMs);
  }
}
