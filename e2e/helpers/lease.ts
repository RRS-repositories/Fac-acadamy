import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.js';

// Only five accounts can sign in locally (the mock CRM's invented users), so
// two workers must never drive the same one: they would fight over its track,
// its progress and — because the server refuses a TOTP step twice — over its
// sign-in itself.
//
// Each worker therefore LEASES an account for its whole life. The lease is a
// directory under e2e/.state/leases: mkdir either creates it or fails, which
// is the atomic claim. The global setup wipes the folder, so a crashed run
// never leaves an account locked out of the next one.

const LEASE_DIR = path.join(STATE_DIR, 'leases');

export function resetLeases(): void {
  rmSync(LEASE_DIR, { recursive: true, force: true });
  mkdirSync(LEASE_DIR, { recursive: true });
}

function tryClaim(pool: readonly string[]): string | null {
  mkdirSync(LEASE_DIR, { recursive: true });
  for (const name of pool) {
    try {
      mkdirSync(path.join(LEASE_DIR, encodeURIComponent(name)), { recursive: false });
      return name;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Claims the first free name in `pool`, waiting for one if they are all out.
 * Waiting rather than failing is what lets two specs share the single manager
 * account without the run depending on which worker picked which file.
 */
export async function claim(
  pool: readonly string[],
  who: string,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const name = tryClaim(pool);
    if (name !== null) return name;
    if (Date.now() >= deadline) {
      throw new Error(
        `e2e: no free account for ${who} after ${String(Math.round(timeoutMs / 1000))}s. ` +
          `There are ${String(pool.length)} sign-in accounts in that pool.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function release(name: string): void {
  rmSync(path.join(LEASE_DIR, encodeURIComponent(name)), { recursive: true, force: true });
}
