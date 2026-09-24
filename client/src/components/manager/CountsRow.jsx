import { cardClass } from '../training/styles.js';

/*
 * The five numbers across the top of the roster. They come from the server's
 * `counts` block, so they describe the whole roster whatever the manager has
 * typed into the search box.
 */

const TILES = [
  { key: 'total', label: 'Trainees', hint: 'Everyone with an academy account' },
  { key: 'active', label: 'Active', hint: 'Accounts that can sign in' },
  { key: 'onlineNow', label: 'Online now', hint: 'Seen in the last 3 minutes' },
  { key: 'waitingForTrack', label: 'Waiting for a track', hint: 'No programme assigned yet' },
  { key: 'disabled', label: 'Disabled', hint: 'Signed out and blocked' },
];

export default function CountsRow({ counts }) {
  return (
    <dl
      aria-label="Roster totals"
      data-testid="counts"
      className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
    >
      {TILES.map((tile) => (
        <div key={tile.key} className={`${cardClass} px-4 py-3.5`}>
          <dt className="text-[11px] font-bold tracking-[0.08em] text-muted uppercase">
            {tile.label}
          </dt>
          <dd className="mt-1 font-display text-[26px] leading-none font-extrabold text-navy tabular-nums">
            {counts?.[tile.key] ?? 0}
          </dd>
          <p className="mt-1.5 text-[11.5px] text-muted">{tile.hint}</p>
        </div>
      ))}
    </dl>
  );
}
