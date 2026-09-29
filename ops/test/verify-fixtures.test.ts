// Shape checks for the two S02 fixtures. Neither fixture may hold training content:
// expected-track-visibility.json holds stage ids and counts only, leak-canaries.json holds
// hashes only.
//
// WHY THE NINE TRACK LISTS STILL SAY "SIX STAGES, TWO MODULES" FOR A DEPARTMENT
// ----------------------------------------------------------------------------
// The fixture is the independent oracle for the prototype parser: it is typed by
// hand from PROJECT-PLAN §1 so that a wrong ops/seed/prototype.ts cannot agree
// with itself. ops/seed/seed-content.ts and ops/seed/verify-seed.ts both read a
// track's stages FILTERED TO THE PROTOTYPE'S OWN CODES and compare that list
// against the array here. Adding a stage from another source to one of those
// arrays would therefore make the comparison fail and roll back every future
// prototype seed — and, worse, it would let the oracle drift towards whatever
// happens to be in the database, which is the one thing it exists not to do.
//
// So the nine arrays stay prototype-only, and the assertions on them below are
// unchanged. Content packs declare their stages separately, in `packStages`,
// and the suite at the bottom asserts those on their own terms: shape, anchors
// that resolve, no collision with a prototype code, and the composed order.
// e2e/helpers/expected.ts does the composing, because the browser suite runs
// against a database that has both sources in it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

const TRACKS = ['FULL', 'CS', 'SALES', 'ADMIN', 'FOS', 'MGMT', 'PAY', 'IT', 'DEBT'] as const;
type Track = (typeof TRACKS)[number];

const DEPT_MODULES: Record<Exclude<Track, 'FULL' | 'CS' | 'SALES'>, [string, string]> = {
  ADMIN: ['dA1', 'dA2'],
  FOS: ['dF1', 'dF2'],
  MGMT: ['dM1', 'dM2'],
  PAY: ['dP1', 'dP2'],
  IT: ['dIT1', 'dIT2'],
  DEBT: ['dD1', 'dD2'],
};

// PROJECT-PLAN.md §1, "Stages each track sees".
const PLAN_STAGES: Record<Track, number> = {
  FULL: 16,
  CS: 14,
  SALES: 14,
  ADMIN: 6,
  FOS: 6,
  MGMT: 6,
  PAY: 6,
  IT: 6,
  DEBT: 6,
};
const PLAN_QUESTIONS: Record<Track, number> = {
  FULL: 124,
  CS: 112,
  SALES: 106,
  ADMIN: 53,
  FOS: 44,
  MGMT: 40,
  PAY: 40,
  IT: 40,
  DEBT: 46,
};

describe('expected-track-visibility.json', () => {
  const fx = readJson('expected-track-visibility.json') as Record<string, unknown>;
  const list = (t: Track): string[] => fx[t] as string[];

  it('has exactly the 9 tracks, each a list of stage ids', () => {
    const trackKeys = Object.keys(fx).filter((k) => /^[A-Z]+$/.test(k));
    expect(trackKeys.sort()).toEqual([...TRACKS].sort());
    for (const t of TRACKS) {
      expect(Array.isArray(fx[t])).toBe(true);
      for (const id of list(t)) expect(id).toMatch(/^[A-Za-z0-9]{2,8}$/);
      expect(new Set(list(t)).size).toBe(list(t).length);
    }
  });

  it('starts every track with the shared core s1 s2 s3', () => {
    for (const t of TRACKS) expect(list(t).slice(0, 3)).toEqual(['s1', 's2', 's3']);
  });

  // The prototype's own department academies are two modules each. A pack that
  // adds a third does NOT change this: see the note at the top of the file.
  it('gives each department track the core plus exactly its own two PROTOTYPE modules, last', () => {
    for (const [t, mods] of Object.entries(DEPT_MODULES) as [Track, [string, string]][]) {
      expect(list(t)).toHaveLength(6);
      expect(list(t)).toEqual(['s1', 's2', 's3', 's6', ...mods]);
    }
  });

  it('keeps sales stages out of CS and CS stages out of Sales', () => {
    expect(list('CS')).not.toContain('s5');
    expect(list('CS')).not.toContain('s6calls');
    expect(list('SALES')).not.toContain('s4');
    expect(list('SALES')).not.toContain('cscalls');
    for (const t of ['FULL', 'CS', 'SALES'] as const) {
      expect(list(t).some((id) => id.startsWith('d'))).toBe(false);
    }
  });

  it('matches the per-track stage and question counts in PROJECT-PLAN §1', () => {
    const q = fx['questionsPerTrack'] as Record<Track, number>;
    for (const t of TRACKS) {
      expect(list(t)).toHaveLength(PLAN_STAGES[t]);
      expect(q[t]).toBe(PLAN_QUESTIONS[t]);
    }
  });

  it('carries the §1 content totals', () => {
    expect(fx['counts']).toEqual({
      stages: 28,
      lessons: 66,
      questions: 231,
      statusGuide: 34,
      recordings: 48,
      recordingsWithMedia: 7,
    });
    // 16 level stages + 12 department modules, all reachable from some track.
    const all = new Set(TRACKS.flatMap((t) => list(t)));
    expect(all.size).toBe(28);
  });
});

// The other half of the same file: stages a content pack adds to a track. These
// are NOT prototype content and must never be folded into the nine arrays
// above. They are still hand-typed — from the pack's own source document, not
// read back from a database — so composing a track's real list stays an
// independent expectation rather than a second opinion from the seeder.
interface PackStage {
  code: string;
  after: string;
  badge: string;
  questions: number;
}

describe('expected-track-visibility.json: packStages', () => {
  const fx = readJson('expected-track-visibility.json') as Record<string, unknown>;
  const protoList = (t: Track): string[] => fx[t] as string[];
  const pack = (fx['packStages'] ?? {}) as Record<string, PackStage[]>;

  it('is keyed by track, with a code, an anchor, a badge and a question count', () => {
    expect(fx['packStages']).toBeTypeOf('object');
    for (const [track, entries] of Object.entries(pack)) {
      expect(TRACKS, `packStages key ${track}`).toContain(track);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(['after', 'badge', 'code', 'questions']);
        expect(entry.code).toMatch(/^[A-Za-z0-9]{2,8}$/);
        expect(entry.after).toMatch(/^[A-Za-z0-9]{2,8}$/);
        expect(entry.badge).toMatch(/^[A-Z]\d{1,2}$/);
        expect(Number.isInteger(entry.questions)).toBe(true);
        expect(entry.questions).toBeGreaterThan(0);
      }
    }
  });

  it('never re-uses a prototype stage code, and never repeats one of its own', () => {
    const prototypeCodes = new Set(TRACKS.flatMap((t) => protoList(t)));
    const seen = new Set<string>();
    for (const entries of Object.values(pack)) {
      for (const entry of entries) {
        expect(prototypeCodes, `pack code ${entry.code}`).not.toContain(entry.code);
        expect(seen.has(entry.code), `pack code ${entry.code} declared twice`).toBe(false);
        seen.add(entry.code);
      }
    }
  });

  it('anchors every pack stage to a stage that is already on that track', () => {
    for (const [track, entries] of Object.entries(pack)) {
      const placed = new Set(protoList(track as Track));
      for (const entry of entries) {
        // In declaration order, so a pack stage may follow an earlier one.
        expect(placed, `${track}: ${entry.code} follows ${entry.after}`).toContain(entry.after);
        placed.add(entry.code);
      }
    }
  });

  it('places the Admin irresponsible-lending module between dA1 and dA2', () => {
    // PROJECT-PLAN §1: Admin reads A1 dA1 → A2 dA3 → A3 dA2. The code says 3
    // and the badge says 2 on purpose — the code is the identity progress rows
    // point at, the badge and the order live in display_num/position.
    expect(pack['ADMIN']).toEqual([{ code: 'dA3', after: 'dA1', badge: 'A2', questions: 10 }]);
    const admin = protoList('ADMIN');
    expect(admin.indexOf('dA2')).toBe(admin.indexOf('dA1') + 1);
  });

  it('adds up to the seven stages and 63 questions PROJECT-PLAN §1 gives Admin', () => {
    const entries = pack['ADMIN'] ?? [];
    const q = fx['questionsPerTrack'] as Record<Track, number>;
    expect(protoList('ADMIN').length + entries.length).toBe(7);
    expect(q['ADMIN'] + entries.reduce((n, e) => n + e.questions, 0)).toBe(63);
  });
});

describe('leak-canaries.json', () => {
  const canaries = readJson('leak-canaries.json') as unknown[];

  it('holds 3 to 5 canaries', () => {
    expect(Array.isArray(canaries)).toBe(true);
    expect(canaries.length).toBeGreaterThanOrEqual(3);
    expect(canaries.length).toBeLessThanOrEqual(5);
  });

  it('stores only { label, length, sha256 } per canary: no plain text', () => {
    for (const c of canaries) {
      expect(c).toBeTypeOf('object');
      const entry = c as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(['label', 'length', 'sha256']);
      expect(entry['label']).toMatch(/^[a-z]+(-[a-z]+)*-\d+$/);
      expect(Number.isInteger(entry['length'])).toBe(true);
      expect(entry['length'] as number).toBeGreaterThanOrEqual(25);
      expect(entry['sha256']).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('covers an answer, a lesson sentence and a status-guide line, with unique labels', () => {
    const labels = (canaries as { label: string }[]).map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((l) => l.startsWith('answer-'))).toBe(true);
    expect(labels.some((l) => l.startsWith('lesson-sentence-'))).toBe(true);
    expect(labels.some((l) => l.startsWith('status-line-'))).toBe(true);
    const lesson = (canaries as { label: string; length: number }[]).find((c) =>
      c.label.startsWith('lesson-sentence-'),
    );
    expect(lesson?.length ?? 0).toBeGreaterThanOrEqual(40);
  });
});
