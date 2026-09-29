import { shortDate } from '../../lib/format.js';
import { cardClass } from './styles.js';

/*
 * "Your training has grown."
 *
 * Why this exists. A department academy or a level can gain a stage after
 * people have finished it — Admin went from two modules to three. Nothing
 * takes their completion away, but the dashboard recomputes live, so somebody
 * who was finished opens it one morning and finds themselves at "2 of 3" with
 * a module waiting and no explanation at all. That is the thing to fix here:
 * not the arithmetic, which is right, but the silence.
 *
 * So this says, in plain words, what happened, and it says the reassuring part
 * FIRST, because "you are not finished any more" is the fear: the certificate
 * they already hold is still valid, and always will be.
 *
 * Every fact on it is decided by the server (GET /api/track: `grownSince`,
 * `completedAt`, `completedCount`, `currentCount`). The browser works nothing
 * out — it does not compare counts, and it never shows the notice on a
 * completion whose size the server could not vouch for.
 *
 * No training content lives here. The academy's own name comes from the API.
 */

function plural(n, word) {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * One grown section.
 *
 * `outstanding` is how many of its stages the trainee still has to pass. It is
 * normally the new ones — but it can be zero, if the module went live before
 * the academy started recording what a completion covered and they have
 * already done it. Telling somebody in that position to "finish the new
 * module" would be nonsense, so that case gets its own line.
 */
function GrownItem({ name, noun, completedAt, completedCount, currentCount, outstanding }) {
  return (
    <li className="mt-3 first:mt-0">
      <p className="text-[14px] font-semibold text-navy">{name}</p>
      <p className="mt-0.5 text-[13.5px] text-muted">
        You finished this on {shortDate(completedAt)}, when it had {plural(completedCount, noun)}.
        It now has {String(currentCount)}.{' '}
        {outstanding > 0
          ? `Pass the ${plural(outstanding, `new ${noun}`)} and you will be issued an up-to-date certificate.`
          : `You have already passed everything in it — pass any of its quizzes again and your up-to-date certificate is issued.`}
      </p>
    </li>
  );
}

/**
 * @param items one entry per section that has grown, in the order they appear
 *   on the dashboard. An empty list renders nothing at all.
 */
export default function AcademyGrownNotice({ items = [] }) {
  if (items.length === 0) return null;

  return (
    <section
      className={`${cardClass} mb-6 flex flex-wrap items-start gap-4 border-l-4 border-l-orange p-5`}
      aria-labelledby="training-grown"
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-soft text-xl"
      >
        🆕
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="training-grown" className="font-display text-[17px] font-bold text-navy">
          {items.length === 1 ? 'This has grown since you finished it' : 'Your training has grown'}
        </h2>
        <p className="mt-0.5 text-[13.5px] text-muted">
          The certificate you already hold is still valid and stays valid.
        </p>
        <ul className="mt-3">
          {items.map(({ key, ...item }) => (
            <GrownItem key={key} {...item} />
          ))}
        </ul>
      </div>
    </section>
  );
}
