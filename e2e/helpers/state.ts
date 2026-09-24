import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.js';

// What the global setup left behind: which accounts exist, which trainee id
// each one is, and the short fixture recording the listening journey uses.

export const PREPARED_FILE = path.join(STATE_DIR, 'prepared.json');

export interface PreparedAccount {
  email: string;
  fullName: string;
  crmUserId: number;
  role: 'STAFF' | 'MANAGER';
  track: string;
  traineeId: number;
}

export interface FixtureRecording {
  recordingId: number;
  stageCode: string;
  durationSecs: number;
  mediaKey: string;
  byteSize: number;
}

export interface PreparedState {
  accounts: PreparedAccount[];
  staff: string[];
  manager: string;
  /** False on a migrated-but-unseeded database (a CI runner). */
  seeded: boolean;
  /** Null when nothing is seeded: there is no stage to hang a recording on. */
  fixture: FixtureRecording | null;
}

let cached: PreparedState | null = null;

export function prepared(): PreparedState {
  if (cached !== null) return cached;
  let raw: string;
  try {
    raw = readFileSync(PREPARED_FILE, 'utf8');
  } catch {
    throw new Error(
      `e2e: ${PREPARED_FILE} is missing. The global setup writes it by running ` +
        'ops/dev/e2e-prepare.ts; run the suite with `npm run test:e2e`.',
    );
  }
  cached = JSON.parse(raw) as PreparedState;
  return cached;
}

/**
 * The fixture recording, or a clear failure. Only a spec that needs the seeded
 * content calls this, and such a spec is never selected on an unseeded
 * database — so reaching the throw means the selection is wrong, not the app.
 */
export function requireFixture(): FixtureRecording {
  const fixture = prepared().fixture;
  if (fixture === null) {
    throw new Error(
      'e2e: there is no fixture recording because this database has no training content. ' +
        'This test needs seeded content and should not have been selected here.',
    );
  }
  return fixture;
}

export function accountFor(email: string): PreparedAccount {
  const found = prepared().accounts.find((a) => a.email === email);
  if (found === undefined) throw new Error(`e2e: ${email} was not prepared.`);
  return found;
}
