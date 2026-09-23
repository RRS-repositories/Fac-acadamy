// The dashboard hero's .ring: a conic-gradient dial with a navy hole punched
// out of the middle. Static — no animation, so reduced motion changes nothing.
export default function ProgressRing({ value, label = 'Overall progress' }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

  return (
    <div
      className="relative flex h-[92px] w-[92px] shrink-0 items-center justify-center rounded-full"
      style={{
        backgroundImage: `conic-gradient(var(--color-orange) ${pct}%, rgba(255,255,255,0.15) 0)`,
      }}
      role="img"
      aria-label={`${label}: ${pct}%`}
    >
      <span aria-hidden="true" className="absolute inset-[9px] rounded-full bg-navy" />
      <span className="relative z-10 font-display text-xl font-extrabold text-white">{pct}%</span>
    </div>
  );
}
