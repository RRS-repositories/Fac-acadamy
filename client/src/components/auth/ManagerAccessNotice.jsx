import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/*
 * One calm line for someone who chose the Manager tab on the sign-in card but
 * whose CRM account is not a manager. They are signed in normally and this is
 * their training — it is not an error and not a refusal.
 *
 * It says nothing about who does have management access, so it leaks nothing.
 * The sign-in page sets `state.managerAccess` on the redirect; the live region
 * is always mounted so the line is announced when it appears.
 */

export const NO_MANAGER_ACCESS = 'unavailable';

export default function ManagerAccessNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const show = location.state?.managerAccess === NO_MANAGER_ACCESS && !dismissed;

  function dismiss() {
    setDismissed(true);
    // Drop the flag from this history entry so going back doesn't repeat it.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-5"
    >
      {show ? (
        <div className="pointer-events-auto flex max-w-[620px] items-center gap-3.5 rounded-xl bg-navy px-5 py-3.5 text-[13.5px] text-white shadow-[0_10px_30px_rgba(14,35,56,0.35)]">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-orange" />
          <p className="min-w-0">
            You&apos;re signed in. This account doesn&apos;t have management access, so here is your
            training.
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="ml-auto shrink-0 rounded-lg border border-white/40 px-3 py-1 text-[12.5px] font-semibold hover:bg-white/10"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
