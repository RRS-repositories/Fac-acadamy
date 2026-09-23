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

export interface PreparedState {
  accounts: PreparedAccount[];
  staff: string[];
  manager: string;
  fixture: {
    recordingId: number;
    stageCode: string;
    durationSecs: number;
    mediaKey: string;
    byteSize: number;
  };
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

export function accountFor(email: string): PreparedAccount {
  const found = prepared().accounts.find((a) => a.email === email);
  if (found === undefined) throw new Error(`e2e: ${email} was not prepared.`);
  return found;
}
