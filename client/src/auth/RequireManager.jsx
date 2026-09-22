import AppShell from '../components/AppShell.jsx';
import RequireAuth from './RequireAuth.jsx';
import { useAuth } from './AuthProvider.jsx';

function ManagerOnly({ children }) {
  const { me } = useAuth();
  if (me.role !== 'MANAGER') {
    return (
      <AppShell>
        <section className="rounded-card border border-line bg-card p-6 shadow-card">
          <h2 className="text-lg font-semibold">You don&apos;t have access to this page</h2>
        </section>
      </AppShell>
    );
  }
  return children;
}

/**
 * Manager pages only. Staff see a plain "no access" message and nothing else.
 * Managers don't need a track to use the management area. The server checks
 * the role on every manager API call regardless.
 */
export default function RequireManager({ children }) {
  return (
    <RequireAuth requireTrack={false}>
      <ManagerOnly>{children}</ManagerOnly>
    </RequireAuth>
  );
}
