import AppShell from '../components/AppShell.jsx';

// Decision D13: signed in, but no training programme assigned yet. The
// AuthProvider re-checks /api/me every 60 s, so this page swaps itself for
// the real one as soon as a manager assigns a track.
export default function WaitingForTrack() {
  return (
    <AppShell>
      <section className="rounded-card border border-line bg-card p-6 shadow-card">
        <h2 className="text-lg font-semibold">You&apos;re signed in.</h2>
        <p className="mt-2 text-muted">
          Your manager will assign your training programme shortly — you&apos;ll see it here as soon
          as they do.
        </p>
      </section>
    </AppShell>
  );
}
