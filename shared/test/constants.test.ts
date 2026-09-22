import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASS_MARK,
  ROLES,
  TRACKS,
  TRACK_CODES,
  isPass,
  scorePercent,
} from '../src/constants.js';

describe('tracks', () => {
  it('has 9 unique track codes', () => {
    expect(TRACKS).toHaveLength(9);
    expect(new Set(TRACK_CODES).size).toBe(9);
  });

  it('gives every track a label', () => {
    for (const t of TRACKS) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});

describe('roles', () => {
  it('has STAFF and MANAGER', () => {
    expect([...ROLES]).toEqual(['STAFF', 'MANAGER']);
  });
});

describe('scorePercent', () => {
  it.each([
    [4, 5, 80],
    [5, 6, 83],
    [6, 7, 86],
    [7, 8, 88],
    [17, 20, 85],
    [0, 5, 0],
    [5, 5, 100],
  ])('%i/%i = %i', (correct, total, expected) => {
    expect(scorePercent(correct, total)).toBe(expected);
  });

  it('throws when total is 0 or less', () => {
    expect(() => scorePercent(0, 0)).toThrow(RangeError);
    expect(() => scorePercent(1, -1)).toThrow(RangeError);
  });
});

describe('isPass', () => {
  it('passes at exactly the pass mark', () => {
    expect(isPass(80, DEFAULT_PASS_MARK)).toBe(true);
  });

  it('fails one point below the pass mark', () => {
    expect(isPass(79, DEFAULT_PASS_MARK)).toBe(false);
  });

  it('uses the rounded score, as the prototype does', () => {
    expect(isPass(scorePercent(4, 5), DEFAULT_PASS_MARK)).toBe(true);
    expect(isPass(scorePercent(3, 4), DEFAULT_PASS_MARK)).toBe(false);
  });
});
