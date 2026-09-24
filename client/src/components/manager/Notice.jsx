import { btnGhost, cardClass } from '../training/styles.js';

/*
 * The panels a manager screen shows when it has no table to draw: loading,
 * empty, or a failure explained in plain English.
 */

export function Notice({ title, children }) {
  return (
    <section className={`${cardClass} px-6 py-7`}>
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {children ? <div className="mt-2 text-[13.5px] text-muted">{children}</div> : null}
    </section>
  );
}

const MESSAGES = {
  forbidden: 'Your account is not a manager account any more.',
  not_found: "We couldn't find that record.",
  rate_limited: 'Too many requests in a row. Give it a moment and try again.',
  flag_off: "The training portal isn't open yet.",
  network: "We couldn't reach the server.",
};

export function ErrorNotice({ error, onRetry = null, what = 'that' }) {
  const message = MESSAGES[error?.code] ?? 'Please try again in a moment.';
  return (
    <section className={`${cardClass} border-l-4 border-l-red px-6 py-7`}>
      <h2 className="font-display text-lg font-bold">We couldn&apos;t load {what}.</h2>
      <p className="mt-2 text-[13.5px] text-muted">{message}</p>
      {onRetry ? (
        <button type="button" className={`${btnGhost} mt-4`} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}
