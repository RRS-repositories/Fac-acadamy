import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiError, fetchMe, heartbeatRequest, logoutRequest } from '../api/client.js';

// Who is signed in. The server owns the session (HttpOnly cookie); the browser
// only asks GET /api/me. A 401 there means "signed out", not an error.

export const ME_QUERY_KEY = ['me'];
export const HEARTBEAT_MS = 60_000;
// While the user waits for a track (D13), re-check /api/me this often.
export const WAITING_RECHECK_MS = 60_000;

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const meQuery = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.track === null ? WAITING_RECHECK_MS : false),
  });

  const me = meQuery.data ?? null;
  const signedIn = Boolean(me);

  let status = 'loading';
  if (meQuery.isSuccess) status = me ? 'signedIn' : 'signedOut';
  else if (meQuery.isError) status = 'error';

  const setMe = useCallback(
    (next) => queryClient.setQueryData(ME_QUERY_KEY, next ?? null),
    [queryClient],
  );

  const signOutLocally = useCallback(() => {
    // Drop everything cached for this user, but keep the `me` query alive.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
    setMe(null);
  }, [queryClient, setMe]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Signed out on this device either way; the server session expires.
    }
    navigate('/login', { replace: true });
    signOutLocally();
  }, [navigate, signOutLocally]);

  // Keep the session alive while the tab is visible and someone is signed in.
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      heartbeatRequest().catch((error) => {
        if (error instanceof ApiError && error.status === 401) signOutLocally();
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [signedIn, signOutLocally]);

  const { error, refetch } = meQuery;
  const value = useMemo(
    () => ({ me, status, error: error ?? null, refetch, setMe, logout }),
    [me, status, error, refetch, setMe, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
