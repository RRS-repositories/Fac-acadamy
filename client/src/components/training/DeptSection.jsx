import { TRACKS } from '@fac-academy/shared';
import StageCard from './StageCard.jsx';
import { badgeBase, badgeTone } from './styles.js';

/*
 * "Your Department Training" — the department academy modules for a trainee
 * whose track is a department one. Their stages arrive on /api/track with
 * `dept` set and `level` null, after the shared core stages.
 */
function deptLabel(codes) {
  const unique = [...new Set(codes)];
  if (unique.length !== 1) return null;
  return TRACKS.find((t) => t.code === unique[0])?.label ?? null;
}

export default function DeptSection({ stages, nextCode, heading = null }) {
  const done = stages.every((s) => s.state === 'done');
  const open = stages.some((s) => s.state !== 'locked');
  const label = deptLabel(stages.map((s) => s.dept));

  return (
    <section aria-labelledby="dept-training" data-section="dept" className="mt-8">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-3.5">
        <h2 id="dept-training" className="text-[19px] font-semibold">
          <span aria-hidden="true">{done ? '✅ ' : open ? '' : '🔒 '}</span>
          Your Department Training
        </h2>
        {(heading?.name ?? label) ? (
          <span className="text-[12.5px] font-semibold text-muted">
            {heading?.icon ? `${heading.icon} ` : ''}
            {heading?.name ?? label}
          </span>
        ) : null}
        {done ? <span className={`${badgeBase} ${badgeTone.done}`}>Complete</span> : null}
      </div>
      {heading?.description ? (
        <p className="mb-3 max-w-[70ch] text-[13.5px] text-muted">{heading.description}</p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {stages.map((stage) => (
          <StageCard key={stage.code} stage={stage} isNext={stage.code === nextCode} />
        ))}
      </div>
    </section>
  );
}
