import { describe, expect, it } from 'vitest';
import { InvalidAnswerError, gradeAttempt } from '../../../src/modules/training/grading.js';
import type { GradableQuestion } from '../../../src/modules/training/grading.js';
import { isPass } from '@fac-academy/shared';

// Pass-mark boundaries for every quiz size in the seeded content, and the
// rounding rule behind them. No training content appears here: the questions
// are synthetic ids, because the rule is arithmetic and nothing else.

/** n synthetic questions, 4 options each, the first option correct. */
function questions(n: number): GradableQuestion[] {
  return Array.from({ length: n }, (_, i) => {
    const base = (i + 1) * 10;
    return {
      id: i + 1,
      optionIds: [base + 1, base + 2, base + 3, base + 4],
      correctOptionId: base + 1,
    };
  });
}

/** Answer the first `correct` questions right and the rest wrong. */
function answers(qs: GradableQuestion[], correct: number) {
  return qs.map((q, i) => ({
    questionId: q.id,
    optionId: i < correct ? q.correctOptionId : q.optionIds[1]!,
  }));
}

// The oracle: worked out by hand from Math.round(correct / total * 100), not
// generated from the code under test. Sizes are every quiz size in the
// prototype (5, 6, 7, 8, 10, 11, 12, 20); pass marks are the three in use
// (80 default, 85 for Levels 3-4, 90 for Level 5).
const BOUNDARIES = [
  { size: 5, passMark: 80, at: 4, atPct: 80, below: 3, belowPct: 60 },
  { size: 6, passMark: 80, at: 5, atPct: 83, below: 4, belowPct: 67 },
  { size: 7, passMark: 80, at: 6, atPct: 86, below: 5, belowPct: 71 },
  { size: 8, passMark: 80, at: 7, atPct: 88, below: 6, belowPct: 75 },
  { size: 10, passMark: 80, at: 8, atPct: 80, below: 7, belowPct: 70 },
  { size: 11, passMark: 80, at: 9, atPct: 82, below: 8, belowPct: 73 },
  { size: 12, passMark: 80, at: 10, atPct: 83, below: 9, belowPct: 75 },
  { size: 20, passMark: 80, at: 16, atPct: 80, below: 15, belowPct: 75 },
  { size: 8, passMark: 85, at: 7, atPct: 88, below: 6, belowPct: 75 },
  { size: 8, passMark: 90, at: 8, atPct: 100, below: 7, belowPct: 88 },
  { size: 12, passMark: 90, at: 11, atPct: 92, below: 10, belowPct: 83 },
];

describe('gradeAttempt: pass-mark boundaries', () => {
  for (const b of BOUNDARIES) {
    it(`${b.size} questions at ${b.passMark}%: ${b.at} right passes, ${b.below} fails`, () => {
      const qs = questions(b.size);

      const atMark = gradeAttempt(qs, answers(qs, b.at));
      expect(atMark.correctCount).toBe(b.at);
      expect(atMark.total).toBe(b.size);
      expect(atMark.pct).toBe(b.atPct);
      expect(isPass(atMark.pct, b.passMark)).toBe(true);

      const oneBelow = gradeAttempt(qs, answers(qs, b.below));
      expect(oneBelow.correctCount).toBe(b.below);
      expect(oneBelow.pct).toBe(b.belowPct);
      expect(isPass(oneBelow.pct, b.passMark)).toBe(false);
    });
  }

  it('covers every quiz size in the seeded content', () => {
    const sizes = new Set(BOUNDARIES.map((b) => b.size));
    expect([...sizes].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 10, 11, 12, 20]);
  });
});

describe('gradeAttempt: rounding', () => {
  it('rounds exactly like Math.round(correct / total * 100), halves up', () => {
    const qs = questions(8);
    // 1/8 = 12.5 -> 13, 3/8 = 37.5 -> 38, 7/8 = 87.5 -> 88.
    expect(gradeAttempt(qs, answers(qs, 1)).pct).toBe(13);
    expect(gradeAttempt(qs, answers(qs, 3)).pct).toBe(38);
    expect(gradeAttempt(qs, answers(qs, 7)).pct).toBe(88);
  });

  it('agrees with Math.round for every score of every seeded quiz size', () => {
    for (const size of [5, 6, 7, 8, 10, 11, 12, 20]) {
      const qs = questions(size);
      for (let correct = 0; correct <= size; correct++) {
        expect(gradeAttempt(qs, answers(qs, correct)).pct).toBe(Math.round((correct / size) * 100));
      }
    }
  });
});

describe('gradeAttempt: answer handling', () => {
  it('counts an unanswered question as wrong, and never shrinks the total', () => {
    const qs = questions(10);
    // Only 8 answers sent, all right: 8/10, not 8/8.
    const grade = gradeAttempt(qs, answers(qs, 10).slice(0, 8));
    expect(grade.total).toBe(10);
    expect(grade.correctCount).toBe(8);
    expect(grade.pct).toBe(80);
    expect(grade.perQuestion.at(-1)).toEqual({
      questionId: 10,
      selectedOptionId: null,
      correct: false,
    });
  });

  it('sends nothing at all: 0%, every question wrong', () => {
    const qs = questions(5);
    const grade = gradeAttempt(qs, []);
    expect(grade).toMatchObject({ correctCount: 0, total: 5, pct: 0 });
    expect(grade.perQuestion.every((q) => !q.correct && q.selectedOptionId === null)).toBe(true);
  });

  it('keeps the LAST answer when a question is answered twice', () => {
    const qs = questions(5);
    const q1 = qs[0]!;
    const wrongThenRight = gradeAttempt(qs, [
      { questionId: q1.id, optionId: q1.optionIds[1]! },
      { questionId: q1.id, optionId: q1.correctOptionId },
    ]);
    expect(wrongThenRight.correctCount).toBe(1);
    expect(wrongThenRight.perQuestion[0]).toEqual({
      questionId: q1.id,
      selectedOptionId: q1.correctOptionId,
      correct: true,
    });

    const rightThenWrong = gradeAttempt(qs, [
      { questionId: q1.id, optionId: q1.correctOptionId },
      { questionId: q1.id, optionId: q1.optionIds[2]! },
    ]);
    expect(rightThenWrong.correctCount).toBe(0);
  });

  it('keeps perQuestion in the order the questions were given', () => {
    const qs = questions(6);
    const grade = gradeAttempt(qs, answers(qs, 6).toReversed());
    expect(grade.perQuestion.map((q) => q.questionId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects an option that belongs to another question', () => {
    const qs = questions(5);
    expect(() =>
      gradeAttempt(qs, [{ questionId: qs[0]!.id, optionId: qs[1]!.correctOptionId }]),
    ).toThrow(InvalidAnswerError);
  });

  it('rejects an answer for a question that is not in this quiz', () => {
    const qs = questions(5);
    try {
      gradeAttempt(qs, [{ questionId: 999, optionId: 11 }]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAnswerError);
      expect((err as InvalidAnswerError).code).toBe('invalid_request');
    }
  });

  it('refuses to grade a quiz with no questions', () => {
    expect(() => gradeAttempt([], [])).toThrow(/no questions/);
  });
});
