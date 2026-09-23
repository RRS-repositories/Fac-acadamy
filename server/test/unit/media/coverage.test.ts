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
  return { coverage: [], coveredSecs: 0, lastBeaconAt: null, listened: false };
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
