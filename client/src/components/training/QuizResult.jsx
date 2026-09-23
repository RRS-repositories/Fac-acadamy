import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { btnGhost, btnPrimary, cardClass, pulseClass } from './styles.js';
import { focusWithoutScrolling } from '../../lib/scroll.js';

/*
 * The graded result, exactly as POST /api/stage/:code/quiz returned it. The
 * server does every calculation; this component only draws what it sent back.
 *
 * D3 — the rule that matters here: after a FAIL the trainee sees right or
 * wrong per question and nothing more. The API returns `correctOptionId: null`
 * on a failed attempt, and this component never guesses, derives or reveals
 * it. After a PASS the API sends `correctOptionId` and the review marks it.
 *
 * Rendering the result is an in-place update, so it must not move the page:
 * focus moves to the score for screen readers, with preventScroll.
 */

const TONE = {
  correct: 'border-green bg-green-soft',
  wrong: 'border-red bg-red-soft',
  plain: 'border-line bg-card',
};

/**
 * How one option reads in the review.
 * `reveal` is true only when the server sent the correct option (i.e. a pass).
 */
export function optionState({ optionId, chosenOptionId, correctOptionId, correct, reveal }) {
  const chosen = optionId === chosenOptionId;
  if (reveal && optionId === correctOptionId) {
    return {
      tone: 'correct',
      mark: '✓',
      label: chosen ? 'Correct answer — you chose this' : 'Correct answer',
      isCorrectAnswer: true,
    };
  }
  if (chosen && !correct) {
    return { tone: 'wrong', mark: '✗', label: 'Your answer — incorrect', isCorrectAnswer: false };
  }
  if (chosen) {
    // A right answer on a failed attempt: still only "right or wrong".
    return { tone: 'correct', mark: '✓', label: 'Your answer — correct', isCorrectAnswer: false };
  }
  return { tone: 'plain', mark: '○', label: '', isCorrectAnswer: false };
}

export default function QuizResult({
  result,
  questions,
  answers,
  passMark,
  stageCode,
  stageLabel,
  firstLessonId,
  nextStage,
  onRetake,
}) {
  const scoreRef = useRef(null);
  const passed = result.passed;

  useEffect(() => {
    focusWithoutScrolling(scoreRef.current);
  }, []);

  const verdicts = new Map(result.perQuestion.map((row) => [row.questionId, row]));
  const lessonsTo = firstLessonId
    ? `/stage/${stageCode}/lesson/${firstLessonId}`
    : `/stage/${stageCode}`;

  return (
    <div>
      <section
        ref={scoreRef}
        tabIndex={-1}
        aria-live="polite"
        className={`${cardClass} px-8 py-10 text-center`}
      >
        <div
          className={`font-display text-[48px] leading-none font-extrabold ${
            passed ? 'text-green' : 'text-red'
          }`}
        >
          {result.pct}%
        </div>
        <h1 className="mt-2 font-display text-xl font-bold">
          {passed ? `${stageLabel} passed 🎉` : `Not quite — ${passMark}% needed`}
        </h1>
        <p className="mx-auto mt-1.5 mb-[22px] max-w-[440px] text-sm text-muted">
          {passed
            ? `You answered ${result.correctCount} of ${result.total} correctly. The next part of your training is unlocked.`
            : `You answered ${result.correctCount} of ${result.total} correctly. Review the questions below, revisit the lessons if you need to, and retake when you're ready — retakes are unlimited.`}
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          {passed ? (
            <>
              {nextStage ? (
                <Link to={`/stage/${nextStage.code}`} className={`${btnPrimary} ${pulseClass}`}>
                  Next stage →
                </Link>
              ) : null}
              <Link to="/" className={nextStage ? btnGhost : btnPrimary}>
                Back to my training
              </Link>
            </>
          ) : (
            <>
              <button type="button" onClick={onRetake} className={btnPrimary}>
                Try again
              </button>
              <Link to={lessonsTo} className={btnGhost}>
                Revisit the lessons
              </Link>
            </>
          )}
        </div>
      </section>

      <h2 className="mt-[26px] mb-3 font-display text-[17px] font-bold">Answer review</h2>
      {questions.map((question, qIndex) => {
        const verdict = verdicts.get(question.id);
        if (!verdict) return null;
        // Never infer the answer: only what the server chose to send.
        const reveal = passed && verdict.correctOptionId !== null;
        return (
          <section key={question.id} className={`${cardClass} mb-4 px-8 py-7`}>
            <div className="mb-3.5 flex gap-2.5 text-[15px] font-bold text-navy">
              <span className="shrink-0 font-display font-extrabold text-orange">
                Q{qIndex + 1}
              </span>
              <span className="flex-1">{question.prompt}</span>
              <span
                className={`shrink-0 rounded-full px-[11px] py-[5px] text-[11px] font-bold tracking-[0.05em] uppercase ${
                  verdict.correct ? 'bg-green-soft text-green' : 'bg-red-soft text-red'
                }`}
              >
                {verdict.correct ? 'Correct' : 'Incorrect'}
              </span>
            </div>
            {question.options.map((option) => {
              const state = optionState({
                optionId: option.id,
                chosenOptionId: answers[question.id],
                correctOptionId: verdict.correctOptionId,
                correct: verdict.correct,
                reveal,
              });
              return (
                <div
                  key={option.id}
                  data-testid={state.isCorrectAnswer ? 'correct-answer' : 'option'}
                  className={`mb-2.5 flex items-start gap-3 rounded-[10px] border-[1.5px] px-[15px] py-3 text-sm ${TONE[state.tone]}`}
                >
                  <span aria-hidden="true">{state.mark}</span>
                  <span>{option.text}</span>
                  {state.label ? <span className="sr-only">{state.label}</span> : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
