/*
 * The one clock the training screens use.
 *
 * This lived twice as a module-local `fmt`, in NoSeekPlayer and in
 * RecordingTranscript, and the video library needed a third copy. Three
 * spellings of the same thing drift: one of them rounds, one of them floors,
 * and a trainee sees a recording that is "4:59" beside the player and "5:00"
 * in the transcript. So it is one exported function, imported by all three.
 */

/**
 * `m:ss` from a number of seconds — "0:07", "4:12", "73:40".
 *
 * Fractions are floored rather than rounded, because this is a clock and not a
 * measurement: a play head at 4.9 seconds has not yet reached 0:05, and a
 * counter that showed 0:05 before the fifth second had passed would tick a
 * second early for the whole file.
 *
 * Deliberately NOT hours:minutes:seconds. Nothing in the academy is an hour
 * long, and "73:40" is unambiguous for the one day something is.
 *
 * Anything that is not a finite, non-negative number is "0:00". A missing
 * duration is the caller's decision to present (the players show "--:--"), so
 * this never invents a dash of its own.
 */
export function formatClock(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
