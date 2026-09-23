// Proof of a full listen (S06, decision D4 and the PROJECT-PLAN §9 risk
// "network jitter wrongly fails a full listen").
//
// Everything in this file is a pure function over plain numbers, so the rule
// can be read and tested without a database, a browser or a clock.
//
// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------
//
// The player reports the stretches of media it has PLAYED, as [from, to]
// second intervals. The server keeps the merged union of the intervals it has
// accepted in `academy.listen_progress.coverage`, and marks the recording
// listened only when BOTH of these hold:
//
//   1. the coverage spans the whole recording, end to end, with no internal
//      gap longer than JITTER_TOLERANCE_SECS; and
//   2. the media time credited was never larger than the wall-clock time that
//      actually passed while it was being credited.
//
// (2) is what stops a skip. It is enforced one beacon at a time, in
// `applyBeacon`: a beacon may add at most as many seconds of NEW coverage as
// the number of seconds that have passed since the previous beacon (plus a
// one-off allowance for the very first beacon, which arrives one beacon
// interval after playback started). Because the budget of every beacon is the
// real time since the last one, the total credited coverage can never exceed
// the wall-clock time between the first and last beacon plus that one
// allowance — which is exactly the "wall clock >= media time" rule, enforced
// as it happens instead of only at the end. It is also strictly stronger: a
// burst of fabricated beacons fails at the burst rather than at the finish.
//
// The budget is charged against the INCREASE IN COVERED SECONDS, not the raw
// length of the intervals sent. That matters: bridging (see the tolerance
// below) credits a second or two across a gap, and charging only the raw
// lengths would let a script send a cheap stub either side of every gap and
// bridge its way through a recording for free.

/** One accepted stretch of media, in seconds from the start: `[from, to]`. */
export type Interval = readonly [number, number];

/**
 * How much of a gap between two stretches is forgiven — both when merging
 * them into one, and when asking whether the coverage spans the recording.
 *
 * Two seconds. Why two:
 *
 *  * a segment closes at whatever `currentTime` the browser last reported
 *    before a pause, a buffer stall or a throttled background tab, and the
 *    next one opens at the `currentTime` on resume. That reporting seam is
 *    normally a fraction of a second and, on a bad connection or a
 *    backgrounded tab, up to a second or so. Two seconds clears it with room
 *    to spare, so an honest listen is never failed by jitter;
 *  * two seconds is far less than the shortest thing worth skipping — a
 *    spoken sentence on a call runs three to five seconds — so nothing a
 *    trainee would want to skip past can hide inside the tolerance;
 *  * the build pack's own line is "gaps > 5 s invalidate". Two is stricter
 *    than five, so the S06 checklist (a crafted 20 s gap must not pass) holds
 *    with margin, and so does the looser rule it was written against.
 *
 * The client never relies on the tolerance to cover a dropped beacon: it keeps
 * unsent intervals until the server has acknowledged them, so a failed request
 * is retried rather than left as a hole.
 */
export const JITTER_TOLERANCE_SECS = 2;

/**
 * The very first beacon for a recording has no previous beacon to measure
 * against, so it gets a fixed allowance: one beacon interval (5 s) plus time
 * for a slow first flush. Nothing else is ever granted for free.
 */
export const FIRST_BEACON_ALLOWANCE_SECS = 10;

/**
 * Most intervals kept in the stored coverage. Honest coverage merges down to
 * one interval, or a handful if the trainee paused and resumed out of order,
 * so this is only a bound on how much nonsense one account can make the
 * database hold. Over the cap the SHORTEST intervals are dropped, which loses
 * credit rather than granting it.
 */
export const MAX_STORED_INTERVALS = 64;

/** Nothing longer than this is treated as a plausible recording length. */
export const MAX_MEDIA_SECS = 8 * 60 * 60;

/** Round to milliseconds, so stored coverage does not drift in float noise. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Drop everything that cannot be a real stretch of this recording: anything
 * not a finite number, reversed pairs, zero-length pairs, anything negative,
 * anything past the end. What survives is clamped to [0, duration].
 */
export function sanitiseIntervals(
  raw: readonly (readonly [number, number])[],
  durationSecs: number | null,
): Interval[] {
  const limit =
    durationSecs !== null && Number.isFinite(durationSecs) && durationSecs > 0
      ? Math.min(durationSecs, MAX_MEDIA_SECS)
      : MAX_MEDIA_SECS;

  const out: Interval[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [rawFrom, rawTo] = pair;
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) continue;
    if (rawTo < rawFrom) continue; // reversed: nonsense, not a listen
    const from = Math.max(0, Math.min(rawFrom, limit));
    const to = Math.max(0, Math.min(rawTo, limit));
    if (to - from <= 0) continue; // nothing was heard
    out.push([round(from), round(to)]);
  }
  return out;
}

/**
 * The union of a set of intervals, in ascending order, with gaps no longer
 * than `tolerance` closed up. Out-of-order and overlapping input is fine: it
 * is sorted first.
 */
export function mergeIntervals(
  intervals: readonly Interval[],
  tolerance: number = JITTER_TOLERANCE_SECS,
): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1] + tolerance) {
      if (to > last[1]) last[1] = round(to);
    } else {
      out.push([round(from), round(to)]);
    }
  }
  return capIntervals(out);
}

/** Keep the longest MAX_STORED_INTERVALS. Dropping loses credit, never grants it. */
function capIntervals(intervals: [number, number][]): Interval[] {
  if (intervals.length <= MAX_STORED_INTERVALS) return intervals;
  const kept = [...intervals]
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
    .slice(0, MAX_STORED_INTERVALS)
    .sort((a, b) => a[0] - b[0]);
  return kept;
}

/** Total seconds the coverage spans. Assumes a merged (disjoint) list. */
export function coveredSecs(intervals: readonly Interval[]): number {
  let total = 0;
  for (const [from, to] of intervals) total += to - from;
  return round(total);
}

/**
 * How many seconds of coverage a recording needs before it counts as heard
 * end to end: its duration, less the tolerance. Zero when the length is not
 * known, because nothing can be proved against an unknown length.
 */
export function requiredSecs(durationSecs: number | null): number {
  if (durationSecs === null || !Number.isFinite(durationSecs) || durationSecs <= 0) return 0;
  return round(Math.max(0, durationSecs - JITTER_TOLERANCE_SECS));
}

/**
 * Does this coverage span the whole recording?
 *
 * `mergeIntervals` has already closed every gap up to the tolerance, so any
 * gap still present in a merged list is longer than the tolerance and the
 * coverage is not continuous. A continuous span is therefore exactly one
 * interval that starts at (or within the tolerance of) zero and reaches the
 * end. A recording of unknown length never spans: there is no end to reach.
 */
export function spansDuration(
  intervals: readonly Interval[],
  durationSecs: number | null,
  tolerance: number = JITTER_TOLERANCE_SECS,
): boolean {
  if (durationSecs === null || !Number.isFinite(durationSecs) || durationSecs <= 0) return false;
  if (intervals.length !== 1) return false;
  const [from, to] = intervals[0]!;
  return from <= tolerance && to >= durationSecs - tolerance;
}

/** What the server has stored for one trainee on one recording. */
export interface ListenState {
  coverage: Interval[];
  coveredSecs: number;
  /** Epoch ms of the previous accepted beacon; null when there has been none. */
  lastBeaconAt: number | null;
  listened: boolean;
}

export interface BeaconOptions {
  /** Server clock, epoch ms, when this beacon arrived. */
  now: number;
  /** academy.call_recordings.duration_secs, or null when it is not known. */
  durationSecs: number | null;
}

export interface BeaconResult extends ListenState {
  /** True only on the beacon that first proves the full listen. */
  newlyListened: boolean;
}

/**
 * How many seconds of new coverage this beacon may buy: the wall-clock time
 * since the previous beacon, or the one-off allowance for the first one. No
 * per-beacon grace on top — a grace would be granted again on every beacon and
 * would add up to minutes of free skipping over a long recording. None is
 * needed: media time advances no faster than the clock, so an honest beacon's
 * new coverage is always within the time that has passed.
 */
export function beaconBudgetSecs(state: ListenState, now: number): number {
  if (state.lastBeaconAt === null) return FIRST_BEACON_ALLOWANCE_SECS;
  const elapsed = (now - state.lastBeaconAt) / 1000;
  return elapsed > 0 ? elapsed : 0;
}

/**
 * Fold one beacon into the stored state.
 *
 * The intervals are cleaned, then admitted one at a time in ascending order,
 * each charged the number of seconds it ADDS to the covered total. When the
 * budget runs out the rest of the beacon is ignored: the trainee simply has to
 * keep listening, which is the point.
 */
export function applyBeacon(
  state: ListenState,
  intervals: readonly (readonly [number, number])[],
  opts: BeaconOptions,
): BeaconResult {
  const clean = sanitiseIntervals(intervals, opts.durationSecs).sort((a, b) => a[0] - b[0]);
  let coverage = mergeIntervals(state.coverage);
  let budget = beaconBudgetSecs(state, opts.now);

  for (const interval of clean) {
    if (budget <= 0) break;
    const before = coveredSecs(coverage);
    let candidate = mergeIntervals([...coverage, interval]);
    let delta = coveredSecs(candidate) - before;

    if (delta > budget) {
      // Shorten it from the end so it fits. Coverage grows at most one second
      // per second of `to`, so one correction never overshoots; if the
      // shortened interval still costs too much (it fell in a stretch already
      // covered, so shortening bought nothing) it is dropped outright.
      const trimmed: Interval = [interval[0], round(interval[1] - (delta - budget))];
      if (trimmed[1] <= trimmed[0]) break;
      candidate = mergeIntervals([...coverage, trimmed]);
      delta = coveredSecs(candidate) - before;
      if (delta > budget) break;
    }

    coverage = candidate;
    budget = round(budget - delta);
  }

  const covered = coveredSecs(coverage);
  const listened = state.listened || spansDuration(coverage, opts.durationSecs);
  return {
    coverage,
    coveredSecs: covered,
    lastBeaconAt: opts.now,
    listened,
    newlyListened: listened && !state.listened,
  };
}

/**
 * Read a `listen_progress.coverage` JSONB value back into intervals. Anything
 * that is not a pair of finite numbers is dropped: the column is JSONB, so a
 * bad row must not be able to crash a request.
 */
export function parseCoverage(value: unknown): Interval[] {
  if (!Array.isArray(value)) return [];
  const pairs: Interval[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [from, to] = entry as [unknown, unknown];
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < 0) continue;
    pairs.push([from, to]);
  }
  return mergeIntervals(pairs);
}
