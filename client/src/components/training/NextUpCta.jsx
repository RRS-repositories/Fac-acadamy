import { Link } from 'react-router-dom';
import { btnPrimary, pulseClass } from './styles.js';

/*
 * The flashing "start the next module" call to action.
 *
 * The prototype's .pulse-cta animates box-shadow only — never a transform —
 * so the button never moves under the pointer. prefers-reduced-motion switches
 * every animation off globally in styles/index.css, which leaves a plain
 * orange button.
 *
 * It is a real link, so it is keyboard operable and opens in a new tab like
 * any other. `data-pulse="next-up"` marks the one pulsing element on the page.
 */
export default function NextUpCta({ to, children, showTag = false, className = '' }) {
  return (
    <div className={className}>
      {showTag ? (
        <span className="mb-2 inline-block rounded-full bg-orange px-2.5 py-1 text-[10.5px] font-extrabold tracking-[0.08em] text-white uppercase">
          ▶ Next up
        </span>
      ) : null}
      <Link to={to} data-pulse="next-up" className={`${btnPrimary} ${pulseClass}`}>
        {children}
      </Link>
    </div>
  );
}
