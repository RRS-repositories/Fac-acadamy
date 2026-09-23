import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.js';

// Where the TOTP secret each account enrolled this run is kept.
//
// The secret is handed out once, on the enrolment screen of the first sign-in
// after the global setup cleared the authenticator. A worker that signs in
// later — a new worker after a failed test, or the second spec file to use the
// account — sees the challenge screen instead and needs that secret, so it goes
// in a file rather than in one worker's memory.
//
// It is a throw-away secret for an invented account on a local database, it
// lives under the gitignored e2e/.state, and the global setup deletes the file
// and resets every authenticator at the start of each run.

const FILE = path.join(STATE_DIR, 'secrets.json');

type Secrets = Record<string, string>;

function read(): Secrets {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Secrets;
  } catch {
    return {};
  }
}

export function resetSecrets(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(FILE, { force: true });
}

export function rememberedSecret(email: string): string | undefined {
  return read()[email];
}

export function rememberSecret(email: string, secret: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ ...read(), [email]: secret }), 'utf8');
}
