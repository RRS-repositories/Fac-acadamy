import { Link } from 'react-router-dom';
import NextUpCta from './NextUpCta.jsx';
import ProgressBar from './ProgressBar.jsx';
import { badgeBase, badgeTone, btnGhost, btnNavy, cardClass } from './styles.js';

/*
 * One stage on the dashboard (.stage-card). Title and blurb come from
 * /api/track; nothing about the stage is known to the bundle.
 *
 * A locked card says only "Complete the previous stage to unlock". It must
 * never name the stage that comes next, or the order of a track leaks out of
 * the gate the server enforces.
 */

const LOCKED_CTA = 'Complete the previous stage to unlock';

function badgeFor(stage) {
  if (stage.state === 'done') return { tone: badgeTone.done, text: 'Passed' };
  if (stage.state === 'available') {
    return { tone: badgeTone.active, text: stage.attempts > 0 ? 'In progress' : 'Unlocked' };
  }
  return { tone: badgeTone.locked, text: '🔒 Locked' };
}

function Part({ done, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${done ? 'text-green' : ''}`}>
      <span aria-hidden="true">{done ? '✓' : '○'}</span>
      {children}
    </span>
  );
}

export default function StageCard({ stage, isNext = false }) {
  const locked = stage.state === 'locked';
  const done = stage.state === 'done';
  const badge = badgeFor(stage);
  const label = stage.dept === null ? 'Stage' : 'Module';
  const to = `/stage/${encodeURIComponent(stage.code)}`;
  const progress = done ? 100 : (stage.best ?? 0);

  return (
    <article
      data-stage={stage.code}
      data-state={stage.state}
      className={`${cardClass} flex flex-col gap-3 px-[26px] py-6 ${
        locked
          ? 'opacity-[0.62]'
          : 'transition-shadow hover:shadow-[0_14px_34px_rgba(14,35,56,0.12)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-xs font-extrabold tracking-[0.1em] text-orange uppercase">
            {label} {stage.displayNum}
          </div>
          <h3 className="mt-0.5 text-lg font-semibold">{stage.title}</h3>
        </div>
        <span className={`${badgeBase} ${badge.tone}`}>{badge.text}</span>
      </div>

      <p className="text-[13.5px] text-muted">{stage.blurb}</p>

      <div className="flex flex-wrap gap-3.5 text-xs font-semibold text-muted">
        <Part done={done}>
          {stage.lessonCount} lesson{stage.lessonCount === 1 ? '' : 's'}
        </Part>
        {stage.recordingCount > 0 ? (
          <Part done={done}>
            {stage.recordingCount} recording{stage.recordingCount === 1 ? '' : 's'}
          </Part>
        ) : null}
        <Part done={done}>
          Exam ({stage.passMark}%)
          {stage.best === null ? '' : ` · best ${stage.best}%`}
          {stage.attempts > 0
            ? ` · ${stage.attempts} attempt${stage.attempts === 1 ? '' : 's'}`
            : ''}
        </Part>
      </div>

      <ProgressBar
        value={progress}
        tone={done ? 'green' : 'orange'}
        label={`${label} ${stage.displayNum} progress`}
      />

      <div className="mt-auto pt-1">
        {locked ? (
          <button type="button" className={btnGhost} disabled>
            {LOCKED_CTA}
          </button>
        ) : isNext ? (
          <NextUpCta to={to} showTag>
            {stage.attempts > 0
              ? 'Continue the next module — resume now →'
              : 'Begin the next module — Start now →'}
          </NextUpCta>
        ) : (
          <Link to={to} className={done ? btnGhost : btnNavy}>
            {done ? 'Review stage' : stage.attempts > 0 ? 'Continue →' : 'Start stage →'}
          </Link>
        )}
      </div>
    </article>
  );
}
