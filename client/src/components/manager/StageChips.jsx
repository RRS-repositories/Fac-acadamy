import { badgeBase, toneForState } from '../training/styles.js';
import { percent, relativeTime } from '../../lib/format.js';

/*
 * One chip per stage on a trainee's programme: where they are, how many goes
 * it has taken, their best mark and how many of those goes were fails.
 *
 * Titles come from the API. There is no lesson text and no question here — a
 * manager sees how someone is doing, not what the quiz asks.
 */

function label(stage) {
  return `${stage.dept === null || stage.dept === undefined ? 'Stage' : 'Module'} ${stage.displayNum ?? stage.code}`;
}

function stateWord(state) {
  if (state === 'done') return 'Passed';
  if (state === 'available') return 'Open';
  return 'Locked';
}

export default function StageChips({ stages }) {
  if (stages.length === 0) {
    return (
      <p className="text-[13.5px] text-muted">
        No stages yet — this trainee is waiting for a track.
      </p>
    );
  }
  return (
    <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      {stages.map((stage) => (
        <li
          key={stage.code}
          data-stage={stage.code}
          data-state={stage.state}
          className="rounded-[10px] border border-line px-4 py-3"
        >
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block font-display text-[11px] font-extrabold tracking-[0.1em] text-orange uppercase">
                {label(stage)}
              </span>
              <span className="mt-0.5 block text-[13.5px] font-semibold text-navy">
                {stage.title}
              </span>
            </span>
            <span className={`${badgeBase} ${toneForState(stage.state)}`}>
              {stateWord(stage.state)}
            </span>
          </span>
          <p className="mt-2 text-[12.5px] text-muted tabular-nums">
            {stage.attempts ?? 0} attempt{(stage.attempts ?? 0) === 1 ? '' : 's'} · best{' '}
            {percent(stage.best)} ·{' '}
            <span className={(stage.fails ?? 0) >= 3 ? 'font-bold text-red' : ''}>
              {stage.fails ?? 0} fail{(stage.fails ?? 0) === 1 ? '' : 's'}
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            Last attempt {relativeTime(stage.lastAttemptAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
