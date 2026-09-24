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

/*
 * Quiz question card (.card.pad.q-card, .qt, .qn, .opt in the prototype).
 *
 * The question line is an ordinary block INSIDE the card, never a <legend>:
 * a legend is painted on the fieldset's border box, so it escapes the card's
 * padding, straddles the top edge and leaves the padding as dead space below
 * it. Grouping is expressed with role="group" + aria-labelledby instead.
 */

/** .card.pad.q-card — 28px/32px padding, tightened on a phone. */
export const questionCardClass = `${cardClass} mb-4 px-8 py-7 max-sm:px-5 max-sm:py-6`;

/** .qt — the question line, first child of the card. */
export const questionHeadClass =
  'mb-3.5 flex gap-2.5 font-sans text-[15px] leading-[1.45] font-bold text-navy';

/** .qn — the orange question number. */
export const questionNumClass = 'shrink-0 font-display font-extrabold text-orange';

/** .opt — one option row. Both states carry the same border width, so
 *  selecting never changes the layout (Section 05 no-scroll rule). */
export const optionRow =
  'mb-2.5 flex items-start gap-3 rounded-[10px] border-[1.5px] px-[15px] py-3 text-sm ' +
  'leading-[1.5] transition-[border-color,background-color] duration-[120ms] last:mb-0';

/** .opt tones. `idle` is the unanswered row, with the prototype's hover. */
export const optionTone = {
  idle: 'border-line bg-card hover:border-navy-mid',
  sel: 'border-orange bg-orange-soft',
  correct: 'border-green bg-green-soft',
  wrong: 'border-red bg-red-soft',
  plain: 'border-line bg-card',
};

/** A visible focus ring on the whole row when its radio takes focus. */
export const optionFocusRing =
  'has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-orange ' +
  'has-[input:focus-visible]:outline-offset-2';

/** Long option text must wrap rather than widen the page on a phone. */
export const optionTextClass = 'min-w-0 break-words';

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
