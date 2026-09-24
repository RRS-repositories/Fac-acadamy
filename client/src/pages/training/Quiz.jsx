import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuiz, useStage, useSubmitQuiz, useTrack } from '../../api/training.js';
import LockedCard from '../../components/training/LockedCard.jsx';
import QuizResult from '../../components/training/QuizResult.jsx';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import {
  btnPrimary,
  cardClass,
  optionFocusRing,
  optionRow,
  optionTextClass,
  optionTone,
  questionCardClass,
  questionHeadClass,
  questionNumClass,
} from '../../components/training/styles.js';
import { useScrollToTopOnChange } from '../../lib/scroll.js';

/*
 * The stage quiz: /stage/:code/quiz
 *
 * The questions, their order and their options come from
 * GET /api/stage/:code/quiz, which carries no correct flag of any kind. The
 * answers are graded by POST /api/stage/:code/quiz — the browser marks
 * nothing and knows nothing until the server answers.
 *
 * Scroll rule: selecting an answer is an in-place update and must never move
 * the page (CHECKLIST 05). Nothing in the selection path focuses, scrolls or
 * resizes anything — a selected option only changes colour, and its border is
 * the same width in both states. Starting a new attempt IS navigation, so it
 * scrolls back to the first question.
 *
 * Layout rule: the question line lives INSIDE the question card, as its first
 * child. It used to be a <legend> in a <fieldset>, which the browser paints on
 * the fieldset's border box — the heading rode up over the card's top edge and
 * the card's 28px top padding was left below it as dead space. The group is
 * now a plain div with role="group" + aria-labelledby, which keeps the same
 * announcement without the legend's special box.
 */

function Panel({ title, children }) {
  return (
    <section className={`${cardClass} p-10 text-center`}>
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>
    </section>
  );
}

export default function Quiz() {
  const { code } = useParams();
  const quizQuery = useQuiz(code);
  const trackQuery = useTrack();
  const stageQuery = useStage(code);
  const submitQuiz = useSubmitQuiz(code);

  // questionId -> optionId, for the attempt in progress.
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(1);

  // Arriving at the quiz, and starting a retake, both scroll to the top.
  // The prototype scrolls to the top when the result replaces the questions
  // (its doLogin/submit path sets _scrollTop), so a long quiz doesn't leave the
  // trainee halfway down the page. Answer selection still never scrolls.
  useScrollToTopOnChange(`${code}/${attempt}/${result ? 'result' : 'questions'}`);

  const stages = [...(trackQuery.data?.stages ?? [])].sort((a, b) => a.position - b.position);
  const here = stages.findIndex((stage) => stage.code === code);
  const thisStage = here === -1 ? null : stages[here];
  const nextStage = here !== -1 && here + 1 < stages.length ? stages[here + 1] : null;
  const stageLabel = thisStage
    ? `${thisStage.dept ? 'Module' : 'Stage'} ${thisStage.displayNum}`
    : 'This stage';
  const lessons = [...(stageQuery.data?.lessons ?? [])].sort((a, b) => a.position - b.position);
  const firstLessonId = lessons.length > 0 ? lessons[0].id : null;

  function choose(questionId, optionId) {
    // In place: no scrolling, no focus move, no layout change.
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
  }

  function retake() {
    setAnswers({});
    setResult(null);
    submitQuiz.reset();
    setAttempt((n) => n + 1);
  }

  let inner = null;

  if (quizQuery.isPending) {
    inner = <Panel title="Loading the quiz…">One moment.</Panel>;
  } else if (quizQuery.error) {
    const { code: reason } = quizQuery.error;
    if (reason === 'lessons_incomplete' || reason === 'recordings_incomplete') {
      inner = (
        <LockedCard
          title="The quiz is locked"
          message="Work through every part of this stage first — the quiz tests all of it."
          backTo={`/stage/${code}`}
        />
      );
    } else if (reason === 'locked' || reason === 'no_track') {
      inner = (
        <LockedCard
          title="This stage is locked"
          message="Complete the previous stage to unlock it."
        />
      );
    } else if (reason === 'not_found') {
      inner = (
        <Panel title="We couldn't find that quiz">
          <Link className="font-semibold text-navy underline" to="/">
            Back to my training
          </Link>
        </Panel>
      );
    } else {
      inner = (
        <Panel title="We couldn't load this quiz">
          Please try again shortly.{' '}
          <Link className="font-semibold text-navy underline" to={`/stage/${code}`}>
            Back to the stage
          </Link>
        </Panel>
      );
    }
  } else if (result) {
    inner = (
      <QuizResult
        result={result}
        questions={quizQuery.data.questions}
        answers={answers}
        passMark={quizQuery.data.passMark}
        stageCode={code}
        stageLabel={stageLabel}
        firstLessonId={firstLessonId}
        nextStage={nextStage}
        onRetake={retake}
      />
    );
  } else {
    inner = (
      <Attempt
        code={code}
        stageLabel={stageLabel}
        stageTitle={thisStage ? thisStage.title : null}
        quiz={quizQuery.data}
        answers={answers}
        onChoose={choose}
        onSubmit={(payload) => submitQuiz.mutate(payload, { onSuccess: setResult })}
        submitting={submitQuiz.isPending}
        failed={Boolean(submitQuiz.error)}
      />
    );
  }

  return <TrainingLayout currentCode={code}>{inner}</TrainingLayout>;
}

function Attempt({
  code,
  stageLabel,
  stageTitle,
  quiz,
  answers,
  onChoose,
  onSubmit,
  submitting,
  failed,
}) {
  const { questions, passMark } = quiz;
  const answeredCount = questions.filter((q) => answers[q.id] !== undefined).length;
  const complete = questions.length > 0 && answeredCount === questions.length;

  function handleSubmit(event) {
    event.preventDefault();
    if (!complete || submitting) return;
    onSubmit(questions.map((q) => ({ questionId: q.id, optionId: answers[q.id] })));
  }

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px] font-medium text-muted"
      >
        <Link className="hover:underline" to="/">
          Dashboard
        </Link>
        <span aria-hidden="true">›</span>
        <Link className="hover:underline" to={`/stage/${code}`}>
          {stageLabel}
          {stageTitle ? ` — ${stageTitle}` : ''}
        </Link>
        <span aria-hidden="true">›</span>
        <b className="text-navy">Quiz</b>
      </nav>

      <div className="mb-4 rounded-[10px] border-l-4 border-orange bg-orange-soft px-[18px] py-[15px] text-sm">
        <b className="mb-1 block font-display text-[13px] tracking-[0.05em] uppercase">
          {stageLabel} quiz
        </b>
        {questions.length} questions · pass mark {passMark}% · unlimited retakes. Answer every
        question, then submit.
      </div>

      <form onSubmit={handleSubmit}>
        {questions.map((question, qIndex) => (
          <div
            key={question.id}
            data-testid="question-card"
            role="group"
            aria-labelledby={`question-${question.id}-prompt`}
            className={questionCardClass}
          >
            <h2 id={`question-${question.id}-prompt`} className={questionHeadClass}>
              <span className={questionNumClass}>Q{qIndex + 1}</span>
              <span className="min-w-0 flex-1">{question.prompt}</span>
            </h2>
            {question.options.map((option) => {
              const selected = answers[question.id] === option.id;
              return (
                <label
                  key={option.id}
                  className={`${optionRow} ${optionFocusRing} cursor-pointer ${
                    selected ? optionTone.sel : optionTone.idle
                  }`}
                >
                  <input
                    type="radio"
                    name={`question-${question.id}`}
                    value={option.id}
                    checked={selected}
                    onChange={() => onChoose(question.id, option.id)}
                    className="mt-[3px] shrink-0 accent-orange"
                  />
                  <span className={optionTextClass}>{option.text}</span>
                </label>
              );
            })}
          </div>
        ))}

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
          <span role="status" className="text-[12.5px] text-muted">
            {answeredCount}/{questions.length} answered
          </span>
          <button type="submit" disabled={!complete || submitting} className={btnPrimary}>
            {submitting ? 'Marking…' : 'Submit answers'}
          </button>
        </div>

        {failed ? (
          <p className="mt-3 text-sm font-semibold text-red">
            We couldn&apos;t mark that attempt. Please try again.
          </p>
        ) : null}
      </form>
    </>
  );
}
