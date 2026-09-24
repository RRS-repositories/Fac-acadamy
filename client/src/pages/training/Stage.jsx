import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import { useStage, useTrack } from '../../api/training.js';
import WaitingForTrack from '../WaitingForTrack.jsx';
import LockedCard from '../../components/training/LockedCard.jsx';
import ProgressBar from '../../components/training/ProgressBar.jsx';
import NoSeekPlayer from '../../components/training/NoSeekPlayer.jsx';
import StagePills from '../../components/training/StagePills.jsx';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import {
  badgeBase,
  badgeTone,
  btnGhost,
  btnNavy,
  btnPrimary,
  cardClass,
} from '../../components/training/styles.js';

/*
 * The stage view — the prototype's stage screen: header, the step pills, the
 * lessons, the call recordings and the quiz call to action.
 *
 * The server decides everything this page shows. A locked stage answers 403
 * with nothing but `requires`, so typing the URL renders the locked panel and
 * no content; a stage on another track answers 404 and is never acknowledged.
 * Reading a lesson and sitting the quiz are their own routes.
 */

const LESSONS_BLOCKED = 'Read every lesson in this stage to unlock the quiz.';

/**
 * What the quiz is waiting for, in the trainee's words. The server decides
 * `blockedBy`; this only puts it into a sentence, and when recordings are the
 * hold-up it says how many are left, because "listen to every recording" is
 * unhelpful when there is one to go.
 */
function quizBlockReason(quiz, listened, playable) {
  if (quiz.blockedBy === 'lessons') return LESSONS_BLOCKED;
  if (quiz.blockedBy !== 'recordings') return null;
  const left = Math.max(playable - listened, 0);
  return (
    `Listen to every call recording in this stage to unlock the quiz — ` +
    `${String(listened)} of ${String(playable)} done` +
    (left === 1 ? ', one to go.' : '.')
  );
}

/**
 * D4: an empty slot. Greyed out, no player, and it never blocks the quiz —
 * which is what the last line of the card says, in as many words.
 */
function ComingSoonSlot({ recording }) {
  return (
    <li
      data-recording={recording.id}
      data-coming-soon="true"
      className={`${cardClass} flex flex-wrap items-center gap-4 px-[22px] py-[18px] opacity-[0.55]`}
    >
      <span
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#EEF1F5] text-base text-[#8A97A6]"
      >
        ▶
      </span>
      <span className="min-w-[200px] flex-1">
        <span className="block text-[14.5px] font-bold text-navy">{recording.title}</span>
        <span className="block text-[12.5px] text-muted">{recording.description}</span>
        <span className="block text-[12.5px] text-muted">
          This recording isn&apos;t ready yet. It won&apos;t hold up your quiz.
        </span>
      </span>
      <span className={`${badgeBase} ${badgeTone.locked}`}>Coming soon</span>
    </li>
  );
}

function StageError({ error, code }) {
  const apiCode = error instanceof ApiError ? error.code : 'unknown';

  if (apiCode === 'no_track') return <WaitingForTrack />;

  if (apiCode === 'locked') {
    return <LockedStage code={code} requires={error.requires ?? null} />;
  }

  if (apiCode === 'not_found') {
    return (
      <TrainingLayout>
        <section className={`${cardClass} px-8 py-14 text-center`}>
          <h1 className="text-[19px] font-semibold">
            That stage isn&apos;t part of your programme
          </h1>
          <p className="mx-auto mt-2 max-w-[420px] text-sm text-muted">
            Check the link, or pick a stage from your dashboard.
          </p>
          <div className="mt-6">
            <Link to="/" className={btnGhost}>
              ← Back to your dashboard
            </Link>
          </div>
        </section>
      </TrainingLayout>
    );
  }

  return (
    <TrainingLayout>
      <section className={`${cardClass} p-6`}>
        <h1 className="text-lg font-semibold">We couldn&apos;t load this stage.</h1>
        <p className="mt-2 text-muted">Please try again in a moment.</p>
        <Link to="/" className={`${btnGhost} mt-4`}>
          ← Back to your dashboard
        </Link>
      </section>
    </TrainingLayout>
  );
}

/**
 * The 403 body names the stage that must be passed first and nothing else.
 * If that stage is one the trainee can already see on their own track, say
 * which it is; otherwise stay generic.
 */
function LockedStage({ code, requires }) {
  const track = useTrack();
  const prerequisite = requires
    ? (track.data?.stages ?? []).find((s) => s.code === requires)
    : undefined;

  let message = 'Complete the stage before this one to unlock it.';
  if (!requires) {
    message = 'Your manager will assign your training programme shortly.';
  } else if (prerequisite) {
    const label = prerequisite.dept === null ? 'Stage' : 'Module';
    message = `Pass ${label} ${prerequisite.displayNum} — ${prerequisite.title} — to unlock it.`;
  }

  return (
    <TrainingLayout currentCode={code}>
      <LockedCard title="This stage is locked" message={message} />
    </TrainingLayout>
  );
}

export default function Stage() {
  const { code } = useParams();
  const { data, isPending, isError, error } = useStage(code);

  if (isPending) {
    return (
      <TrainingLayout currentCode={code}>
        <section className={`${cardClass} p-6`}>
          <h1 className="text-lg font-semibold">Loading this stage…</h1>
        </section>
      </TrainingLayout>
    );
  }

  if (isError) return <StageError error={error} code={code} />;

  const { stage, lessons, recordings, quiz } = data;
  const label = stage.dept === null ? 'Stage' : 'Module';
  const lessonsRead = lessons.filter((l) => l.read).length;
  const lessonsDone = lessons.length > 0 && lessonsRead === lessons.length;
  const playable = recordings.filter((r) => !r.comingSoon);
  const listened = playable.filter((r) => r.listened).length;
  const recordingsDone = listened === playable.length;
  const blockReason = quiz.unlocked ? null : quizBlockReason(quiz, listened, playable.length);
  const quizTo = `/stage/${encodeURIComponent(stage.code)}/quiz`;

  const pills = [
    {
      key: 'lessons',
      icon: '1',
      label: `Lessons (${lessonsRead}/${lessons.length})`,
      state: lessonsDone ? 'done' : 'current',
      href: '#stage-lessons',
    },
  ];
  if (recordings.length > 0) {
    pills.push({
      key: 'recordings',
      icon: String(pills.length + 1),
      label: `Call recordings (${listened}/${playable.length})`,
      state: recordingsDone ? 'done' : 'todo',
      href: '#stage-recordings',
    });
  }
  pills.push({
    key: 'quiz',
    icon: String(pills.length + 1),
    label: `Exam · pass ${quiz.passMark}%${quiz.best === null ? '' : ` · best ${quiz.best}%`}`,
    state: quiz.passed ? 'done' : quiz.unlocked ? 'todo' : 'locked',
    to: quiz.unlocked ? quizTo : undefined,
    reason: blockReason ?? undefined,
  });

  return (
    <TrainingLayout currentCode={stage.code}>
      <p className="mb-4 flex items-center gap-2 text-[12.5px] font-medium text-muted">
        <Link to="/" className="underline decoration-line underline-offset-4 hover:text-navy">
          Dashboard
        </Link>
        <span aria-hidden="true">›</span>
        <b className="text-navy">
          {label} {stage.displayNum} — {stage.title}
        </b>
      </p>

      <header className="mb-5">
        <div className="mb-1.5 font-display text-xs font-extrabold tracking-[0.12em] text-orange uppercase">
          {stage.dept === null
            ? `Level ${stage.level ?? 1} · ${label} ${stage.displayNum}`
            : `${label} ${stage.displayNum}`}
        </div>
        <h1 className="text-[26px] font-bold">{stage.title}</h1>
        <p className="mt-1.5 max-w-[640px] text-[14.5px] text-muted">{stage.blurb}</p>
      </header>

      <StagePills pills={pills} />

      <section id="stage-lessons" aria-labelledby="stage-lessons-title" className="scroll-mt-6">
        <h2 id="stage-lessons-title" className="mb-3 text-lg font-semibold">
          Lessons
        </h2>
        <ol className={`${cardClass} divide-y divide-line p-2.5`}>
          {lessons.map((lesson, i) => (
            <li key={lesson.id}>
              <Link
                to={`/stage/${encodeURIComponent(stage.code)}/lesson/${lesson.id}`}
                className="flex items-center gap-3 rounded-[9px] px-3.5 py-3 text-[13.5px] font-semibold text-muted hover:bg-bg"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] text-white ${
                    lesson.read ? 'border-green bg-green' : 'border-line'
                  }`}
                >
                  {lesson.read ? '✓' : ''}
                </span>
                <span className="text-navy">{lesson.title}</span>
                <span className="ml-auto text-xs font-semibold text-muted">
                  {lesson.read ? 'Read' : `Lesson ${i + 1}`}
                </span>
              </Link>
            </li>
          ))}
        </ol>
        <ProgressBar
          value={lessons.length === 0 ? 0 : (lessonsRead / lessons.length) * 100}
          tone={lessonsDone ? 'green' : 'orange'}
          label="Lessons read"
          className="mt-3"
        />
      </section>

      {recordings.length > 0 ? (
        <section
          id="stage-recordings"
          aria-labelledby="stage-recordings-title"
          className="mt-8 scroll-mt-6"
        >
          <h2 id="stage-recordings-title" className="mb-3 text-lg font-semibold">
            Call recordings
          </h2>
          <ul className="flex list-none flex-col gap-3.5">
            {recordings.map((recording) =>
              recording.comingSoon ? (
                <ComingSoonSlot key={recording.id} recording={recording} />
              ) : (
                <NoSeekPlayer key={recording.id} recording={recording} stageCode={stage.code} />
              ),
            )}
          </ul>
          {playable.length > 0 ? (
            <p className={`${cardClass} mt-3.5 px-[22px] py-[14px] text-[13px] text-muted`}>
              <b className="block text-navy">Real recordings</b>
              These are genuine FAC calls, streamed from the academy — nothing is downloaded to your
              machine. There is deliberately no skip/seek control: pause and resume as you need, but
              &ldquo;listened&rdquo; only registers when the full call has played through.
            </p>
          ) : null}
        </section>
      ) : null}

      <section id="stage-quiz" aria-labelledby="stage-quiz-title" className="mt-8 scroll-mt-6">
        <h2 id="stage-quiz-title" className="mb-3 text-lg font-semibold">
          Stage quiz
        </h2>
        <div className={`${cardClass} flex flex-wrap items-center gap-4 p-6`}>
          <div className="min-w-[240px] flex-1">
            <p className="text-sm text-muted">
              {quiz.questionCount} question{quiz.questionCount === 1 ? '' : 's'} · pass mark{' '}
              {quiz.passMark}%{quiz.best === null ? '' : ` · best so far ${quiz.best}%`}
              {quiz.attempts > 0
                ? ` · ${quiz.attempts} attempt${quiz.attempts === 1 ? '' : 's'}`
                : ''}
            </p>
            {blockReason ? (
              <p className="mt-2 text-sm font-semibold text-amber">{blockReason}</p>
            ) : null}
          </div>
          {quiz.unlocked ? (
            <Link to={quizTo} className={quiz.passed ? btnNavy : btnPrimary}>
              {quiz.passed ? 'Retake for practice →' : 'Start the stage quiz →'}
            </Link>
          ) : (
            <button type="button" className={btnGhost} disabled title={blockReason ?? undefined}>
              Quiz locked
            </button>
          )}
        </div>
      </section>
    </TrainingLayout>
  );
}
