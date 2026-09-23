// Server-side quiz grading. Pure functions: no database, no Express, no
// training content. The caller loads the questions (ids only) from Postgres
// and hands them over, so nothing here can ever leak a prompt or an answer
// string, and the rule can be unit-tested against every quiz size.
//
// The percentage rule is the prototype's, shared with the browser through
// shared/src/constants.ts: Math.round(correct / total * 100), and a pass is
// pct >= passMark. Nothing else rounds a score anywhere in the server.

import { scorePercent } from '@fac-academy/shared';

export interface GradableQuestion {
  id: number;
  /** Every option id that belongs to this question (prototype order). */
  optionIds: readonly number[];
  /** The single option flagged is_correct for this question. */
  correctOptionId: number;
}

export interface SubmittedAnswer {
  questionId: number;
  optionId: number;
}

export interface QuestionOutcome {
  questionId: number;
  /** null when the question was left unanswered — which counts as wrong. */
  selectedOptionId: number | null;
  correct: boolean;
}

export interface AttemptGrade {
  correctCount: number;
  total: number;
  /** Whole-number percentage, rounded exactly as the prototype rounds it. */
  pct: number;
  /** One entry per question, in the order the questions were passed in. */
  perQuestion: QuestionOutcome[];
}

/**
 * A submission the server refuses to grade: an answer for a question that is
 * not in this quiz, or an option that does not belong to the question it was
 * sent for. The route turns this into 400 `{ error: 'invalid_request' }` —
 * it is never graded as "wrong", because it means the client is confused or
 * is probing, and a silent wrong mark would hide that.
 */
export class InvalidAnswerError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidAnswerError';
  }
}

/**
 * Grade one attempt.
 *
 * Rules, all deliberate:
 * - **Unanswered counts as wrong.** The denominator is always the number of
 *   questions in the quiz, never the number of answers sent, so skipping
 *   questions can never raise a score.
 * - **Duplicate answers for one question: the last one wins.** A client that
 *   sends several answers for the same question (a double tap, a retried
 *   request body) gets the last choice in the array, which matches what the
 *   trainee saw selected on screen.
 * - **Unknown question or foreign option → InvalidAnswerError.** An option id
 *   is only accepted for the question it belongs to.
 * - Answers are never trusted for anything else: correctness comes from
 *   `correctOptionId`, which the client never sees before a pass (decision D3).
 */
export function gradeAttempt(
  questions: readonly GradableQuestion[],
  answers: readonly SubmittedAnswer[],
): AttemptGrade {
  const total = questions.length;
  if (total === 0) {
    // A quiz with no questions is a content defect, not a bad request.
    throw new Error('gradeAttempt: the quiz has no questions');
  }

  const byId = new Map<number, GradableQuestion>();
  for (const question of questions) byId.set(question.id, question);

  const chosen = new Map<number, number>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (question === undefined) {
      throw new InvalidAnswerError(`answer for question ${answer.questionId}, not in this quiz`);
    }
    if (!question.optionIds.includes(answer.optionId)) {
      throw new InvalidAnswerError(
        `option ${answer.optionId} does not belong to question ${answer.questionId}`,
      );
    }
    chosen.set(answer.questionId, answer.optionId); // last one wins
  }

  const perQuestion: QuestionOutcome[] = questions.map((question) => {
    const selected = chosen.get(question.id);
    return {
      questionId: question.id,
      selectedOptionId: selected ?? null,
      correct: selected !== undefined && selected === question.correctOptionId,
    };
  });

  const correctCount = perQuestion.reduce((n, outcome) => n + (outcome.correct ? 1 : 0), 0);

  return { correctCount, total, pct: scorePercent(correctCount, total), perQuestion };
}
