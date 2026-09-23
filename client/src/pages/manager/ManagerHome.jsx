import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TRACKS } from '@fac-academy/shared';
import { useAuth } from '../../auth/AuthProvider.jsx';
import ManagerLayout from '../../components/manager/ManagerLayout.jsx';
import CountsRow from '../../components/manager/CountsRow.jsx';
import ConfigStrip from '../../components/manager/ConfigStrip.jsx';
import RosterTable from '../../components/manager/RosterTable.jsx';
import { ErrorNotice } from '../../components/manager/Notice.jsx';
import {
  EXPORT_CSV_PATH,
  ROSTER_REFRESH_MS,
  useManagerConfig,
  useRoster,
  useStuck,
} from '../../api/manager.js';
import { btnGhost, btnSmall, cardClass } from '../../components/training/styles.js';

/*
 * The management dashboard (Section 07 task 1): every trainee, live.
 *
 * The roster is fetched once and refreshed every 30 seconds. Search, the track
 * filter and the disabled switch narrow the rows in the browser, so typing
 * costs no request and the table never empties or jumps while the manager is
 * reading it. The counts row always describes the whole roster, because it is
 * the server's own summary.
 */

const ALL = 'ALL';
const NO_TRACK = 'NONE';

function matches(trainee, needle) {
  return `${trainee.fullName ?? ''} ${trainee.email ?? ''}`.toLowerCase().includes(needle);
}

export default function ManagerHome() {
  const { me } = useAuth();
  const roster = useRoster();
  const stuck = useStuck();
  const config = useManagerConfig();
  const [query, setQuery] = useState('');
  const [track, setTrack] = useState(ALL);
  const [showDisabled, setShowDisabled] = useState(true);
  const searchId = useId();
  const trackId = useId();

  const trainees = useMemo(() => roster.data?.trainees ?? [], [roster.data]);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      trainees.filter((trainee) => {
        if (!showDisabled && trainee.isDisabled) return false;
        if (track === NO_TRACK && trainee.track) return false;
        if (track !== ALL && track !== NO_TRACK && trainee.track !== track) return false;
        return needle === '' || matches(trainee, needle);
      }),
    [trainees, needle, track, showDisabled],
  );

  const stuckCount = stuck.data?.trainees?.length ?? 0;
  const filtered = rows.length !== trainees.length;

  return (
    <ManagerLayout title="Trainee roster">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <p className="text-[13.5px] text-muted">
          Live view — refreshes every {Math.round(ROSTER_REFRESH_MS / 1000)} seconds.
        </p>
        <a
          href={EXPORT_CSV_PATH}
          download
          data-testid="export-csv-button"
          className={`${btnGhost} ${btnSmall} ml-auto`}
        >
          Download CSV
        </a>
      </div>

      <CountsRow counts={roster.data?.counts} />

      {stuckCount > 0 ? (
        <p className={`${cardClass} mb-5 border-l-4 border-l-red px-5 py-3.5 text-[13.5px]`}>
          <strong className="font-semibold text-navy">
            {stuckCount} trainee{stuckCount === 1 ? '' : 's'} need{stuckCount === 1 ? 's' : ''} a
            nudge
          </strong>{' '}
          — repeated fails or a week of silence.{' '}
          <Link to="/manager/stuck" className="font-semibold text-navy underline">
            See who
          </Link>
        </p>
      ) : null}

      <section className={`${cardClass} overflow-hidden`}>
        <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-4">
          <div className="min-w-[220px] flex-1">
            <label htmlFor={searchId} className="mb-1 block text-[12px] font-bold text-muted">
              Search
            </label>
            <input
              id={searchId}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or email…"
              className="w-full rounded-[10px] border-[1.5px] border-line bg-card px-3.5 py-2.5 text-sm text-ink focus:border-orange"
            />
          </div>
          <div>
            <label htmlFor={trackId} className="mb-1 block text-[12px] font-bold text-muted">
              Track
            </label>
            <select
              id={trackId}
              value={track}
              onChange={(event) => setTrack(event.target.value)}
              className="rounded-[10px] border-[1.5px] border-line bg-card px-3 py-2.5 text-sm font-semibold text-ink focus:border-orange"
            >
              <option value={ALL}>All tracks</option>
              <option value={NO_TRACK}>Waiting for a track</option>
              {TRACKS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2.5 text-[13px] font-semibold text-ink">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(event) => setShowDisabled(event.target.checked)}
              className="h-4 w-4 accent-orange"
            />
            Show disabled accounts
          </label>
          <p aria-live="polite" className="pb-2.5 text-[12.5px] font-semibold text-muted">
            {filtered ? `${rows.length} of ${trainees.length} shown` : `${rows.length} shown`}
          </p>
        </div>

        {roster.isError ? (
          <div className="p-5">
            <ErrorNotice error={roster.error} what="the roster" onRetry={() => roster.refetch()} />
          </div>
        ) : roster.isPending ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Loading the roster…</p>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="font-display text-base font-bold text-navy">
              {trainees.length === 0 ? 'No trainees yet.' : 'Nobody matches those filters.'}
            </p>
            <p className="mt-1.5 text-[13.5px] text-muted">
              {trainees.length === 0
                ? 'Accounts appear here the first time a member of staff signs in to the academy.'
                : 'Try a shorter search, or clear the filters to see everyone.'}
            </p>
            {trainees.length === 0 ? null : (
              <button
                type="button"
                className={`${btnGhost} ${btnSmall} mt-4`}
                onClick={() => {
                  setQuery('');
                  setTrack(ALL);
                  setShowDisabled(true);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <RosterTable
            trainees={rows}
            selfId={me?.id ?? null}
            // Our gate is off, so the column would be a pill that means
            // nothing. It appears the day STAGE1_AUTH_REQUIRED does.
            showStage1Auth={config.data?.stage1AuthRequired === true}
          />
        )}
      </section>

      <ConfigStrip config={config.data} />
    </ManagerLayout>
  );
}
