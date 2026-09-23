import { useEffect, useId, useState } from 'react';
import { TRACKS } from '@fac-academy/shared';
import { useAssignTrack, useSetDisabled } from '../../api/manager.js';
import { btnGhost, btnNavy, btnSmall } from '../training/styles.js';

/*
 * The two account controls, used by the roster row and by the trainee page.
 *
 * Disabling asks first — it signs the person out within seconds — and the
 * confirmation is an in-page step rather than a browser dialog, so it is
 * keyboard-reachable and reads properly to a screen reader. Once confirmed the
 * row changes at once (optimistic) and the roster is refetched, so the screen
 * ends up agreeing with the server either way.
 *
 * Assigning a track is deliberate too: pick from the nine, then press Assign.
 * A stray arrow key on a focused select must never move someone's programme.
 */

const smallGhost = `${btnGhost} ${btnSmall}`;
const smallNavy = `${btnNavy} ${btnSmall}`;

export default function TraineeActions({ trainee, layout = 'row' }) {
  const setDisabled = useSetDisabled();
  const assign = useAssignTrack();
  const [confirming, setConfirming] = useState(false);
  const [choice, setChoice] = useState(trainee.track ?? '');
  const selectId = useId();

  // A refresh (or another manager) may move the track under us; follow it,
  // unless this manager is mid-choice.
  const serverTrack = trainee.track ?? '';
  useEffect(() => {
    setChoice(serverTrack);
  }, [serverTrack]);

  const disabled = Boolean(trainee.isDisabled);
  const busy = setDisabled.isPending || assign.isPending;
  const changed = choice !== serverTrack && choice !== '';

  function toggleAccount() {
    setConfirming(false);
    setDisabled.mutate({ id: trainee.id, disabled: !disabled });
  }

  return (
    <div className={layout === 'row' ? 'flex flex-wrap items-center gap-2' : 'flex flex-col gap-3'}>
      {confirming ? (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-bg px-2.5 py-1.5">
          <span className="text-[12.5px] font-semibold text-navy">
            Disable {trainee.fullName}? They are signed out straight away.
          </span>
          <button type="button" className={smallNavy} onClick={toggleAccount} disabled={busy}>
            Yes, disable
          </button>
          <button type="button" className={smallGhost} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={smallGhost}
          disabled={busy}
          onClick={() => (disabled ? toggleAccount() : setConfirming(true))}
        >
          {disabled ? 'Re-enable' : 'Disable'}
        </button>
      )}

      <span className="inline-flex items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          Track for {trainee.fullName}
        </label>
        <select
          id={selectId}
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value)}
          className="rounded-[10px] border-[1.5px] border-line bg-card px-2.5 py-[7px] text-xs font-semibold text-ink focus:border-orange"
        >
          <option value="">No track yet</option>
          {TRACKS.map((track) => (
            <option key={track.code} value={track.code}>
              {track.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={smallNavy}
          disabled={!changed || busy}
          onClick={() => assign.mutate({ id: trainee.id, track: choice })}
        >
          Assign
        </button>
      </span>

      {setDisabled.isError || assign.isError ? (
        <span role="status" className="text-[12px] font-semibold text-red">
          That didn&apos;t save. Please try again.
        </span>
      ) : null}
    </div>
  );
}
