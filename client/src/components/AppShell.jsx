import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';

// Header + page frame for signed-in pages, with the sign-out button.
export default function AppShell({ children }) {
  const { logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await logout();
    // logout() navigates away, so this component is usually gone by now.
  }

  return (
    <div className="min-h-screen">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded bg-orange" />
          <h1 className="font-display text-xl font-bold tracking-wide text-white">FAC Academy</h1>
          <Link
            to="/status-guide"
            className="ml-auto rounded-lg px-3.5 py-1.5 text-sm font-semibold text-white/85 hover:bg-white/10 hover:text-white"
          >
            Status Guide
          </Link>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="rounded-lg border border-white/40 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
