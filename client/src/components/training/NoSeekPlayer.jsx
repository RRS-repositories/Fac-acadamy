import { useCallback, useEffect, useRef, useState } from 'react';
import { MEDIA_BEACON_INTERVAL_MS } from '@fac-academy/shared';
import { mediaStreamPath, useListenReporter } from '../../api/media.js';
import { badgeBase, badgeTone, cardClass } from './styles.js';

/*
 * The no-seek player (S06), as the approved prototype describes it: "There is
 * deliberately no skip/seek control: pause and resume as you need, but
 * 'listened' only registers when the full call has played through."
 *
 * How it keeps that promise:
 *
 *  * there is no seek control to use. The element is rendered WITHOUT the
 *    browser's `controls`, so there is no scrub bar, and the only control is a
 *    play/pause button — a real <button>, so it works from the keyboard and
 *    reads properly to a screen reader. The bar under it is a plain <div>: it
 *    shows where you are, it is not something you can drag;
 *  * a jump forward is undone. Anything that moves the position past the
 *    furthest point actually played (a media key, the console, an extension)
 *    is snapped back to that point, and playback carries on from there;
 *  * `controlsList="nodownload noplaybackrate"`, no picture-in-picture, no
 *    right-click menu and a playback rate pinned to 1, so the file cannot be
 *    saved or run at double speed;
 *  * the badge shows what the SERVER said. Local playback never sets it. The
 *    player posts the stretches it played every five seconds and on every
 *    pause and ending, and the response decides.
 *
 * Intervals that have not been acknowledged are kept and sent again with the
 * next beacon, so a dropped request leaves no hole in the coverage.
 */

/** A seek to more than this past the furthest point played is a jump forward. */
const SEEK_TOLERANCE_SECS = 1.5;

/**
 * A backstop on the stretch a single `timeupdate` may extend.
 *
 * `timeupdate` normally fires four times a second, but a backgrounded or
 * throttled tab can go quiet for a second or two while the audio keeps
 * playing, and truncating there would fail an honest listen — the very risk
 * the plan's risk table calls out. Fifteen seconds is far longer than any
 * throttling seam and far shorter than anything worth skipping, so a leap
 * that big starts a new stretch instead of pretending the gap was played.
 * The real defence against a jump is the `seeking` handler below, and behind
 * that the server's own wall-clock budget; this is only belt and braces.
 */
const MAX_PLAYBACK_STEP_SECS = 15;

/** Stop the queue growing without bound if the server is unreachable for a while. */
const MAX_PENDING = 180;

/**
 * The shortest stretch worth keeping hold of. The server stores coverage to the
 * millisecond, so it answers with a rounded position and a sliver below that is
 * noise, not a gap: keeping it would put a 0.0005-second interval in every
 * beacon for the rest of the recording, and the jitter tolerance covers it many
 * thousand times over.
 */
const MIN_OWED_SECS = 0.001;

/**
 * The parts of a batch the server has NOT counted yet.
 *
 * `acceptedTo` in the response is how far up the batch it got: it admits the
 * intervals in ascending order and shortens the one that runs out of its
 * wall-clock budget, so everything above that point is still owed. Keeping the
 * remainder and sending it again is what stops a shortfall turning into a
 * permanent hole — before this, the player restarted from what it had SENT,
 * never learned that anything had been trimmed, and an honest listen could end
 * up half credited with the quiz still locked.
 *
 * `null` means nothing in the batch was counted, so all of it is still owed.
 * Touching stretches are joined so a long outage cannot fill the queue with
 * slivers; only exact contact joins, so no unplayed second is ever bridged.
 */
function owedAbove(batch, acceptedTo) {
  const floor = typeof acceptedTo === 'number' && Number.isFinite(acceptedTo) ? acceptedTo : null;
  const owed = [];
  for (const [from, to] of batch) {
    if (floor === null) {
      owed.push([from, to]);
      continue;
    }
    const start = Math.max(from, floor);
    if (to - start < MIN_OWED_SECS) continue;
    owed.push([start, to]);
  }
  owed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined = [];
  for (const [from, to] of owed) {
    const last = joined[joined.length - 1];
    if (last !== undefined && from <= last[1]) {
      if (to > last[1]) last[1] = to;
    } else {
      joined.push([from, to]);
    }
  }
  return joined;
}

function fmt(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function NoSeekPlayer({ recording, stageCode }) {
  const isVideo = recording.mediaType === 'VIDEO';
  const report = useListenReporter(recording.id, stageCode);

  const mediaRef = useRef(null);
  /** Stretches played but not yet acknowledged by the server. */
  const pending = useRef([]);
  /** The stretch currently playing: [from, to], or null when stopped. */
  const segment = useRef(null);
  /** The furthest point honestly played. Nothing may start beyond it. */
  const furthest = useRef(0);
  const sending = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  /** Server-confirmed. Seeded from the stage payload, which is also the server. */
  const [listened, setListened] = useState(Boolean(recording.listened));
  const [problem, setProblem] = useState(null);

  const duration =
    Number.isFinite(recording.durationSecs) && recording.durationSecs > 0
      ? recording.durationSecs
      : null;

  /** Close the open stretch and put it in the queue. */
  const closeSegment = useCallback(() => {
    const open = segment.current;
    segment.current = null;
    if (open === null || open[1] - open[0] <= 0) return;
    pending.current = [...pending.current, open].slice(-MAX_PENDING);
  }, []);

  /**
   * Send everything played so far. The open stretch goes with it and is then
   * restarted from where playback is now, so nothing is counted twice and
   * nothing is lost.
   *
   * What the server counted is not always what was sent: it credits a beacon
   * against the wall-clock time that has really passed, and shortens the
   * interval that runs out of it. Whatever it did not count stays in the queue
   * and goes again with the next beacon. A failed request keeps the whole batch
   * the same way.
   */
  const flush = useCallback(async () => {
    if (sending.current) return;
    const open = segment.current;
    const batch = [...pending.current];
    if (open !== null && open[1] - open[0] > 0) batch.push([open[0], open[1]]);
    if (batch.length === 0) return;

    sending.current = true;
    const restartAt = open === null ? null : open[1];
    try {
      const result = await report(batch);
      // The tail the server did not count goes back in the queue, so the open
      // stretch can safely carry on from where playback is now.
      pending.current = owedAbove(batch, result.acceptedTo).slice(-MAX_PENDING);
      if (segment.current !== null && restartAt !== null) {
        segment.current = [restartAt, Math.max(restartAt, segment.current[1])];
      }
      setListened(result.listened);
      setProblem(null);
    } catch {
      // Keep the stretches: they are sent again with the next beacon, which is
      // why a dropped request never leaves a gap for the server to fail on.
      if (open !== null && restartAt !== null) {
        pending.current = [...pending.current, [open[0], restartAt]].slice(-MAX_PENDING);
        if (segment.current !== null) {
          segment.current = [restartAt, Math.max(restartAt, segment.current[1])];
        }
      }
      setProblem('progress');
    } finally {
      sending.current = false;
    }
  }, [report]);

  // The five-second beacon, only while something is playing.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      void flush();
    }, MEDIA_BEACON_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing, flush]);

  // Leaving the page mid-listen: send what is in hand.
  useEffect(
    () => () => {
      closeSegment();
      void flush();
    },
    [closeSegment, flush],
  );

  const toggle = useCallback(() => {
    const el = mediaRef.current;
    if (el === null) return;
    if (el.paused) {
      const attempt = el.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          setProblem('blocked');
        });
      }
    } else {
      el.pause();
    }
  }, []);

  const onPlay = useCallback(() => {
    const el = mediaRef.current;
    const at = el === null ? 0 : el.currentTime;
    segment.current = [at, at];
    setPlaying(true);
  }, []);

  const onTimeUpdate = useCallback(() => {
    const el = mediaRef.current;
    if (el === null) return;
    const at = el.currentTime;
    if (at > furthest.current) furthest.current = at;

    const open = segment.current;
    if (open !== null) {
      if (at < open[1] || at - open[1] > MAX_PLAYBACK_STEP_SECS) {
        // Not a continuation of what was playing: bank what there is and
        // start again here, so no unplayed gap is ever reported as played.
        closeSegment();
        segment.current = [at, at];
      } else {
        open[1] = at;
      }
    }
    setPosition(at);
  }, [closeSegment]);

  /**
   * Seeking cannot happen from this UI, so anything that does it came from
   * somewhere else. Forward is snapped back; backwards is left alone (playing
   * a passage again is not cheating) and simply starts a new stretch.
   */
  const onSeeking = useCallback(() => {
    const el = mediaRef.current;
    if (el === null) return;
    if (el.currentTime > furthest.current + SEEK_TOLERANCE_SECS) {
      el.currentTime = furthest.current;
    }
  }, []);

  const onSeeked = useCallback(() => {
    const el = mediaRef.current;
    if (el === null) return;
    closeSegment();
    if (!el.paused) segment.current = [el.currentTime, el.currentTime];
    setPosition(el.currentTime);
  }, [closeSegment]);

  const onPause = useCallback(() => {
    setPlaying(false);
    closeSegment();
    void flush();
  }, [closeSegment, flush]);

  const onEnded = useCallback(() => {
    setPlaying(false);
    closeSegment();
    void flush();
  }, [closeSegment, flush]);

  /** Double speed would finish the file in half the time it takes to hear it. */
  const onRateChange = useCallback(() => {
    const el = mediaRef.current;
    if (el !== null && el.playbackRate !== 1) el.playbackRate = 1;
  }, []);

  const onError = useCallback(() => {
    setPlaying(false);
    setProblem('media');
  }, []);

  const total = duration ?? 0;
  const pct = total > 0 ? Math.min((position / total) * 100, 100) : 0;
  const doneLabel = isVideo ? 'Watched ✓' : 'Listened ✓';
  const todoLabel = isVideo ? 'To watch' : 'To listen';

  const mediaProps = {
    ref: mediaRef,
    src: mediaStreamPath(recording.id),
    preload: 'metadata',
    controlsList: 'nodownload noplaybackrate',
    disablePictureInPicture: true,
    onContextMenu: (event) => event.preventDefault(),
    onPlay,
    onTimeUpdate,
    onSeeking,
    onSeeked,
    onPause,
    onEnded,
    onRateChange,
    onError,
    'data-testid': `media-${recording.id}`,
  };

  return (
    <li
      data-recording={recording.id}
      data-listened={listened ? 'true' : 'false'}
      className={`${cardClass} px-[22px] py-[18px]`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={toggle}
          aria-label={`${playing ? 'Pause' : 'Play'} ${recording.title}`}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-navy text-base text-white hover:bg-navy-mid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange"
        >
          <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
        </button>

        <span className="min-w-[200px] flex-1">
          <span className="block text-[14.5px] font-bold text-navy">{recording.title}</span>
          <span className="block text-[12.5px] text-muted">{recording.description}</span>
          <span className="block text-[12.5px] font-semibold text-orange">
            {isVideo
              ? '● Real screen recording — no skipping ahead, watch in full'
              : '● Real call recording — no skipping, listen in full'}
          </span>
        </span>

        <span className="min-w-[120px]">
          {/* A picture of where you are, not a control: there is nothing to drag. */}
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-[#EEF1F5]">
            <span className="block h-full rounded-full bg-orange" style={{ width: `${pct}%` }} />
          </span>
          <span className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
            <span>{fmt(position)}</span>
            <span>{duration === null ? '--:--' : fmt(duration)}</span>
          </span>
        </span>

        <span className={`${badgeBase} ${listened ? badgeTone.done : badgeTone.active}`}>
          {listened ? doneLabel : todoLabel}
        </span>
      </div>

      {isVideo ? (
        <video {...mediaProps} className="mt-3 w-full rounded-[10px] bg-black" playsInline />
      ) : (
        <audio {...mediaProps} className="hidden" />
      )}

      <p role="status" className="sr-only">
        {listened ? `${recording.title}: ${doneLabel}` : `${recording.title}: ${todoLabel}`}
      </p>

      {problem === 'media' ? (
        <p className="mt-2 text-[12.5px] font-semibold text-amber">
          This recording could not be played. Refresh the page, and tell your manager if it keeps
          happening.
        </p>
      ) : null}
      {problem === 'blocked' ? (
        <p className="mt-2 text-[12.5px] font-semibold text-amber">
          Your browser blocked playback. Press play again.
        </p>
      ) : null}
      {problem === 'progress' ? (
        <p className="mt-2 text-[12.5px] text-muted">
          We couldn&apos;t save your progress just now — it will be sent again in a moment. Keep
          listening.
        </p>
      ) : null}
    </li>
  );
}
