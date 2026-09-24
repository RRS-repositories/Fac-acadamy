import { useId, useMemo, useState } from 'react';
import TrainingLayout from '../../components/training/TrainingLayout.jsx';
import { useStatusGuide } from '../../api/statusGuide.js';

// The Status Guide reference page (S05), the standalone version of the
// prototype's searchable guide: the CRM status on the left, the firm's
// client-friendly line under it.
//
// Every row comes from GET /api/status-guide at runtime. No status and no
// client line is written into this file or into the bundle.
//
// The search filters in place: it is state, never a route change and never a
// scroll, so the page stays exactly where the reader left it (scroll rule,
// SECTION 05 task 3).

/** Case-insensitive match on the status and on the client line, as the prototype does. */
function matchesQuery(row, needle) {
  return `${row.status} ${row.clientLine}`.toLowerCase().includes(needle);
}

export default function StatusGuide() {
  const [query, setQuery] = useState('');
  const { data, status, error, refetch } = useStatusGuide();
  const inputId = useId();

  const rows = useMemo(() => data ?? [], [data]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle === '' ? rows : rows.filter((row) => matchesQuery(row, needle))),
    [rows, needle],
  );

  return (
    <TrainingLayout>
      <section className="rounded-card border border-line bg-card p-6 shadow-card sm:px-8 sm:py-7">
        <h2 className="font-display text-xl font-bold">The Status Guide</h2>
        <p className="mt-2 text-[13.5px] text-muted">
          Every CRM status, with the line to give the client. Type to search — the list filters as
          you go.
        </p>

        <form role="search" className="mt-5" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor={inputId} className="sr-only">
            Search the status guide
          </label>
          <input
            id={inputId}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type to search a status…"
            className="w-full rounded-[10px] border-[1.5px] border-line bg-card px-[15px] py-3 text-sm text-ink focus:border-orange"
          />
        </form>

        {status === 'pending' && (
          <p className="mt-4 text-sm text-muted">Loading the status guide…</p>
        )}

        {status === 'error' && (
          <div className="mt-4 rounded-[10px] border-l-4 border-red bg-red-soft px-4 py-3 text-sm">
            <p className="font-semibold text-ink">We couldn&apos;t load the status guide.</p>
            <p className="mt-1 text-muted">
              {error?.code === 'flag_off'
                ? "The training portal isn't open yet."
                : 'Please try again shortly.'}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-3 rounded-[10px] border-[1.5px] border-line bg-card px-4 py-2 text-sm font-bold text-navy hover:border-navy"
            >
              Try again
            </button>
          </div>
        )}

        {status === 'success' && (
          <>
            <p aria-live="polite" className="mt-4 text-xs font-semibold tracking-wide text-muted">
              {matches.length === rows.length
                ? `${rows.length} statuses`
                : `${matches.length} of ${rows.length} statuses`}
            </p>

            {matches.length === 0 ? (
              <div className="mt-3 rounded-[10px] border border-line bg-bg px-[15px] py-6 text-center">
                <p className="text-sm font-semibold text-navy">No status matches your search.</p>
                <p className="mt-1 text-[13.5px] text-muted">
                  Try a shorter word, or clear the search to see every status.
                </p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-3 rounded-[10px] border-[1.5px] border-line bg-card px-4 py-2 text-sm font-bold text-navy hover:border-navy"
                >
                  Clear search
                </button>
              </div>
            ) : (
              <ul className="mt-3 list-none">
                {matches.map((row) => (
                  <li
                    key={row.status}
                    className="mb-[9px] rounded-[10px] border border-line px-[15px] py-3"
                  >
                    <p className="text-[13.5px] font-bold text-navy">{row.status}</p>
                    <p className="mt-[3px] text-[13.5px] text-muted">{row.clientLine}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </TrainingLayout>
  );
}
