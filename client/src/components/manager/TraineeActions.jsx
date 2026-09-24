import { useEffect, useId, useState } from 'react';
import { TRACKS } from '@fac-academy/shared';
import { actionErrorMessage, useAssignTrack, useSetDisabled } from '../../api/manager.js';
import { btnGhost, btnSmall } from '../training/styles.js';

/*
 * The two account controls, used by the roster row and by the trainee page.
 *
 * Disabling asks first — it signs the person out within seconds — and the
 * confirmation is an in-page step rather than a browser dialog, so it is
 * keyboard-reachable and reads properly to a screen reader. Once confirmed the
 * row changes at once (optimistic) and the roster is refetched, so the screen
 * ends up agreeing with the server either way.
 *
 * The manager's OWN row gets no Disable button at all. The server refuses
 * self-disable (400 invalid_request) so that nobody can lock themselves out,
 * and offering a button that can only fail was the whole of the "That didn't
 * save" report. The cell reads "Your account" instead (the row is badged "You"
 * beside the name) — and it can still be given a track, because managers take
 * the training too.
 *
 * Assigning a track is deliberate: pick from the nine, then press Assign. A
 * stray arrow key on a focused select must never move someone's programme.
 *
 * "No track yet" is a real choice, not a dead option. A manager could put
 * someone on the wrong programme and had no way to take it back — the button
 * simply stayed grey. Picking it now enables the button, which reads REMOVE,
 * and that asks first in the same in-page way as Disable, because the sentence
 * is the point: the trainee goes back to the waiting screen and keeps every
 * stage they have already passed. Nothing is deleted; progress is kept per
 * stage, and the track only decides which stages they can see.
 */

const smallGhost = `${btnGhost} ${btnSmall}`;
/** The prototype's .btn-danger: Disable is the one red control on the page. */
const dangerButton =
  'inline-flex items-center justify-center rounded-lg bg-red px-[13px] py-[7px] text-xs font-bold ' +
  'text-white transition-colors hover:bg-[#a51f1f] disabled:cursor-not-allowed disabled:opacity-[0.45]';
const confirmStrip =
  'inline-flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-bg px-2.5 py-1.5';
const confirmText = 'text-[12.5px] font-semibold text-navy';

export default function TraineeActions({ trainee, layout = 'row', isSelf = false }) {
  const setDisabled = useSetDisabled();
  const assign = useAssignTrack();
  // One confirmation at a time: null, 'disable' or 'removeTrack'.
  const [confirming, setConfirming] = useState(null);
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
  // The button does something only when the select differs from what the
  // server holds. '' is "no track": a real change when they have one, and
  // nothing at all when they do not — so someone who has never been given a
  // programme still sees a greyed-out "Assign", never a "Remove".
  const canSubmit = choice !== serverTrack;
  const removing = choice === '' && serverTrack !== '';
  const failure = setDisabled.error ?? assign.error ?? null;

  function toggleAccount() {
    setConfirming(null);
    setDisabled.mutate({ id: trainee.id, disabled: !disabled });
  }

  function submitTrack() {
    setConfirming(null);
    assign.mutate({ id: trainee.id, track: choice === '' ? null : choice });
  }

  return (
    <div className={layout === 'row' ? 'flex flex-wrap items-center gap-2' : 'flex flex-col gap-3'}>
      {isSelf ? (
        <span
          data-testid="own-row-marker"
          className="inline-flex items-center rounded-md bg-[#EEF1F5] px-2.5 py-1 text-[11.5px] font-semibold text-muted"
        >
          Your account
        </span>
      ) : confirming === 'disable' ? (
        <span className={confirmStrip}>
          <span className={confirmText}>
            Disable {trainee.fullName}? They are signed out straight away.
          </span>
          <button type="button" className={dangerButton} onClick={toggleAccount} disabled={busy}>
            Yes, disable
          </button>
          <button type="button" className={smallGhost} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={disabled ? smallGhost : dangerButton}
          disabled={busy}
          onClick={() => (disabled ? toggleAccount() : setConfirming('disable'))}
        >
          {disabled ? 'Re-enable' : 'Disable'}
        </button>
      )}

      {confirming === 'removeTrack' ? (
        <span className={confirmStrip} data-testid="remove-track-confirm">
          <span className={confirmText}>
            Remove {trainee.fullName}&rsquo;s programme? They&rsquo;ll see &ldquo;waiting for a
            manager&rdquo; and keep everything they&rsquo;ve already completed.
          </span>
          <button type="button" className={dangerButton} onClick={submitTrack} disabled={busy}>
            Yes, remove
          </button>
          <button
            type="button"
            className={smallGhost}
            onClick={() => {
              // Cancelling puts the select back to what the server holds, so a
              // half-made change cannot sit on screen looking like a fact.
              setChoice(serverTrack);
              setConfirming(null);
            }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            Track for {trainee.fullName}
          </label>
          <select
            id={selectId}
            value={choice}
            disabled={busy}
            onChange={(event) => setChoice(event.target.value)}
            className="max-w-[128px] rounded-[10px] border-[1.5px] border-line bg-card px-2.5 py-[7px] text-xs font-semibold text-ink focus:border-orange"
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
            className={smallGhost}
            disabled={!canSubmit || busy}
            onClick={() => (removing ? setConfirming('removeTrack') : submitTrack())}
          >
            {removing ? 'Remove' : 'Assign'}
          </button>
        </span>
      )}

      {failure ? (
        <span role="status" className="max-w-[220px] text-[12px] font-semibold text-red">
          {actionErrorMessage(failure)}
        </span>
      ) : null}
    </div>
  );
}
