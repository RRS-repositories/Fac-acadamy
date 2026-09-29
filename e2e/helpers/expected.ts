import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

// The oracle for "what does this track see": ops/fixtures/expected-track-visibility.json,
// typed by hand from PROJECT-PLAN §1 in S02. It is deliberately NOT derived
// from the database or from the prototype parser, so a wrong track_visibility
// table cannot agree with itself.
//
// The fixture has two halves, and this suite needs both.
//
//   * the nine track arrays — PROTOTYPE content only, and they have to stay
//     that way: ops/seed/seed-content.ts and ops/seed/verify-seed.ts compare
//     the prototype's own rows against them, so a stage from another source
//     put in there would roll back every prototype seed;
//   * `packStages` — what a content pack adds to a track, each entry naming
//     the stage it follows.
//
// A browser walks the database, which holds both, so `expectedStages()`
// composes the two: the prototype's order, with each pack stage inserted after
// its anchor. Both halves are hand-typed, so the composed list is still an
// expectation and not a reading of the table under test.

const FIXTURE = path.join(REPO_ROOT, 'ops', 'fixtures', 'expected-track-visibility.json');

export const TRACKS = ['FULL', 'CS', 'SALES', 'ADMIN', 'FOS', 'MGMT', 'PAY', 'IT', 'DEBT'] as const;

export type Track = (typeof TRACKS)[number];

interface PackStage {
  code: string;
  after: string;
}

const loaded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

/** The prototype's own stages for a track, in unlock order. */
export function prototypeStages(track: Track): string[] {
  const stages = loaded[track];
  if (!Array.isArray(stages) || stages.some((s) => typeof s !== 'string')) {
    throw new Error(`e2e: ${FIXTURE} has no stage list for ${track}.`);
  }
  // A copy: the parsed fixture is cached for the process, and expectedStages()
  // splices pack stages into what it gets back.
  return [...(stages as string[])];
}

function packStages(track: Track): PackStage[] {
  const all = loaded['packStages'];
  if (all === undefined || all === null) return [];
  const mine = (all as Record<string, unknown>)[track];
  if (mine === undefined) return [];
  if (!Array.isArray(mine)) {
    throw new Error(`e2e: ${FIXTURE} packStages.${track} is not a list.`);
  }
  return mine as PackStage[];
}

/**
 * Every stage the track really shows, in unlock order: the prototype's stages
 * with each content-pack stage inserted after the one it follows.
 */
export function expectedStages(track: Track): string[] {
  const out = prototypeStages(track);
  for (const { code, after } of packStages(track)) {
    const at = out.indexOf(after);
    if (at < 0) {
      throw new Error(
        `e2e: ${FIXTURE} puts ${code} after ${after} on ${track}, but ${after} is not on that track.`,
      );
    }
    out.splice(at + 1, 0, code);
  }
  return out;
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
