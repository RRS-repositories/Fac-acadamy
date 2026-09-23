/*
 * Class strings shared by the training screens. Each one is the prototype's
 * CSS rule (.card, .btn, .badge, .step-pill, .next-up-tag) rewritten as
 * Tailwind utilities against the tokens in styles/index.css, so the two look
 * the same side by side. Styling only — no training copy lives here.
 */

export const cardClass = 'rounded-card border border-line bg-card shadow-card';

const btnBase =
  'inline-flex items-center justify-center gap-2 rounded-[10px] px-[22px] py-[13px] text-[15px] font-bold ' +
  'transition-[background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:shadow-none';

export const btnPrimary = `${btnBase} bg-orange text-white hover:bg-[#d8632c] hover:shadow-[0_6px_16px_rgba(232,113,58,0.35)]`;
export const btnNavy = `${btnBase} bg-navy text-white hover:bg-navy-mid`;
export const btnGhost = `${btnBase} border-[1.5px] border-line bg-transparent text-navy hover:border-navy hover:bg-white`;

/** .btn-sm */
export const btnSmall = 'px-[13px] py-[7px] text-xs';

export const badgeBase =
  'inline-flex shrink-0 items-center gap-1 rounded-full px-[11px] py-[5px] text-[11px] font-bold tracking-[0.05em] uppercase';

export const badgeTone = {
  locked: 'bg-[#EEF1F5] text-[#8A97A6]',
  active: 'bg-orange-soft text-orange',
  done: 'bg-green-soft text-green',
};

/** The next-up glow. Box-shadow only — never a transform (Section 05 rule). */
export const pulseClass = 'animate-pulse-glow';

/** The navy → navy-mid hero wash and the sidebar wash, as in the prototype. */
export const heroGradient = {
  backgroundImage: 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-navy-mid) 100%)',
};
export const sidebarGradient = {
  backgroundImage: 'linear-gradient(180deg, var(--color-navy-deep), var(--color-navy))',
};

/** Badge tone for a stage state. */
export function toneForState(state) {
  if (state === 'done') return badgeTone.done;
  if (state === 'available') return badgeTone.active;
  return badgeTone.locked;
}
