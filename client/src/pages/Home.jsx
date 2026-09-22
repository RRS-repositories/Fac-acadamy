import { TRACKS } from '@fac-academy/shared';
import AppShell from '../components/AppShell.jsx';
import { useAuth } from '../auth/AuthProvider.jsx';

function firstName(fullName) {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

// Placeholder dashboard until the learner pages land. Behind <RequireAuth>, so
// `me` is always set and has a track here.
export default function Home() {
  const { me } = useAuth();
  const track = TRACKS.find((t) => t.code === me.track);

  return (
    <AppShell>
      <section className="rounded-card border border-line bg-card p-6 shadow-card">
        <h2 className="text-lg font-semibold">Welcome, {firstName(me.fullName)}</h2>
        <p className="mt-2 text-muted">
          Your programme: <b className="text-ink">{track ? track.label : me.track}</b>
        </p>
      </section>
    </AppShell>
  );
}
