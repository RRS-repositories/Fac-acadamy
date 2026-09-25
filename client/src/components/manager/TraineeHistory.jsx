import ProgressBar from '../training/ProgressBar.jsx';
import { badgeBase, cardClass } from '../training/styles.js';
import { shortDate } from '../../lib/format.js';

/*
 * What a trainee did BEFORE the track they are on now (Section 07 follow-up).
 *
 * The detail page showed the current track and nothing else, so somebody who
 * finished the IT department academy and was then moved onto Management looked
 * like a person four stages into Management with no past at all. Nothing had
 * been lost — progress is keyed to the stage, not to the track — it just had
 * nowhere to be shown.
 *
 * Two things, both of them progress metadata: the programmes they completed
 * (the facts, from the completion tables) and the tracks they used to be on
 * (rebuilt from the audit trail). Names, dates and counts. There is no lesson
 * text, no question and no answer on this screen, and none in the response.
 *
 * Nothing to show means nothing is drawn: the page never carries an empty box.
 */

/** "Level 1" / "Department academy" — the row's eyebrow, in the page's voice. */
function kindLabel(programme) {
  return programme.kind === 'LEVEL' ? `Level ${programme.ref}` : 'Department academy';
}

/** .card's inner row, the same one the stage chips and the preview list use. */
const rowClass = 'rounded-[10px] border border-line px-4 py-3';

function CompletedProgramme({ programme }) {
  return (
    <li data-programme={`${programme.kind}:${programme.ref}`} className={rowClass}>
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-display text-[11px] font-extrabold tracking-[0.1em] text-orange uppercase">
            {kindLabel(programme)}
          </span>
          <span className="mt-0.5 block text-[13.5px] font-semibold text-navy">
            {programme.name}
          </span>
        </span>
        <span className={`${badgeBase} bg-green-soft text-green`}>Completed</span>
      </span>
      <p className="mt-2 text-[12.5px] text-muted">
        Completed {shortDate(programme.completedAt)} ·{' '}
        {programme.hasCertificate ? 'certificate issued' : 'no certificate yet'}
      </p>
    </li>
  );
}

function PreviousTrack({ track }) {
  const total = track.stagesTotal ?? 0;
  const passed = track.stagesPassed ?? 0;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  // A null start is honest, not a gap: the audit trail only recorded them
  // LEAVING this track, so nobody knows when they joined it. And a spell that
  // began and ended on one day reads as one date, not as "X – X".
  const from = track.heldFrom ?? null;
  const until = shortDate(track.heldUntil);
  const when =
    from === null
      ? `Until ${until}`
      : shortDate(from) === until
        ? `On ${until}`
        : `${shortDate(from)} – ${until}`;

  return (
    <li data-previous-track={track.trackCode} className={rowClass}>
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-display text-[11px] font-extrabold tracking-[0.1em] text-orange uppercase">
            Previous track
          </span>
          <span className="mt-0.5 block text-[13.5px] font-semibold text-navy">
            {track.trackLabel}
          </span>
        </span>
        <span className={`${badgeBase} bg-[#EEF1F5] text-[#8A97A6]`}>Moved off</span>
      </span>
      <p className="mt-2 text-[12.5px] text-muted tabular-nums">
        {when} · {passed} of {total} stage{total === 1 ? '' : 's'} passed
      </p>
      <ProgressBar
        className="mt-2"
        value={pct}
        tone={total > 0 && passed === total ? 'green' : 'orange'}
        label={`${track.trackLabel}: ${passed} of ${total} stages passed`}
      />
    </li>
  );
}

export default function TraineeHistory({ history }) {
  const programmes = history?.completedProgrammes ?? [];
  const previous = history?.previousTracks ?? [];
  if (programmes.length === 0 && previous.length === 0) return null;

  return (
    <section data-testid="trainee-history" className={`${cardClass} mt-5 px-6 py-6`}>
      <h2 className="font-display text-lg font-bold">Before this track</h2>
      <p className="mt-1 text-[13.5px] text-muted">
        Nothing here was lost when this trainee changed programme — marks are kept against the
        stage, not the track.
      </p>

      {programmes.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-[11px] font-bold tracking-[0.12em] text-orange uppercase">
            Completed programmes
          </h3>
          <ul className="mt-2 grid gap-2.5 sm:grid-cols-2">
            {programmes.map((programme) => (
              <CompletedProgramme
                key={`${programme.kind}:${programme.ref}`}
                programme={programme}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {previous.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-[11px] font-bold tracking-[0.12em] text-orange uppercase">
            Tracks previously held
          </h3>
          <ul className="mt-2 grid gap-2.5 sm:grid-cols-2">
            {previous.map((track) => (
              <PreviousTrack key={track.trackCode} track={track} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
