import { Link } from 'react-router-dom';

/*
 * The sidebar stage rail — the prototype's signature element. Nodes joined by
 * a stem, green once passed, orange while open, dimmed while locked.
 *
 * An open stage is a real link; a locked one is a disabled button, so the
 * keyboard never lands on something that cannot be opened. The rail shows the
 * stage titles the API already sent for the dashboard, and nothing more.
 */

function railTitleTone(stages) {
  if (stages.every((s) => s.state === 'done')) return 'text-[#7BC88F]';
  if (stages.some((s) => s.state !== 'locked')) return 'text-orange';
  return 'text-white/35';
}

function RailTitle({ stages, children, className = '' }) {
  return (
    <div
      className={`px-6 text-[11px] font-bold tracking-[0.14em] uppercase ${railTitleTone(
        stages,
      )} ${className}`}
    >
      {children}
    </div>
  );
}

function RailItem({ stage, current, last }) {
  const done = stage.state === 'done';
  const open = stage.state !== 'locked';
  const status = done
    ? 'Completed ✓'
    : open
      ? stage.attempts > 0
        ? 'In progress'
        : 'Ready to start'
      : 'Locked';

  const node = done
    ? 'border-[#4CAF50] bg-green text-white'
    : open
      ? 'border-orange bg-orange text-white shadow-[0_0_0_5px_rgba(232,113,58,0.22)]'
      : 'border-white/25 bg-navy-deep text-white/55';

  const inner = (
    <>
      <span
        aria-hidden="true"
        className={`relative z-10 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 font-display text-[13px] font-bold ${node}`}
      >
        {done ? '✓' : open ? stage.displayNum : '🔒'}
      </span>
      {last ? null : (
        <span
          aria-hidden="true"
          className={`absolute top-[45px] bottom-[-11px] left-10 z-0 w-0.5 ${
            done ? 'bg-green' : 'bg-white/15'
          }`}
        />
      )}
      <span className="min-w-0 pt-0.5">
        <span
          className={`block text-[13.5px] leading-tight font-semibold ${
            open ? 'text-white/85' : 'text-white/40'
          }`}
        >
          {stage.title}
        </span>
        <span
          className={`mt-0.5 block text-[11px] ${open && !done ? 'font-semibold text-orange' : 'text-white/45'}`}
        >
          {status}
        </span>
      </span>
    </>
  );

  const base = `relative flex w-full items-start gap-3.5 px-6 py-[11px] text-left ${
    current ? 'bg-orange/13' : open ? 'hover:bg-white/5' : ''
  }`;

  if (!open) {
    return (
      <button type="button" disabled aria-disabled="true" className={`${base} cursor-not-allowed`}>
        {inner}
      </button>
    );
  }
  return (
    <Link
      to={`/stage/${encodeURIComponent(stage.code)}`}
      aria-current={current ? 'page' : undefined}
      className={base}
    >
      {inner}
    </Link>
  );
}

export default function Rail({ stages, currentCode = null, levelHeadings = [] }) {
  const levelStages = stages.filter((s) => s.dept === null);
  const deptStages = stages.filter((s) => s.dept !== null);

  const levels = [];
  for (const stage of levelStages) {
    const key = stage.level ?? 0;
    const group = levels.find((l) => l.level === key);
    if (group) group.stages.push(stage);
    else levels.push({ level: key, stages: [stage] });
  }

  const lastCode = stages.length > 0 ? stages[stages.length - 1].code : null;

  return (
    <nav aria-label="Your journey" className="relative flex-1 pt-1.5 pb-5">
      {levels.map((group, i) => (
        <div key={group.level}>
          <RailTitle stages={group.stages} className={i === 0 ? 'mb-3' : 'mt-4 mb-3'}>
            {group.stages.every((s) => s.state === 'done')
              ? '✓ '
              : group.stages.some((s) => s.state !== 'locked')
                ? ''
                : '🔒 '}
            Level {group.level}
            {levelName(levelHeadings, group.level)}
          </RailTitle>
          {group.stages.map((stage) => (
            <RailItem
              key={stage.code}
              stage={stage}
              current={stage.code === currentCode}
              last={stage.code === lastCode}
            />
          ))}
        </div>
      ))}

      {deptStages.length > 0 ? (
        <div>
          <RailTitle stages={deptStages} className="mt-5 mb-3">
            {deptStages.some((s) => s.state !== 'locked') ? '' : '🔒 '}
            Your Department Training
          </RailTitle>
          {deptStages.map((stage) => (
            <RailItem
              key={stage.code}
              stage={stage}
              current={stage.code === currentCode}
              last={stage.code === lastCode}
            />
          ))}
        </div>
      ) : null}
    </nav>
  );
}

/** "— Foundation · Week 1", from /api/track. Empty when the API sent no heading. */
function levelName(headings, level) {
  const heading = headings.find((l) => l.level === level);
  if (!heading?.name) return '';
  return heading.weeks ? ` — ${heading.name} · ${heading.weeks}` : ` — ${heading.name}`;
}
