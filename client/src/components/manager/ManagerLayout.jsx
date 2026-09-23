import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { EXPORT_CSV_PATH } from '../../api/manager.js';
import { sidebarGradient } from '../training/styles.js';

/*
 * The management shell: the same navy sidebar as the training app, with the
 * stage rail replaced by the manager's own navigation. It renders only inside
 * <RequireManager>, so nothing in here is ever built for a staff session.
 *
 * The CSV export is a plain link with `download`: the endpoint is a same-origin
 * authenticated GET that the server generates and audits, so the browser can
 * fetch it itself — no blob, no second copy of the roster in memory.
 */

const navLink =
  'block rounded-[10px] px-3.5 py-2.5 text-[13.5px] font-semibold transition-colors ' +
  'hover:bg-white/8 hover:text-white';

function Item({ to, end = false, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `${navLink} ${isActive ? 'bg-orange/15 text-white' : 'text-white/70'}`
      }
    >
      {children}
    </NavLink>
  );
}

export default function ManagerLayout({ title, children }) {
  const { me, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await logout();
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[296px_1fr]">
      <aside
        style={sidebarGradient}
        className="flex flex-col py-6 text-white lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto"
      >
        <Link
          to="/manager"
          className="flex items-center gap-3 px-6 font-display text-lg font-extrabold"
        >
          <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded bg-orange" />
          <span>
            FAC Academy
            <small className="mt-0.5 block font-sans text-[10.5px] font-medium tracking-[0.12em] text-white/50 uppercase">
              Management
            </small>
          </span>
        </Link>

        <div className="mt-5 mr-6 mb-1.5 ml-6 rounded-xl border border-white/12 bg-white/7 px-4 py-3">
          <span className="block text-sm leading-tight font-bold">{me?.fullName}</span>
          <span className="block text-[11.5px] text-white/60">Manager</span>
        </div>

        <nav aria-label="Management" className="mt-4 flex flex-col gap-1 px-3">
          <Item to="/manager" end>
            Trainee roster
          </Item>
          <Item to="/manager/stuck">Needs attention</Item>
          <Item to="/manager/preview">Preview a track</Item>
          <a
            href={EXPORT_CSV_PATH}
            download
            data-testid="export-csv"
            className={`${navLink} text-white/70`}
          >
            Download CSV
          </a>
        </nav>

        <div className="flex-1" />

        <div className="mt-4 border-t border-white/10 px-6 pt-4 text-[11px] text-white/40">
          <Link to="/" className="mb-2.5 block text-[12.5px] font-semibold text-white/65 underline">
            My own training
          </Link>
          <Link
            to="/status-guide"
            className="mb-2.5 block text-[12.5px] font-semibold text-white/65 underline"
          >
            Status Guide
          </Link>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="mb-2.5 block text-[12.5px] font-semibold text-white/65 underline disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          Fast Action Claims — staff training
        </div>
      </aside>

      {/*
        min-w-0: a grid track is min-content-sized by default, so a wide table
        inside it would push the whole document sideways. The roster's own
        scroll box handles the width instead, and the page never scrolls
        horizontally at any viewport size.
      */}
      <main className="w-full min-w-0 max-w-[1320px] px-5 py-6 lg:px-11 lg:pt-[34px] lg:pb-[70px]">
        {title ? <h1 className="mb-5 font-display text-[26px] font-bold">{title}</h1> : null}
        {children}
      </main>
    </div>
  );
}
