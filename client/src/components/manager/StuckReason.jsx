import { badgeBase } from '../training/styles.js';

/*
 * Why the server flagged this trainee, in words a manager can act on. The
 * server decides who is stuck (3+ fails on one stage, or 7 days of silence);
 * this only says it out loud.
 */

function failsPhrase(row) {
  const fails = row.stageFails ?? 0;
  const stage = row.stuckStageCode ? `stage ${row.stuckStageCode}` : 'the same stage';
  return `${fails} fail${fails === 1 ? '' : 's'} on ${stage}`;
}

function inactivePhrase(row) {
  const days = row.inactiveDays ?? 0;
  return `no activity for ${days} day${days === 1 ? '' : 's'}`;
}

/** "3 fails on stage L1-4", "no activity for 9 days", or both. */
export function stuckReasonText(row) {
  if (row.reason === 'repeated_fails') return failsPhrase(row);
  if (row.reason === 'inactive') return inactivePhrase(row);
  if (row.reason === 'both') return `${failsPhrase(row)}, and ${inactivePhrase(row)}`;
  return 'Needs a look';
}

export default function StuckReason({ row }) {
  const urgent = row.reason === 'both' || row.reason === 'repeated_fails';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className={`${badgeBase} ${urgent ? 'bg-red-soft text-red' : 'bg-amber-soft text-amber'}`}
      >
        {row.reason === 'inactive' ? 'Gone quiet' : 'Struggling'}
      </span>
      <span className="text-[13px] text-ink">{stuckReasonText(row)}</span>
    </span>
  );
}
