import { Link } from 'react-router-dom';
import { btnGhost, cardClass } from './styles.js';

/*
 * The prototype's .lock-panel: what a trainee sees when they reach a stage
 * they have not unlocked (including by typing the URL). It never renders any
 * of the stage's content — the 403 body carries none.
 */
export default function LockedCard({ title, message, backTo = '/' }) {
  return (
    <section className={`${cardClass} px-8 py-14 text-center`}>
      <div aria-hidden="true" className="mb-3 text-[40px] leading-none">
        🔒
      </div>
      <h1 className="text-[19px] font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-[420px] text-sm text-muted">{message}</p>
      <div className="mt-6">
        <Link to={backTo} className={btnGhost}>
          ← Back to your dashboard
        </Link>
      </div>
    </section>
  );
}
