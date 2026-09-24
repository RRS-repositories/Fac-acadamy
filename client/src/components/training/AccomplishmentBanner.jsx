import { Link } from 'react-router-dom';
import { cardClass } from './styles.js';

/*
 * The accomplishment banner on the dashboard (S09, task 1).
 *
 * The prototype congratulates a trainee when a level or an academy is
 * finished — "You are ready to start work", "Certified DSAR Reviewer". Those
 * words live in the database (academy.levels.accomplishment and
 * academy.departments.accomplishment, seeded from the approved prototype in
 * S02) and reach this component through the certificates API. Nothing here
 * invents or repeats any of it: if the server sends no accomplishment line,
 * the banner shows the title alone.
 *
 * It shows the most recent certificate, with a count when there are more.
 */
export default function AccomplishmentBanner({ certificates = [] }) {
  const earned = certificates.filter((c) => !c.revoked);
  if (earned.length === 0) return null;

  const latest = earned[0];
  const others = earned.length - 1;

  return (
    <section
      className={`${cardClass} mb-6 flex flex-wrap items-center gap-4 border-l-4 border-l-green p-5`}
      aria-label="Your latest accomplishment"
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-soft text-xl"
      >
        🎓
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-semibold tracking-[0.14em] text-green uppercase">
          Completed
        </p>
        <p className="font-display text-[17px] font-bold text-navy">{latest.title}</p>
        {latest.accomplishment ? (
          <p className="mt-0.5 text-[14px] font-semibold text-orange">{latest.accomplishment}</p>
        ) : null}
      </div>
      <Link
        to="/certificates"
        className="shrink-0 rounded-[10px] border-[1.5px] border-line px-4 py-2.5 text-[13.5px] font-bold text-navy hover:border-navy hover:bg-white"
      >
        {others > 0 ? `View ${String(earned.length)} certificates` : 'View certificate'}
      </Link>
    </section>
  );
}
