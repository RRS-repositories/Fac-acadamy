import { Link, useParams } from 'react-router-dom';
import { useMarkLessonRead, useStage } from '../../api/training.js';
import LessonBody from '../../components/training/LessonBody.jsx';
import LockedCard from '../../components/training/LockedCard.jsx';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import { btnGhost, btnNavy, btnPrimary, cardClass } from '../../components/training/styles.js';
import { useScrollToTopOnChange } from '../../lib/scroll.js';

/*
 * The lesson reader: /stage/:code/lesson/:lessonId
 *
 * Every word on this page comes from GET /api/stage/:code — the title, the
 * body HTML, the lesson order and whether each one is read. Nothing is
 * hardcoded, and the bundle never sees a lesson it was not served.
 *
 * Mark-as-read is an explicit button, exactly as in the prototype ("Mark
 * lesson complete ✓"); the page does not auto-mark on open. Unlike the
 * prototype it does not jump to the next lesson afterwards: marking read is an
 * in-place update, so the page must not move (scroll rule). Moving on is the
 * trainee's click on "Next lesson", which is navigation and does scroll to
 * the top.
 */

function Panel({ title, children }) {
  return (
    <section className={`${cardClass} p-10 text-center`}>
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>
    </section>
  );
}

export default function Lesson() {
  const { code, lessonId } = useParams();
  const stageQuery = useStage(code);
  const markRead = useMarkLessonRead();

  // Navigation — lesson to lesson — always starts at the top of the page.
  useScrollToTopOnChange(`${code}/${lessonId}`);

  let inner = null;

  if (stageQuery.isPending) {
    inner = <Panel title="Loading the lesson…">One moment.</Panel>;
  } else if (stageQuery.error) {
    const { code: reason } = stageQuery.error;
    if (reason === 'locked' || reason === 'no_track') {
      inner = (
        <LockedCard
          title="This stage is locked"
          message="Complete the previous stage to unlock it."
        />
      );
    } else if (reason === 'not_found') {
      inner = (
        <Panel title="We couldn't find that stage">
          <Link className="font-semibold text-navy underline" to="/">
            Back to my training
          </Link>
        </Panel>
      );
    } else {
      inner = (
        <Panel title="We couldn't load this lesson">
          Please try again shortly.{' '}
          <Link className="font-semibold text-navy underline" to="/">
            Back to my training
          </Link>
        </Panel>
      );
    }
  } else {
    inner = (
      <Reader
        code={code}
        lessonId={lessonId}
        stage={stageQuery.data.stage}
        lessons={stageQuery.data.lessons}
        markRead={markRead}
      />
    );
  }

  return <TrainingLayout currentCode={code}>{inner}</TrainingLayout>;
}

function Reader({ code, lessonId, stage, lessons, markRead }) {
  const ordered = [...lessons].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((lesson) => String(lesson.id) === String(lessonId));

  if (index === -1) {
    return (
      <Panel title="We couldn't find that lesson">
        <Link className="font-semibold text-navy underline" to={`/stage/${code}`}>
          Back to the stage
        </Link>
      </Panel>
    );
  }

  const lesson = ordered[index];
  const previous = index > 0 ? ordered[index - 1] : null;
  const next = index < ordered.length - 1 ? ordered[index + 1] : null;
  const allRead = ordered.every((item) => item.read);
  const unit = stage.dept ? 'Module' : 'Stage';

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
          {unit} {stage.displayNum} — {stage.title}
        </Link>
        <span aria-hidden="true">›</span>
        <b className="text-navy">{lesson.title}</b>
      </nav>

      <div className="grid items-start gap-5 md:grid-cols-[250px_1fr]">
        <nav aria-label="Lessons in this stage" className="md:sticky md:top-6">
          <div className={`${cardClass} p-2.5`}>
            {ordered.map((item) => {
              const current = item.id === lesson.id;
              return (
                <Link
                  key={item.id}
                  to={`/stage/${code}/lesson/${item.id}`}
                  aria-current={current ? 'page' : undefined}
                  className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-3 text-left text-[13.5px] font-semibold ${
                    current ? 'bg-orange-soft text-navy' : 'text-muted hover:bg-bg'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] text-white ${
                      item.read ? 'border-green bg-green' : 'border-line'
                    }`}
                  >
                    {item.read ? '✓' : ''}
                  </span>
                  <span>{item.title}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <article className={`${cardClass} px-8 py-7`}>
          <h1 className="font-display text-[21px] font-bold">{lesson.title}</h1>
          <p className="mb-5 text-[13.5px] text-muted">
            Lesson {index + 1} of {ordered.length} · {unit} {stage.displayNum}
          </p>

          <LessonBody html={lesson.bodyHtml} />

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3.5 border-t border-line pt-5">
            <span role="status" className="text-[12.5px] text-muted">
              {lesson.read ? '✓ Marked as read' : 'Read the full page, then mark it complete.'}
            </span>
            <div className="flex flex-wrap gap-2.5">
              {previous ? (
                <Link to={`/stage/${code}/lesson/${previous.id}`} className={btnGhost}>
                  ← Previous
                </Link>
              ) : null}

              {!lesson.read ? (
                <button
                  type="button"
                  disabled={markRead.isPending}
                  onClick={() => markRead.mutate({ stageCode: code, lessonId: lesson.id })}
                  className={btnPrimary}
                >
                  {markRead.isPending ? 'Marking…' : 'Mark lesson complete ✓'}
                </button>
              ) : next ? (
                <Link to={`/stage/${code}/lesson/${next.id}`} className={btnNavy}>
                  Next lesson →
                </Link>
              ) : allRead ? (
                <Link to={`/stage/${code}/quiz`} className={btnNavy}>
                  Continue to the quiz →
                </Link>
              ) : (
                <Link to={`/stage/${code}`} className={btnGhost}>
                  Back to the stage
                </Link>
              )}
            </div>
          </div>

          {markRead.error ? (
            <p className="mt-3 text-sm font-semibold text-red">
              We couldn&apos;t save that just now. Please try again.
            </p>
          ) : null}
        </article>
      </div>
    </>
  );
}
