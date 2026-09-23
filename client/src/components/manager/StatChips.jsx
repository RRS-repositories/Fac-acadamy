import { percent } from '../../lib/format.js';

/*
 * The "Test stats (attempts · best %)" cell of the roster, ported from the
 * prototype's .stat-chip rule: one small chip per stage the trainee has
 * actually attempted, in their own track's order.
 *
 * Green when it went through cleanly, red-tinted the moment there is a fail on
 * it — that red is the thing a manager scans the column for.
 *
 * A chip names the stage by its badge number only ("S3"). No title, no lesson,
 * no question: the roster carries a record, never content.
 */

const chipBase =
  'inline-block rounded-md px-2 py-[3px] text-[11.5px] font-semibold whitespace-nowrap';

/** '3' → 'S3'; a department badge like 'A1' or 'IT2' is already its own label. */
export function stageBadge(displayNum) {
  const text = String(displayNum ?? '').trim();
  if (text === '') return 'Stage';
  return /^\d+$/.test(text) ? `S${text}` : text;
}

export function chipText(stage) {
  const attempts = stage.attempts ?? 0;
  const fails = stage.fails ?? 0;
  const tail = fails > 0 ? ` · ${fails} fail${fails === 1 ? '' : 's'}` : '';
  return `${stageBadge(stage.displayNum)}: ${attempts}× · best ${percent(stage.best)}${tail}`;
}

export default function StatChips({ stages = [] }) {
  if (stages.length === 0) {
    return <span className={`${chipBase} bg-[#EEF1F5] text-muted`}>No attempts yet</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {stages.map((stage) => {
        const failed = (stage.fails ?? 0) > 0;
        return (
          <span
            key={stage.code}
            data-stage={stage.code}
            data-tone={failed ? 'fail' : 'pass'}
            className={`${chipBase} ${failed ? 'bg-red-soft text-red' : 'bg-green-soft text-green'}`}
          >
            {chipText(stage)}
          </span>
        );
      })}
    </span>
  );
}
