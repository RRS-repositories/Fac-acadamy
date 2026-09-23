import { Link, useParams } from 'react-router-dom';
import ManagerLayout from '../../components/manager/ManagerLayout.jsx';
import OnlineDot from '../../components/manager/OnlineDot.jsx';
import StageChips from '../../components/manager/StageChips.jsx';
import TraineeActions from '../../components/manager/TraineeActions.jsx';
import { ErrorNotice, Notice } from '../../components/manager/Notice.jsx';
import ProgressBar from '../../components/training/ProgressBar.jsx';
import { badgeBase, cardClass } from '../../components/training/styles.js';
import { useTrainee } from '../../api/manager.js';
import { percent, relativeTime, shortDate, trackLabel } from '../../lib/format.js';

/*
 * One trainee (Section 07 task 1): their account, their position and every
 * stage on their programme with attempts, best mark and fails.
 *
 * Stage titles and numbers only — a manager never sees the lesson text or a
 * quiz question through this screen, and the bundle holds neither.
 */

function Fact({ label, children }) {
  return (
    <div>
      <dt className="text-[11px] font-bold tracking-[0.07em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 text-[13.5px] font-semibold text-ink">{children}</dd>
    </div>
  );
}

export default function TraineeDetail() {
  const { id } = useParams();
  const query = useTrainee(id);

  if (query.isError) {
    return (
      <ManagerLayout title="Trainee">
        <ErrorNotice error={query.error} what="this trainee" onRetry={() => query.refetch()} />
      </ManagerLayout>
    );
  }
  if (query.isPending) {
    return (
      <ManagerLayout title="Trainee">
        <Notice title="Loading…" />
      </ManagerLayout>
    );
  }

  const trainee = query.data?.trainee ?? null;
  const stages = query.data?.stages ?? [];
  if (!trainee) {
    return (
      <ManagerLayout title="Trainee">
        <Notice title="That trainee is no longer on the roster." />
      </ManagerLayout>
    );
  }

  const total = trainee.stagesTotal ?? stages.length;
  const done = trainee.stagesDone ?? stages.filter((s) => s.state === 'done').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <ManagerLayout>
      <Link to="/manager" className="text-[13px] font-semibold text-navy underline">
        ← Back to the roster
      </Link>

      <section className={`${cardClass} mt-3 px-6 py-6`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-bold">{trainee.fullName}</h1>
            <p className="mt-1 text-[13.5px] text-muted">{trainee.email}</p>
            <p className="mt-2 flex flex-wrap items-center gap-3">
              <OnlineDot online={Boolean(trainee.onlineNow)} />
              {trainee.isDisabled ? (
                <span className={`${badgeBase} bg-red-soft text-red`}>Disabled</span>
              ) : null}
              {trainee.track ? null : (
                <span className={`${badgeBase} bg-amber-soft text-amber`}>Waiting for track</span>
              )}
            </p>
          </div>
          <TraineeActions trainee={trainee} layout="stack" />
        </div>

        <dl data-testid="trainee-facts" className="mt-6 grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <Fact label="Track">{trackLabel(trainee.track)}</Fact>
          <Fact label="Stages passed">
            {done}/{total}
          </Fact>
          <Fact label="Attempts">{trainee.attempts ?? 0}</Fact>
          <Fact label="Fails">{trainee.fails ?? 0}</Fact>
          <Fact label="Best average">{percent(trainee.bestAverage)}</Fact>
          <Fact label="Started">{shortDate(trainee.startedAt)}</Fact>
        </dl>

        <div className="mt-5">
          <ProgressBar
            value={pct}
            tone={total > 0 && done === total ? 'green' : 'orange'}
            label={`${trainee.fullName}: ${done} of ${total} stages passed`}
          />
          <p className="mt-2 text-[12.5px] text-muted">
            Last activity {relativeTime(trainee.lastActivityAt)} · last seen{' '}
            {relativeTime(trainee.lastSeenAt)}
          </p>
        </div>
      </section>

      <section className={`${cardClass} mt-5 px-6 py-6`}>
        <h2 className="mb-4 font-display text-lg font-bold">
          {trainee.currentStageTitle ? `Currently on: ${trainee.currentStageTitle}` : 'Programme'}
        </h2>
        <StageChips stages={stages} />
      </section>
    </ManagerLayout>
  );
}
