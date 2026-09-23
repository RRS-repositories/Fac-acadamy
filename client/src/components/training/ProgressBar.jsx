// The prototype's .bar / .mini-bar. `tone` picks the fill: orange while a
// stage is in progress, green once it is passed, white on the navy sidebar.
const FILL = {
  orange: 'bg-orange',
  green: 'bg-green',
  light: 'bg-[linear-gradient(90deg,var(--color-orange),#F09A6C)]',
};

const TRACK = {
  orange: 'bg-[#EEF1F5]',
  green: 'bg-[#EEF1F5]',
  light: 'bg-white/12',
};

export default function ProgressBar({ value, tone = 'orange', label, className = '' }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const track = TRACK[tone] ?? TRACK.orange;
  const fill = FILL[tone] ?? FILL.orange;

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full ${track} ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
