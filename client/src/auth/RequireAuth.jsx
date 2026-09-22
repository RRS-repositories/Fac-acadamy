import { Navigate, useLocation } from 'react-router-dom';
import AuthStatusScreen from '../components/AuthStatusScreen.jsx';
import WaitingForTrack from '../pages/WaitingForTrack.jsx';
import { useAuth } from './AuthProvider.jsx';

/**
 * Signed-in pages only. Signed-out visitors go to /login?next=<this page>.
 * Someone signed in without a track sees the waiting screen (D13) unless
 * `requireTrack` is false. The server still enforces every rule itself.
 */
export default function RequireAuth({ children, requireTrack = true }) {
  const { me, status, error, refetch } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <AuthStatusScreen title="Loading…" busy />;
  }
  if (status === 'error') {
    if (error?.code === 'flag_off') {
      return <AuthStatusScreen title="The training portal isn't open yet." />;
    }
    return (
      <AuthStatusScreen
        title="We couldn't check your sign-in."
        message="Please try again shortly."
        action={{ label: 'Try again', onClick: () => refetch() }}
      />
    );
  }
  if (!me) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (requireTrack && me.track === null) {
    return <WaitingForTrack />;
  }
  return children;
}
