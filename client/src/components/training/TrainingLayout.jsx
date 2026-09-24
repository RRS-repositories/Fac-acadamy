import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TRACKS } from '@fac-academy/shared';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { useTrack } from '../../api/training.js';
import ProgressBar from './ProgressBar.jsx';
import Rail from './Rail.jsx';
import { sidebarGradient } from './styles.js';

/*
 * The signed-in training shell: the navy sidebar (brand, user chip, overall
 * progress, stage rail, sign out) beside the page. Every training screen —
 * dashboard, stage, lesson, quiz, status guide — renders inside it, so the
 * rail is always there and always shows where the trainee is.
 *
 * The rail reads the same /api/track query as the dashboard, so it costs no
 * extra request. If that query has not answered yet (or failed), the shell
 * still renders and the rail is simply absent.
 */

function initials(fullName) {
  const parts = String(fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

export default function TrainingLayout({ currentCode = null, children }) {
  const { me, logout } = useAuth();
  const { data } = useTrack();
  const [signingOut, setSigningOut] = useState(false);

  const stages = data?.stages ?? [];
  const passed = stages.filter((s) => s.state === 'done').length;
  const overall = stages.length > 0 ? Math.round((passed / stages.length) * 100) : 0;
  const trackLabel = TRACKS.find((t) => t.code === me?.track)?.label ?? me?.track ?? '';

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
        <Link to="/" className="flex items-center gap-3 px-6 font-display text-lg font-extrabold">
          <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded bg-orange" />
          <span>
            FAC Academy
            <small className="mt-0.5 block font-sans text-[10.5px] font-medium tracking-[0.12em] text-white/50 uppercase">
              Training portal
            </small>
          </span>
        </Link>

        <div className="mt-5 mr-6 mb-1.5 ml-6 flex items-center gap-3 rounded-xl border border-white/12 bg-white/7 px-4 py-3">
          <span
            aria-hidden="true"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-orange font-display text-[15px] font-extrabold"
          >
            {initials(me?.fullName)}
          </span>
          <span className="min-w-0">
            <span className="block text-sm leading-tight font-bold">{me?.fullName}</span>
            <span className="block text-[11.5px] text-white/60">{trackLabel}</span>
          </span>
        </div>

        <div className="mx-6 mt-3.5 mb-5">
          <div className="mb-2 flex justify-between text-[11.5px] font-semibold tracking-[0.08em] text-white/55 uppercase">
            <span>Overall progress</span>
            <b className="tracking-normal text-orange">{overall}%</b>
          </div>
          <ProgressBar value={overall} tone="light" label="Overall progress" />
        </div>

        {stages.length > 0 ? (
          <div className="hidden lg:block">
            <Rail stages={stages} currentCode={currentCode} levelHeadings={data?.levels ?? []} />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="mt-4 border-t border-white/10 px-6 pt-4 text-[11px] text-white/40">
          {/* Managers reach their own area from their own training screens.
              A staff session never renders this link — and the route behind it
              renders nothing for them either. */}
          {me?.role === 'MANAGER' ? (
            <Link
              to="/manager"
              className="mb-2.5 block text-[12.5px] font-semibold text-white/65 underline"
            >
              Management
            </Link>
          ) : null}
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

      <main className="w-full max-w-[1060px] px-5 py-6 lg:px-11 lg:pt-[34px] lg:pb-[70px]">
        {children}
      </main>
    </div>
  );
}
