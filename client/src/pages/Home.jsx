import { useHealth } from '../api/client.js';

function ApiStatus() {
  const { isPending, isError, data } = useHealth();

  let text = 'Checking API…';
  let tone = 'text-muted';
  if (!isPending) {
    if (!isError && data?.ok) {
      text = 'API reachable';
      tone = 'text-green';
    } else {
      text = 'API not reachable';
      tone = 'text-red';
    }
  }

  return (
    <p role="status" className={`text-sm font-medium ${tone}`}>
      {text}
    </p>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded bg-orange" />
          <h1 className="font-display text-xl font-bold tracking-wide text-white">FAC Academy</h1>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">
        <section className="rounded-card border border-line bg-card p-6 shadow-card">
          <h2 className="text-lg font-semibold">Training portal — under construction</h2>
          <div className="mt-3">
            <ApiStatus />
          </div>
        </section>
      </main>
    </div>
  );
}
