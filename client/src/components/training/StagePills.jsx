import { Link } from 'react-router-dom';

/*
 * The stage view's .steps-track: Lessons → Call recordings → Quiz.
 *
 * The recordings pill only appears when the stage actually has recordings.
 * Every pill is a real link or a real button, so the row is keyboard operable
 * and shows the app's focus ring. A locked pill is a disabled button carrying
 * the reason, never a dead <div>.
 *
 * Each pill takes:
 *   { key, label, icon, state: 'todo' | 'current' | 'done' | 'locked',
 *     to?, href?, reason? }
 */

const BASE =
  'inline-flex items-center gap-2.5 rounded-full border-[1.5px] px-4 py-2.5 text-[13.5px] font-semibold';

const STATE = {
  todo: 'border-line bg-white text-muted hover:border-navy-mid',
  current: 'border-orange bg-orange-soft text-navy',
  done: 'border-[#BFDCC1] bg-green-soft text-green',
  locked: 'border-line bg-white text-muted opacity-[0.55] cursor-not-allowed',
};

const ICON = {
  todo: 'bg-[#EEF1F5] text-[#8A97A6]',
  current: 'bg-orange text-white',
  done: 'bg-green text-white',
  locked: 'bg-[#EEF1F5] text-[#8A97A6]',
};

function Inner({ pill }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-extrabold ${
          ICON[pill.state] ?? ICON.todo
        }`}
      >
        {pill.state === 'done' ? '✓' : pill.icon}
      </span>
      {pill.label}
    </>
  );
}

export default function StagePills({ pills }) {
  return (
    <nav aria-label="Stage steps" className="my-6 flex flex-wrap gap-2.5">
      {pills.map((pill) => {
        const className = `${BASE} ${STATE[pill.state] ?? STATE.todo}`;
        if (pill.state === 'locked' || (!pill.to && !pill.href)) {
          return (
            <button
              key={pill.key}
              type="button"
              className={className}
              disabled={pill.state === 'locked'}
              aria-disabled={pill.state === 'locked' ? 'true' : undefined}
              title={pill.reason}
            >
              <Inner pill={pill} />
            </button>
          );
        }
        if (pill.href) {
          return (
            <a key={pill.key} href={pill.href} className={className}>
              <Inner pill={pill} />
            </a>
          );
        }
        return (
          <Link key={pill.key} to={pill.to} className={className}>
            <Inner pill={pill} />
          </Link>
        );
      })}
    </nav>
  );
}
