import { describe, expect, it } from 'vitest';
import {
  FIRST_BEACON_ALLOWANCE_SECS,
  JITTER_TOLERANCE_SECS,
  MAX_STORED_INTERVALS,
  applyBeacon,
  coveredSecs,
  mergeIntervals,
  parseCoverage,
  requiredSecs,
  sanitiseIntervals,
  spansDuration,
} from '../../../src/media/coverage.js';
import type { Interval, ListenState } from '../../../src/media/coverage.js';

// The full-listen rule, on invented numbers only. Nothing here comes from a
// real recording: the fixtures are a 60-second and a 600-second "call" made up
// for the arithmetic.

const SHORT = 60;
const LONG = 600;
const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);

function fresh(): ListenState {
  return {
    coverage: [],
    coveredSecs: 0,
    firstBeaconAt: null,
    lastBeaconAt: null,
    listened: false,
  };
}

/**
 * A real player against a real clock, which is not the tidy thing
 * `playThrough` below models.
 *
 * The media element plays continuously in wall-clock time; what a beacon
 * reports is the last position `timeupdate` happened to hand over before the
 * flush, so every beacon under-reports by a small, VARYING lag. The media
 * seconds between two beacons are therefore
 *
 *     (wall gap) + (previous lag - this lag)
 *
 * which is larger than the wall gap whenever the lag shrinks — on a beacon
 * that fires a touch early, after a slow request, in a busy tab. Nothing has
 * been skipped: the total media reported is always the total wall clock minus
 * the current lag, so it never outruns the clock. It is only the SHARE-OUT
 * between beacons that wobbles, in both directions.
 *
 * `slowAt` makes one beacon take much longer than its interval — the request
 * that hangs — after which the client reports the media it played meanwhile.
 */
function playRealtime(
  durationSecs: number,
  opts: { lags?: readonly number[]; slowAt?: number } = {},
): { state: ListenState; sent: number; wallSecs: number } {
  // Tenths of a second of reporting lag, cycling: a lag that shrinks is what
  // makes a beacon's media advance exceed the wall time since the last one.
  const lags = opts.lags ?? [0.4, 0.1, 0.6, 0.2, 0.5, 0.05];
  let state: ListenState = fresh();
  let clock = T0;
  let reported = 0; // the furthest media position the client has reported
  let sent = 0;
  let i = 0;

  while (reported < durationSecs) {
    const gapMs = i === opts.slowAt ? 17_000 : 5_000;
    clock += gapMs;
    const elapsed = (clock - T0) / 1000;
    const lag = lags[i % lags.length]!;
    // Where playback has really got to, as the browser last reported it.
    const at = Math.min(round3(elapsed - lag), durationSecs);
    if (at > reported) {
      state = applyBeacon(state, [[reported, at]], { now: clock, durationSecs });
      reported = at;
    }
    sent++;
    i++;
  }
  return { state, sent, wallSecs: (clock - T0) / 1000 };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Play a recording through, beacon by beacon, in real time: each beacon
 * carries the seconds played since the last one, and the clock moves by the
 * same amount. This is what an honest player does.
 */
function playThrough(
  durationSecs: number,
  opts: { step?: number; jitter?: number; start?: number } = {},
): { state: ListenState; beacons: number } {
  const step = opts.step ?? 5;
  const jitter = opts.jitter ?? 0;
  let state: ListenState = fresh();
  let at = opts.start ?? 0;
  let clock = T0;
  let beacons = 0;

  while (at < durationSecs) {
    const to = Math.min(at + step, durationSecs);
    // Wall clock moves at least as fast as the media: the gap the jitter
    // leaves behind is time that passed without a timeupdate being reported.
    clock += (to - at) * 1000;
    state = applyBeacon(state, [[at + (beacons === 0 ? 0 : jitter), to]], {
      now: clock,
      durationSecs,
    });
    beacons++;
    at = to;
  }
  return { state, beacons };
}

describe('sanitiseIntervals', () => {
  it('drops nonsense and clamps to the recording', () => {
    const clean = sanitiseIntervals(
      [
        [-10, 5], // starts before the beginning
        [50, 40], // reversed
        [20, 20], // nothing heard
        [55, 900], // runs past the end
        [Number.NaN, 10], // not a number
        [Number.POSITIVE_INFINITY, 10],
      ],
      SHORT,
    );
    expect(clean).toEqual([
      [0, 5],
      [55, 60],
    ]);
  });

  it('keeps intervals when the duration is unknown', () => {
    expect(sanitiseIntervals([[0, 30]], null)).toEqual([[0, 30]]);
  });
});

describe('mergeIntervals', () => {
  it('merges out-of-order and overlapping intervals into one span', () => {
    const merged = mergeIntervals([
      [20, 30],
      [0, 10],
      [8, 22],
    ]);
    expect(merged).toEqual([[0, 30]]);
    expect(coveredSecs(merged)).toBe(30);
  });

  it('closes a gap inside the jitter tolerance but not a real one', () => {
    expect(
      mergeIntervals([
        [0, 10],
        [11, 20],
      ]),
    ).toEqual([[0, 20]]);
    expect(
      mergeIntervals([
        [0, 10],
        [30, 40],
      ]),
    ).toEqual([
      [0, 10],
      [30, 40],
    ]);
  });

  it('keeps at most MAX_STORED_INTERVALS, dropping the shortest', () => {
    const many: Interval[] = [];
    for (let i = 0; i < MAX_STORED_INTERVALS + 20; i++) {
      // Every interval is a different length and none of them touch.
      many.push([i * 100, i * 100 + 1 + i]);
    }
    const merged = mergeIntervals(many);
    expect(merged).toHaveLength(MAX_STORED_INTERVALS);
    // The ones kept are the long ones at the end, still in ascending order.
    expect(merged[0]![0]).toBeGreaterThan(many[0]![0]);
    expect([...merged].sort((a, b) => a[0] - b[0])).toEqual(merged);
  });
});

describe('spansDuration / requiredSecs', () => {
  it('accepts a span that is short by less than the tolerance', () => {
    expect(spansDuration([[0.5, SHORT - 1]], SHORT)).toBe(true);
    expect(spansDuration([[0, SHORT]], SHORT)).toBe(true);
  });

  it('rejects a span that stops short, or that has a hole', () => {
    expect(spansDuration([[0, SHORT - 20]], SHORT)).toBe(false);
    expect(
      spansDuration(
        [
          [0, 20],
          [40, SHORT],
        ],
        SHORT,
      ),
    ).toBe(false);
  });

  it('never spans a recording of unknown length', () => {
    expect(spansDuration([[0, 10_000]], null)).toBe(false);
    expect(requiredSecs(null)).toBe(0);
    expect(requiredSecs(SHORT)).toBe(SHORT - JITTER_TOLERANCE_SECS);
  });
});

describe('applyBeacon — an honest listen against a real clock', () => {
  // The bug of 25 Sep 2026: a trainee heard two recordings right through
  // without skipping and the server credited about half of each, leaving the
  // quiz locked (s1-rec1: 567 s of 1052 credited, in ~51 fragments; s1-rec2:
  // 413 s of 809). The cause was the budget, not the listening: a beacon could
  // buy at most the wall-clock time since the previous beacon, with no slack,
  // so every wobble in when a beacon fired trimmed the end off it — and the
  // trimmed tail was never re-credited.
  it('credits every second of a listen whose beacons wobble in both directions', () => {
    const { state, sent, wallSecs } = playRealtime(LONG, { slowAt: 11 });

    // Nothing was skipped, so nothing may be missing: one unbroken span.
    expect(state.coverage).toHaveLength(1);
    expect(state.coverage[0]![0]).toBeLessThanOrEqual(JITTER_TOLERANCE_SECS);
    expect(state.coverage[0]![1]).toBeGreaterThanOrEqual(LONG - JITTER_TOLERANCE_SECS);
    expect(state.coveredSecs).toBeGreaterThanOrEqual(requiredSecs(LONG));
    expect(state.listened).toBe(true);

    // And the listen really did take the time it claims: the rule is not being
    // passed by a shortcut in the fixture.
    expect(sent).toBeGreaterThan(100);
    expect(wallSecs).toBeGreaterThanOrEqual(LONG);
  });

  it('never credits more than the wall clock that has passed since the first beacon', () => {
    // The invariant the budget exists to enforce, stated over the whole listen
    // rather than one beacon at a time.
    const { state, wallSecs } = playRealtime(LONG);
    expect(state.coveredSecs).toBeLessThanOrEqual(wallSecs + FIRST_BEACON_ALLOWANCE_SECS);
  });
});

describe('applyBeacon — an honest listen', () => {
  it('marks a clean full listen, once', () => {
    const { state, beacons } = playThrough(SHORT);
    expect(beacons).toBe(12);
    expect(state.listened).toBe(true);
    expect(state.coverage).toEqual([[0, SHORT]]);
    expect(state.coveredSecs).toBe(SHORT);
  });

  it('reports newlyListened on the beacon that finishes it, and not again', () => {
    let state: ListenState = fresh();
    let clock = T0;
    let last = applyBeacon(state, [[0, 5]], { now: clock, durationSecs: 10 });
    expect(last.newlyListened).toBe(false);
    state = last;

    clock += 5_000;
    last = applyBeacon(state, [[5, 10]], { now: clock, durationSecs: 10 });
    expect(last.newlyListened).toBe(true);
    expect(last.listened).toBe(true);
    state = last;

    clock += 5_000;
    last = applyBeacon(state, [[0, 10]], { now: clock, durationSecs: 10 });
    expect(last.listened).toBe(true);
    expect(last.newlyListened).toBe(false);
  });

  it('still passes when every beacon leaves a second of jitter behind it', () => {
    // Each segment starts a second after the previous one ended: the seam a
    // buffer stall or a throttled tab leaves. Nothing was skipped.
    const { state } = playThrough(SHORT, { step: 5, jitter: 1 });
    expect(state.coverage).toHaveLength(1);
    expect(state.listened).toBe(true);
  });

  it('survives beacons that arrive out of order and overlapping', () => {
    let state: ListenState = fresh();
    let clock = T0;
    // Five seconds of media per beacon, five seconds of clock — but the
    // intervals inside each beacon are shuffled and overlap their neighbours,
    // the way a retried beacon and a resumed segment do.
    const beacons: [number, number][][] = [
      [[0, 5]],
      [
        [8, 10],
        [4, 9],
      ],
      [[10, 15]],
      [
        [17, 20],
        [14, 18],
      ],
    ];
    for (const intervals of beacons) {
      clock += 5_000;
      state = applyBeacon(state, intervals, { now: clock, durationSecs: 20 });
    }
    expect(state.coverage).toEqual([[0, 20]]);
    expect(state.listened).toBe(true);
  });
});

describe('applyBeacon — a skip does not pass', () => {
  it('fails a listen with a 20-second hole in it', () => {
    let state: ListenState = fresh();
    let clock = T0;
    // Play 0–20, jump to 40, play 40–60, five honest seconds per beacon. The
    // wall clock is honest for the parts actually played; the hole is the point.
    const played: [number, number][] = [];
    for (let at = 0; at < 20; at += 5) played.push([at, at + 5]);
    for (let at = 40; at < 60; at += 5) played.push([at, at + 5]);
    for (const [from, to] of played) {
      clock += (to - from) * 1000;
      state = applyBeacon(state, [[from, to]], { now: clock, durationSecs: SHORT });
    }
    expect(state.coverage).toEqual([
      [0, 20],
      [40, 60],
    ]);
    expect(state.coveredSecs).toBe(40);
    expect(state.listened).toBe(false);
  });

  it('refuses ten minutes of coverage claimed in three seconds of wall clock', () => {
    let state: ListenState = fresh();
    let clock = T0;
    // Three beacons, one second apart, each claiming minutes of audio.
    const claims: [number, number][] = [
      [0, 200],
      [200, 400],
      [400, 600],
    ];
    for (const [from, to] of claims) {
      clock += 1_000;
      state = applyBeacon(state, [[from, to]], { now: clock, durationSecs: LONG });
    }
    expect(state.listened).toBe(false);
    // The first beacon bought its allowance and each later one bought a
    // second; nothing else was credited.
    expect(state.coveredSecs).toBeLessThanOrEqual(FIRST_BEACON_ALLOWANCE_SECS + 2);
  });

  it('refuses a single beacon that claims the whole recording at once', () => {
    const state = applyBeacon(fresh(), [[0, LONG]], { now: T0, durationSecs: LONG });
    expect(state.listened).toBe(false);
    expect(state.coveredSecs).toBe(FIRST_BEACON_ALLOWANCE_SECS);
  });

  it('refuses stubs either side of every gap, which would otherwise bridge it free', () => {
    // The tolerance closes gaps of up to two seconds. A script could try to
    // buy a whole recording with hundreds of cheap 0.1 s stubs and let the
    // bridging do the rest — so the budget is charged on the coverage gained,
    // not on the length of what was sent.
    const stubs: [number, number][] = [];
    for (let at = 0; at < LONG; at += 2) stubs.push([at, at + 0.1]);
    const state = applyBeacon(fresh(), stubs, { now: T0, durationSecs: LONG });
    expect(state.coveredSecs).toBeLessThanOrEqual(FIRST_BEACON_ALLOWANCE_SECS);
    expect(state.listened).toBe(false);
  });

  it('never marks a recording whose length is not known', () => {
    const { state } = playThrough(LONG);
    const unknown = applyBeacon(
      { ...fresh(), coverage: state.coverage, coveredSecs: state.coveredSecs },
      [[0, 600]],
      { now: T0, durationSecs: null },
    );
    expect(unknown.listened).toBe(false);
  });
});

describe('applyBeacon — what the beacon tells the client back', () => {
  it('reports the end of what it accepted, and null when it accepted nothing', () => {
    // A first beacon inside its allowance: all of it lands.
    const first = applyBeacon(fresh(), [[0, 8]], { now: T0, durationSecs: LONG });
    expect(first.acceptedTo).toBe(8);

    // A second beacon one second later can afford two more seconds (eight of
    // the ten-second allowance are spent), so it is cut short — and says where.
    const second = applyBeacon(first, [[8, 20]], { now: T0 + 1_000, durationSecs: LONG });
    expect(second.acceptedTo).toBe(11);
    expect(second.coveredSecs).toBe(11);

    // Nothing left to spend: nothing accepted, and the client is told so.
    const third = applyBeacon(second, [[11, 30]], { now: T0 + 1_000, durationSecs: LONG });
    expect(third.acceptedTo).toBeNull();
    expect(third.coveredSecs).toBe(11);
  });

  it('accepts an interval it has already counted, so a resend is not refused forever', () => {
    const first = applyBeacon(fresh(), [[0, 5]], { now: T0, durationSecs: LONG });
    // The same stretch again, with no budget at all: it adds nothing, so it
    // costs nothing, and the client is told it need not keep offering it.
    const again = applyBeacon(first, [[0, 5]], { now: T0, durationSecs: LONG });
    expect(again.acceptedTo).toBe(5);
    expect(again.coveredSecs).toBe(5);
  });

  it('lets the client repair a shortfall by sending the remainder again', () => {
    // What the player now does: send, see how far the server got, keep the rest
    // and offer it with the next beacon. The recording must end up whole.
    const duration = 40;
    let state: ListenState = fresh();
    let clock = T0;
    let owed: [number, number][] = [];
    let at = 0;

    while (at < duration) {
      const to = Math.min(at + 5, duration);
      clock += 5_000;
      const batch: [number, number][] = [...owed, [at, to]];
      const result = applyBeacon(state, batch, { now: clock, durationSecs: duration });
      state = result;
      // Everything above what the server accepted is still owed.
      owed = batch
        .filter(([, end]) => result.acceptedTo === null || end > result.acceptedTo)
        .map(([start, end]): [number, number] => [
          result.acceptedTo === null ? start : Math.max(start, result.acceptedTo),
          end,
        ]);
      at = to;
    }
    // A few more beacons with nothing new to play: the debt, if any, clears.
    for (let i = 0; i < 3 && owed.length > 0; i++) {
      clock += 5_000;
      const result = applyBeacon(state, owed, { now: clock, durationSecs: duration });
      state = result;
      owed = owed.filter(([, end]) => result.acceptedTo === null || end > result.acceptedTo);
    }
    expect(state.coverage).toEqual([[0, duration]]);
    expect(state.listened).toBe(true);
  });

  it('remembers when the listen began, and never restarts it', () => {
    const first = applyBeacon(fresh(), [[0, 5]], { now: T0, durationSecs: LONG });
    expect(first.firstBeaconAt).toBe(T0);
    const later = applyBeacon(first, [[5, 10]], { now: T0 + 5_000, durationSecs: LONG });
    expect(later.firstBeaconAt).toBe(T0);
    expect(later.lastBeaconAt).toBe(T0 + 5_000);

    // And the budget is measured from it: a beacon may not spend time that the
    // earlier beacons of the same listen have already spent.
    const greedy = applyBeacon(later, [[10, LONG]], { now: T0 + 6_000, durationSecs: LONG });
    expect(greedy.coveredSecs).toBeLessThanOrEqual(FIRST_BEACON_ALLOWANCE_SECS + 6);
    expect(greedy.listened).toBe(false);
  });
});

describe('parseCoverage', () => {
  it('reads back what was stored and throws away anything malformed', () => {
    expect(parseCoverage([[0, 10], 'nope', [30, 20], [null, 5], [40, 50]] as unknown[])).toEqual([
      [0, 10],
      [40, 50],
    ]);
    expect(parseCoverage(null)).toEqual([]);
    expect(parseCoverage({ from: 0 })).toEqual([]);
  });
});
