import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

// The oracle for "what does this track see": ops/fixtures/expected-track-visibility.json,
// typed by hand from PROJECT-PLAN §1 in S02. It is deliberately NOT derived
// from the database or from the prototype parser, so a wrong track_visibility
// table cannot agree with itself.

const FIXTURE = path.join(REPO_ROOT, 'ops', 'fixtures', 'expected-track-visibility.json');

export const TRACKS = ['FULL', 'CS', 'SALES', 'ADMIN', 'FOS', 'MGMT', 'PAY', 'IT', 'DEBT'] as const;

export type Track = (typeof TRACKS)[number];

const loaded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

export function expectedStages(track: Track): string[] {
  const stages = loaded[track];
  if (!Array.isArray(stages) || stages.some((s) => typeof s !== 'string')) {
    throw new Error(`e2e: ${FIXTURE} has no stage list for ${track}.`);
  }
  return stages as string[];
}

/** A stage code that exists but is NOT on this track. */
export function foreignStage(track: Track): string {
  const mine = new Set(expectedStages(track));
  for (const other of TRACKS) {
    const found = expectedStages(other).find((code) => !mine.has(code));
    if (found !== undefined) return found;
  }
  throw new Error(`e2e: every stage is visible to ${track}, so there is no foreign stage.`);
}
