// The second content source: the path guard, the pack's own validation, and the
// arithmetic that slots a pack module into a department without disturbing what
// is already there.
//
// No pack content in this file. Everything below is invented shape.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveContentPackPath } from '../lib/content-pack-path.js';
import { ContentPackSchema, loadContentPack, packProblems } from '../seed/content-pack.js';
import type { ContentPack } from '../seed/content-pack.js';
import { badgeForPosition, positionAllocator } from '../seed/seed-content.js';
import { layoutGroup, orderMoves, renumberBadge } from '../seed/seed-pack-content.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTSIDE = mkdtempSync(path.join(tmpdir(), 'fac-pack-'));
afterAll(() => rmSync(OUTSIDE, { recursive: true, force: true }));

function pack(overrides: Partial<ContentPack['stages'][number]> = {}): ContentPack {
  return {
    packVersion: 1,
    packId: 'test-pack',
    summary: 'A pack used only by this test.',
    stages: [
      {
        code: 'dX9',
        dept: 'ADMIN',
        displayNum: 'A2',
        position: 2,
        sort: 99,
        title: 'Title',
        blurb: 'Blurb',
        passMark: 80,
        visibility: [{ track: 'ADMIN', position: 6 }],
        lessons: [{ title: 'Lesson one', bodyHtml: '<p>Body</p>' }],
        quiz: {
          passMark: 80,
          questions: [
            { prompt: 'Prompt?', options: ['a', 'b', 'c', 'd'], correctIndex: 1 },
            { prompt: 'Prompt 2?', options: ['a', 'b', 'c', 'd'], correctIndex: 0 },
          ],
        },
        ...overrides,
      },
    ],
  };
}

describe('resolveContentPackPath', () => {
  it('refuses to run without CONTENT_PACK_PATH', () => {
    expect(() => resolveContentPackPath({})).toThrow(/CONTENT_PACK_PATH is not set/);
  });

  it('refuses a path inside the repo, where a pack must never live', () => {
    const inside = path.join(REPO_ROOT, 'package.json');
    expect(() => resolveContentPackPath({ CONTENT_PACK_PATH: inside })).toThrow(
      /points inside the repo/,
    );
  });

  it('refuses a path that is not a file', () => {
    expect(() => resolveContentPackPath({ CONTENT_PACK_PATH: OUTSIDE })).toThrow(
      /does not point at a file/,
    );
  });

  it('accepts a file outside the repo and returns its real path', () => {
    const file = path.join(OUTSIDE, 'pack.json');
    writeFileSync(file, '{}', 'utf8');
    expect(resolveContentPackPath({ CONTENT_PACK_PATH: file })).toContain('pack.json');
  });
});

describe('the pack schema', () => {
  it('accepts a well-formed pack', () => {
    expect(ContentPackSchema.safeParse(pack()).success).toBe(true);
  });

  it('insists on four options per question', () => {
    const bad = pack();
    bad.stages[0]!.quiz.questions[0]!.options = ['a', 'b', 'c'];
    expect(ContentPackSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a stage code the schema would not accept', () => {
    expect(ContentPackSchema.safeParse(pack({ code: 'has space' })).success).toBe(false);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    const bad = { ...pack(), extra: true };
    expect(ContentPackSchema.safeParse(bad).success).toBe(false);
  });
});

describe('packProblems', () => {
  it('finds nothing wrong with a good pack', () => {
    expect(packProblems(pack())).toEqual([]);
  });

  it('catches a pass mark no score can reach', () => {
    const bad = pack();
    bad.stages[0]!.quiz.passMark = 99; // 2 questions: only 50 and 100 are reachable
    expect(packProblems(bad)).toEqual([]); // 100 >= 99, so this one is fine
    bad.stages[0]!.quiz.questions = [bad.stages[0]!.quiz.questions[0]!];
    bad.stages[0]!.quiz.passMark = 101 as unknown as number;
    expect(packProblems(bad)[0]).toMatch(/unreachable/);
  });

  it('catches a stage its own department cannot see', () => {
    const bad = pack({ visibility: [{ track: 'FOS', position: 6 }] });
    expect(packProblems(bad).join(' ')).toMatch(/not in the stage's visibility/);
  });

  it('catches a repeated option', () => {
    const bad = pack();
    bad.stages[0]!.quiz.questions[0]!.options = ['a', 'a', 'c', 'd'];
    expect(packProblems(bad).join(' ')).toMatch(/repeats an option/);
  });

  it('names the field but never the content', () => {
    const bad = pack();
    bad.stages[0]!.quiz.questions[0]!.options = ['secret answer', 'secret answer', 'c', 'd'];
    expect(packProblems(bad).join(' ')).not.toContain('secret answer');
  });
});

describe('loadContentPack', () => {
  it('reports the field, not the value, when a pack is malformed', () => {
    const file = path.join(OUTSIDE, 'broken.json');
    const broken = pack();
    (broken.stages[0] as { title?: string }).title = '';
    writeFileSync(file, JSON.stringify(broken), 'utf8');
    expect(() => loadContentPack(file)).toThrow(/stages\.0\.title/);
  });

  it('refuses something that is not JSON at all', () => {
    const file = path.join(OUTSIDE, 'notjson.json');
    writeFileSync(file, 'not json', 'utf8');
    expect(() => loadContentPack(file)).toThrow(/not readable JSON/);
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('renumberBadge', () => {
  it('moves the trailing number with the stage', () => {
    expect(renumberBadge('A2', 3)).toBe('A3');
    expect(renumberBadge('IT1', 2)).toBe('IT2');
    expect(renumberBadge('8', 9)).toBe('9');
  });

  it('is idempotent: a badge already at its position is unchanged', () => {
    expect(renumberBadge('A3', 3)).toBe('A3');
  });

  it('leaves a badge with no trailing number alone', () => {
    expect(renumberBadge('Final', 4)).toBe('Final');
  });
});

describe('layoutGroup', () => {
  const admin = [
    { code: 'dA1', position: 1, displayNum: 'A1' },
    { code: 'dA2', position: 2, displayNum: 'A2' },
  ];
  const insert = [{ code: 'dA3', position: 2, displayNum: 'A2' }];

  it('inserts in the middle and renumbers what follows', () => {
    expect(layoutGroup(admin, insert)).toEqual([
      { code: 'dA1', position: 1, displayNum: 'A1' },
      { code: 'dA3', position: 2, displayNum: 'A2' },
      { code: 'dA2', position: 3, displayNum: 'A3' },
    ]);
  });

  it('is stable when run again over its own output', () => {
    const after = [
      { code: 'dA1', position: 1, displayNum: 'A1' },
      { code: 'dA2', position: 3, displayNum: 'A3' },
    ];
    expect(layoutGroup(after, insert)).toEqual(layoutGroup(admin, insert));
  });

  it('appends when the wanted position is past the end', () => {
    const out = layoutGroup(admin, [{ code: 'dA3', position: 99, displayNum: 'A9' }]);
    expect(out.map((s) => s.code)).toEqual(['dA1', 'dA2', 'dA3']);
    expect(out[2]).toEqual({ code: 'dA3', position: 3, displayNum: 'A3' });
  });

  it('leaves a group with no inserts exactly as it found it', () => {
    expect(layoutGroup(admin, [])).toEqual(admin);
  });
});

describe('orderMoves', () => {
  it('moves the last stage down first, so no two share a position', () => {
    const current = new Map([
      ['dA1', 1],
      ['dA2', 2],
    ]);
    const target = new Map([
      ['dA1', 1],
      ['dA2', 3],
    ]);
    expect(orderMoves(current, target)).toEqual(['dA2']);
  });

  it('orders a two-step shift from the bottom up', () => {
    const current = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const target = new Map([
      ['a', 1],
      ['b', 3],
      ['c', 4],
    ]);
    expect(orderMoves(current, target)).toEqual(['c', 'b']);
  });

  it('refuses a swap rather than violating the unique index halfway through', () => {
    const current = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const target = new Map([
      ['a', 2],
      ['b', 1],
    ]);
    expect(() => orderMoves(current, target)).toThrow(/sharing a position/);
  });
});

// ---------------------------------------------------------------------------
// The prototype seed's side of the same bargain
// ---------------------------------------------------------------------------

describe('positionAllocator', () => {
  it('hands out 1, 2, 3 when nothing else is there', () => {
    const next = positionAllocator(new Map());
    expect([next('D:ADMIN'), next('D:ADMIN'), next('D:ADMIN')]).toEqual([1, 2, 3]);
  });

  it('steps over a slot another content source holds', () => {
    const next = positionAllocator(new Map([['D:ADMIN', new Set([2])]]));
    expect([next('D:ADMIN'), next('D:ADMIN')]).toEqual([1, 3]);
  });

  it('counts each group separately', () => {
    const next = positionAllocator(new Map([['D:ADMIN', new Set([1])]]));
    expect(next('D:ADMIN')).toBe(2);
    expect(next('D:FOS')).toBe(1);
  });
});

describe('badgeForPosition', () => {
  it('returns the prototype badge untouched when the position has not moved', () => {
    expect(badgeForPosition('A2', 2, 2)).toBe('A2');
    expect(badgeForPosition('8', 8, 8)).toBe('8');
  });

  it('follows the stage down when a pack takes its slot', () => {
    expect(badgeForPosition('A2', 2, 3)).toBe('A3');
  });

  it('agrees with the pack seeder on the same move', () => {
    expect(badgeForPosition('A2', 2, 3)).toBe(renumberBadge('A2', 3));
  });

  it('leaves a badge it does not recognise alone', () => {
    expect(badgeForPosition('Exam', 2, 3)).toBe('Exam');
  });
});
