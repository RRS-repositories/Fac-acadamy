import StageCard from './StageCard.jsx';
import { badgeBase, badgeTone } from './styles.js';

/*
 * One level block of the dashboard: "Level 1 — Foundation · Week 1".
 *
 * The heading wording (name, weeks, description) is training content, so it
 * comes from /api/track's `levels`, never from a constant in the bundle. When
 * the API sends no heading for a level, it falls back to "Level N".
 */
export default function LevelSection({ level, heading = null, stages, nextCode, first = false }) {
  const done = stages.every((s) => s.state === 'done');
  const open = stages.some((s) => s.state !== 'locked');

  return (
    <section data-level={level} aria-labelledby={`level-${level}`} className={first ? '' : 'mt-8'}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-3.5">
        <h2 id={`level-${level}`} className="text-[19px] font-semibold">
          <span aria-hidden="true">{done ? '✅ ' : open ? '' : '🔒 '}</span>
          Level {level}
          {heading?.name ? ` — ${heading.name}` : ''}
        </h2>
        {heading?.weeks ? (
          <span className="text-[12.5px] font-semibold text-muted">{heading.weeks}</span>
        ) : null}
        {done ? (
          <span className={`${badgeBase} ${badgeTone.done}`}>Complete</span>
        ) : open ? null : (
          <span className={`${badgeBase} ${badgeTone.locked}`}>
            {level > 1 ? `Unlocks after Level ${level - 1}` : 'Locked'}
          </span>
        )}
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
