// Left-hand brand panel of the sign-in screen. Copy is ported verbatim from
// the approved prototype; only the prototype's build-number line is dropped.
const PROGRAMMES = [
  'L1 · Foundation — Week 1',
  'L2 · Working Claims',
  'L3 · Product Mastery',
  'L4 · Gambling Harm & FOS',
  'L5 · Specialist Certification',
  '🗂 Admin Academy',
  '⚖️ FOS Academy',
  '📊 Management',
  '💷 Payments',
  '🖥 IT Academy',
  '📞 Debt Collections',
];

export default function BrandPanel() {
  return (
    <section
      aria-label="FAC Academy"
      className="relative flex flex-col justify-between gap-10 overflow-hidden bg-[linear-gradient(160deg,var(--color-navy-deep)_0%,var(--color-navy)_55%,var(--color-navy-mid)_100%)] p-8 text-white sm:p-10 lg:flex-[1.1] lg:p-14"
    >
      {/* Decorative rings from the prototype. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-36 -right-36 size-[420px] rounded-full border-[60px] border-orange/15"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -left-24 size-[360px] rounded-full border-[48px] border-white/5"
      />

      <div className="relative flex items-center gap-3 font-display text-[22px] font-extrabold tracking-wide">
        <span aria-hidden="true" className="inline-block size-3.5 rounded-[4px] bg-orange" />
        FAC&nbsp;Academy
      </div>

      <div className="relative">
        <h1 className="max-w-[520px] text-[clamp(30px,3.4vw,44px)] font-extrabold text-white">
          Every expert on this team started at{' '}
          <em className="text-orange not-italic">Stage&nbsp;1</em>.
        </h1>
        <p className="mt-4 max-w-[460px] text-white/80">
          The Fast Action Claims training programme for customer service and sales. Five levels
          across your first six weeks — lessons, real call recordings, and exams that get harder as
          you climb. Pass Level 1 and you&apos;re ready to start work; pass Level 5 and you&apos;re
          a certified specialist.
        </p>
        <ul className="mt-8 hidden flex-wrap gap-2.5 sm:flex" aria-label="Programmes">
          {PROGRAMMES.map((name) => (
            <li
              key={name}
              className="rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-[12.5px] font-semibold"
            >
              {name}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-white/55">
        Fast Action Claims is a trading style of Rowan Rose Ltd (Company No. 12916452) · SRA No.
        8000843
        <br />
        Boat Shed, Exchange Quay, Salford, M5 3EQ
      </p>
    </section>
  );
}
