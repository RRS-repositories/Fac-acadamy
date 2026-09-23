import { Link } from 'react-router-dom';
import ProgressBar from '../training/ProgressBar.jsx';
import { badgeBase, badgeTone } from '../training/styles.js';
import { humanStatus, percent, relativeTime, trackLabel } from '../../lib/format.js';
import OnlineDot from './OnlineDot.jsx';
import TraineeActions from './TraineeActions.jsx';

/*
 * The live roster. One row per trainee, every number straight off
 * /api/manager/roster — the browser sorts and filters, it never decides who is
 * where.
 *
 * It is a real <table>: the columns are data, and a screen reader should be
 * able to say "Attempts, 4" without the manager counting cells.
 */

const th = 'px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.07em] text-muted uppercase';
const td = 'px-3 py-3 align-middle text-[13px]';

function StatusBadge({ trainee }) {
  if (trainee.isDisabled) {
    return <span className={`${badgeBase} bg-red-soft text-red`}>Disabled</span>;
  }
  if (!trainee.track) {
    return <span className={`${badgeBase} bg-amber-soft text-amber`}>Waiting for track</span>;
  }
  const done = (trainee.stagesDone ?? 0) >= (trainee.stagesTotal ?? 0) && trainee.stagesTotal > 0;
  return (
    <span className={`${badgeBase} ${done ? badgeTone.done : badgeTone.active}`}>
      {humanStatus(trainee.status ?? (done ? 'complete' : 'in progress'))}
    </span>
  );
}

function Row({ trainee }) {
  const total = trainee.stagesTotal ?? 0;
  const done = trainee.stagesDone ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <tr
      data-trainee={trainee.id}
      data-disabled={trainee.isDisabled ? 'true' : 'false'}
      className={`border-t border-line ${trainee.isDisabled ? 'opacity-60' : ''}`}
    >
      <th scope="row" className={`${td} font-semibold`}>
        <Link to={`/manager/trainee/${trainee.id}`} className="text-navy underline">
          {trainee.fullName}
        </Link>
        <span className="mt-0.5 block text-[11.5px] font-normal text-muted">{trainee.email}</span>
      </th>
      <td className={td}>{trackLabel(trainee.track)}</td>
      <td className={td}>
        <OnlineDot online={Boolean(trainee.onlineNow)} />
      </td>
      <td className={td}>
        {trainee.currentStageTitle ? (
          <span className="font-semibold text-navy">{trainee.currentStageTitle}</span>
        ) : (
          <span className="text-muted">Not started</span>
        )}
      </td>
      <td className={`${td} w-[150px]`}>
        <span className="mb-1.5 block text-[12.5px] font-semibold tabular-nums">
          {done}/{total}
        </span>
        <ProgressBar
          value={pct}
          tone={total > 0 && done === total ? 'green' : 'orange'}
          label={`${trainee.fullName}: ${done} of ${total} stages passed`}
        />
      </td>
      <td className={`${td} tabular-nums`}>{trainee.attempts ?? 0}</td>
      <td className={`${td} tabular-nums ${(trainee.fails ?? 0) >= 3 ? 'font-bold text-red' : ''}`}>
        {trainee.fails ?? 0}
      </td>
      <td className={`${td} tabular-nums`}>{percent(trainee.bestAverage)}</td>
      <td className={`${td} text-muted`}>{relativeTime(trainee.lastActivityAt)}</td>
      <td className={td}>
        <StatusBadge trainee={trainee} />
      </td>
      <td className={td}>
        <TraineeActions trainee={trainee} />
      </td>
    </tr>
  );
}

export default function RosterTable({ trainees }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Every trainee, with their programme, progress and account state
        </caption>
        <thead>
          <tr className="bg-bg">
            <th scope="col" className={th}>
              Trainee
            </th>
            <th scope="col" className={th}>
              Track
            </th>
            <th scope="col" className={th}>
              Online
            </th>
            <th scope="col" className={th}>
              Current stage
            </th>
            <th scope="col" className={th}>
              Progress
            </th>
            <th scope="col" className={th}>
              Attempts
            </th>
            <th scope="col" className={th}>
              Fails
            </th>
            <th scope="col" className={th}>
              Best average
            </th>
            <th scope="col" className={th}>
              Last activity
            </th>
            <th scope="col" className={th}>
              Status
            </th>
            <th scope="col" className={th}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {trainees.map((trainee) => (
            <Row key={trainee.id} trainee={trainee} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
