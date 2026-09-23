import { Link } from 'react-router-dom';
import { dayTime, trackLabel } from '../../lib/format.js';
import OnlineDot from './OnlineDot.jsx';
import StatChips from './StatChips.jsx';
import TraineeActions from './TraineeActions.jsx';

/*
 * The live roster, styled as the approved prototype's management table: a navy
 * header row with white column labels, rows on white separated by a hairline,
 * and the per-stage chips in the middle doing the work of a progress report.
 *
 * Layout and column headings come from the prototype; every value comes from
 * /api/manager/roster. The browser sorts and filters, it never decides who is
 * where, and no trainee row is ever hard-coded here.
 *
 * It is a real <table>: the columns are data, and a screen reader should be
 * able to say "Test stats, S3: 1×, best 83%" without the manager counting
 * cells.
 *
 * Scrolling (the sideways-scrolling-page bug): the SCROLL BOX is the div
 * below, never the page. Two things keep it that way, and both are needed.
 *
 *  - min-w-0 on the layout's <main>: a grid track is min-content-sized by
 *    default, so the 1fr column would otherwise grow to the table's natural
 *    width and take the document with it.
 *  - `relative` on the box itself. Every sr-only label is position:absolute,
 *    and with no positioned ancestor its containing block was the page — so
 *    the hidden <label>s in the far-right Account cells sat ~700px beyond the
 *    viewport, unclipped by any overflow rule, and the page scrolled sideways
 *    even at phone width. Making the box a containing block puts them back
 *    inside it. (Measured: 848px of document scroll at 390px wide, 390 after.)
 *
 * The header row is sticky inside that box, so the column labels stay put
 * while the rows move.
 */

const th =
  'sticky top-0 z-10 bg-navy px-3.5 py-[11px] text-left font-display text-[12px] font-semibold ' +
  'tracking-[0.04em] whitespace-nowrap text-white';
const td = 'border-b border-line px-3.5 py-[11px] align-top text-[13.5px]';
const pillBase =
  'inline-block rounded-full px-[11px] py-[5px] text-[11px] font-bold tracking-[0.05em] uppercase';
const nameBadge =
  'ml-1.5 inline-block rounded-md px-2 py-[2px] align-middle text-[11px] font-semibold';

/*
 * The one small badge beside the name, as the prototype has it. "Disabled" is
 * deliberately NOT here: the Status column already says it and the Account
 * button already reads "Re-enable", so a third copy is noise.
 */
function NameBadge({ trainee, isSelf }) {
  if (isSelf) return <span className={`${nameBadge} bg-[#EEF1F5] text-muted`}>You</span>;
  if (!trainee.track) {
    return <span className={`${nameBadge} bg-amber-soft text-amber`}>Waiting for a track</span>;
  }
  return null;
}

/** A dot plus either "Online" or the day and time we last saw them. */
function StatusCell({ trainee }) {
  if (trainee.isDisabled) {
    return <OnlineDot online={false} label="Disabled" showLabel />;
  }
  if (trainee.onlineNow) return <OnlineDot online />;
  return <OnlineDot online={false} label={dayTime(trainee.lastSeenAt)} showLabel />;
}

/** "Stage 6 · Live Sales Calls", with how far through they are underneath. */
function PositionCell({ trainee }) {
  const total = trainee.stagesTotal ?? 0;
  const done = trainee.stagesDone ?? 0;
  const title = trainee.currentStageTitle;
  const badge = trainee.currentStageDisplayNum;

  if (!trainee.track) return <span className="text-muted">No stages yet</span>;
  return (
    <>
      {title ? (
        <span className="block font-semibold text-navy" title={title}>
          {badge ? `Stage ${badge} · ` : ''}
          {title}
        </span>
      ) : null}
      <span className="mt-0.5 block text-[12px] text-muted tabular-nums">
        {total > 0 ? `${done} of ${total} stages passed` : `${done} stages passed`}
      </span>
    </>
  );
}

function Row({ trainee, isSelf, showStage1 }) {
  return (
    <tr
      data-trainee={trainee.id}
      data-disabled={trainee.isDisabled ? 'true' : 'false'}
      className={`hover:bg-[#F8FAFC] ${trainee.isDisabled ? 'opacity-60' : ''}`}
    >
      <th scope="row" className={`${td} max-w-[230px] min-w-[170px] text-left font-normal`}>
        <Link
          to={`/manager/trainee/${trainee.id}`}
          className="font-bold text-navy underline"
          title={trainee.fullName}
        >
          {trainee.fullName}
        </Link>
        <NameBadge trainee={trainee} isSelf={isSelf} />
        <span className="mt-0.5 block truncate text-[12px] text-muted" title={trainee.email}>
          {trainee.email}
        </span>
      </th>

      <td className={`${td} whitespace-nowrap`}>
        <StatusCell trainee={trainee} />
      </td>

      <td className={`${td} whitespace-nowrap`}>{trackLabel(trainee.track)}</td>

      {/* min-w so "Stage 1 · Welcome & Induction" reads on two lines, not five. */}
      <td className={`${td} max-w-[260px] min-w-[176px]`}>
        <PositionCell trainee={trainee} />
      </td>

      <td className={`${td} max-w-[300px] min-w-[190px]`}>
        <StatChips stages={trainee.stages ?? []} />
      </td>

      {showStage1 ? (
        <td className={`${td} whitespace-nowrap`}>
          <span
            data-testid="stage1-pill"
            data-authorised={trainee.stage1Authorised ? 'true' : 'false'}
            className={`${pillBase} ${
              trainee.stage1Authorised ? 'bg-green-soft text-green' : 'bg-amber-soft text-amber'
            }`}
          >
            {trainee.stage1Authorised ? 'Authorised' : 'Awaiting'}
          </span>
        </td>
      ) : null}

      <td className={td}>
        <TraineeActions trainee={trainee} isSelf={isSelf} />
      </td>
    </tr>
  );
}

export default function RosterTable({ trainees, selfId = null, showStage1Auth = false }) {
  return (
    <div
      data-testid="roster-scroll"
      data-scroll="roster"
      className="relative max-h-[70vh] min-w-0 overflow-auto overscroll-contain"
    >
      <table className="w-full min-w-[980px] border-collapse text-left">
        <caption className="sr-only">
          Every trainee, with their position, test record and account state
        </caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              Trainee
            </th>
            <th scope="col" className={th}>
              Status
            </th>
            <th scope="col" className={th}>
              Track
            </th>
            <th scope="col" className={th}>
              Current position
            </th>
            <th scope="col" className={th}>
              Test stats (attempts · best %)
            </th>
            {showStage1Auth ? (
              <th scope="col" className={th}>
                Stage 1 auth
              </th>
            ) : null}
            <th scope="col" className={th}>
              Account
            </th>
          </tr>
        </thead>
        <tbody>
          {trainees.map((trainee) => (
            <Row
              key={trainee.id}
              trainee={trainee}
              isSelf={selfId !== null && trainee.id === selfId}
              showStage1={showStage1Auth}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
