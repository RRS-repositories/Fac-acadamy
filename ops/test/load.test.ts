// Unit tests for the load test's guards and arithmetic (ops/load/). Nothing
// here opens a socket or a database connection: the point is that a run can
// never be aimed anywhere but this machine's development stack, and that the
// percentiles the go-live verdict rests on are the ones they claim to be.
import { describe, expect, it } from 'vitest';
import {
  CookieJar,
  DEFAULT_BASE_URL,
  LoadError,
  Recorder,
  assertLocalBaseUrl,
  parseLoadArgs,
  percentile,
  statsFor,
} from '../load/lib.js';
import type { Sample } from '../load/lib.js';

// ---------------------------------------------------------------------------
// Guard 1: only this machine
// ---------------------------------------------------------------------------

describe('the local-only base URL guard', () => {
  it('accepts the local development server', () => {
    expect(assertLocalBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
    expect(assertLocalBaseUrl('http://localhost:4100')).toBe('http://localhost:4100');
    expect(assertLocalBaseUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173');
  });

  it('refuses any host that is not this machine', () => {
    expect(() => assertLocalBaseUrl('https://academy.example.com')).toThrow(LoadError);
    expect(() => assertLocalBaseUrl('https://academy.example.com')).toThrow(/only ever runs/);
    expect(() => assertLocalBaseUrl('http://10.0.0.5:4100')).toThrow(/only ever runs/);
  });

  it('refuses something that is not an http URL at all', () => {
    expect(() => assertLocalBaseUrl('not a url')).toThrow(/is not a URL/);
    expect(() => assertLocalBaseUrl('ftp://127.0.0.1')).toThrow(/must be http/);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: only a local database
// ---------------------------------------------------------------------------

describe('the local-only database guard', () => {
  it('requires --expect-db', () => {
    expect(() => parseLoadArgs([])).toThrow(/--expect-db/);
  });

  it('refuses a production-looking database name', () => {
    expect(() => parseLoadArgs(['--expect-db', 'academy_prod'])).toThrow(/local only/);
    expect(() => parseLoadArgs(['--expect-db', 'crm_live'])).toThrow(/local only/);
    expect(() => parseLoadArgs(['--expect-db', 'academy'])).toThrow(/local only/);
  });

  it('accepts a local database and the documented defaults', () => {
    const args = parseLoadArgs(['--expect-db', 'academy_dev']);
    expect(args).not.toBe('help');
    if (args === 'help') return;
    expect(args).toMatchObject({
      expectDb: 'academy_dev',
      baseUrl: DEFAULT_BASE_URL,
      users: 50,
      durationSec: 60,
      rampSec: 10,
      p95BudgetMs: 500,
      keepData: false,
    });
  });

  it('makes the size, the length and the budget configurable', () => {
    const args = parseLoadArgs([
      '--expect-db',
      'academy_test',
      '--users',
      '120',
      '--duration',
      '30',
      '--ramp',
      '5',
      '--think',
      '0',
      '--p95',
      '250',
      '--keep-data',
    ]);
    if (args === 'help') throw new Error('unexpected help');
    expect(args).toMatchObject({
      users: 120,
      durationSec: 30,
      rampSec: 5,
      thinkMs: 0,
      p95BudgetMs: 250,
      keepData: true,
    });
  });

  it('refuses nonsense numbers rather than running something strange', () => {
    expect(() => parseLoadArgs(['--expect-db', 'academy_dev', '--users', '0'])).toThrow(
      /at least 1/,
    );
    expect(() => parseLoadArgs(['--expect-db', 'academy_dev', '--users=-3'])).toThrow(LoadError);
    expect(() => parseLoadArgs(['--expect-db', 'academy_dev', '--users', '99999'])).toThrow(
      LoadError,
    );
    expect(() => parseLoadArgs(['--expect-db', 'academy_dev', '--duration', 'soon'])).toThrow(
      LoadError,
    );
  });
});

// ---------------------------------------------------------------------------
// The statistics the verdict rests on
// ---------------------------------------------------------------------------

describe('percentiles', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses the nearest rank, so p95 of 100 values is the 95th', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it('never reads past the end of a short series', () => {
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('per-endpoint statistics', () => {
  const samples: Sample[] = [
    { endpoint: 'GET /api/track', ms: 10, status: 200, ok: true, at: 0 },
    { endpoint: 'GET /api/track', ms: 30, status: 200, ok: true, at: 10 },
    { endpoint: 'GET /api/track', ms: 20, status: 200, ok: true, at: 20 },
    { endpoint: 'GET /api/track', ms: 900, status: 500, ok: false, at: 30 },
  ];

  it('counts the calls, the errors and the shape of the series', () => {
    const stats = statsFor('GET /api/track', samples);
    expect(stats).toMatchObject({ endpoint: 'GET /api/track', count: 4, errors: 1, max: 900 });
    expect(stats.mean).toBeCloseTo(240, 5);
    expect(stats.p50).toBe(20);
    expect(stats.p95).toBe(900);
  });

  it('groups by endpoint and puts the slowest p95 first', () => {
    const mixed: Sample[] = [
      ...samples,
      { endpoint: 'POST /api/auth/heartbeat', ms: 5, status: 204, ok: true, at: 40 },
    ];
    const rows = Recorder.byEndpoint(mixed);
    expect(rows.map((r) => r.endpoint)).toStrictEqual([
      'GET /api/track',
      'POST /api/auth/heartbeat',
    ]);
  });

  it('drops the ramp-up when asked for the steady state', () => {
    const recorder = new Recorder();
    for (const s of samples) recorder.add(s);
    expect(recorder.all()).toHaveLength(4);
    expect(recorder.since(20).map((s) => s.at)).toStrictEqual([20, 30]);
  });

  it('lists the slowest calls, worst first', () => {
    expect(Recorder.slowest(samples, 2).map((s) => s.ms)).toStrictEqual([900, 30]);
  });
});

// ---------------------------------------------------------------------------
// Cookies (each virtual trainee keeps its own session)
// ---------------------------------------------------------------------------

describe('the per-trainee cookie jar', () => {
  it('keeps what the server sets and sends it back', () => {
    const jar = new CookieJar();
    jar.accept({ 'set-cookie': ['academy_mfa=abc; Path=/; HttpOnly; SameSite=Lax'] });
    expect(jar.has('academy_mfa')).toBe(true);
    expect(jar.header()).toBe('academy_mfa=abc');

    jar.accept({ 'set-cookie': ['academy_sid=xyz; Path=/; HttpOnly'] });
    expect(jar.header()).toBe('academy_mfa=abc; academy_sid=xyz');
  });

  it('forgets a cookie the server clears', () => {
    const jar = new CookieJar();
    jar.accept({ 'set-cookie': ['academy_mfa=abc; Path=/'] });
    jar.accept({ 'set-cookie': ['academy_mfa=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] });
    expect(jar.has('academy_mfa')).toBe(false);
    expect(jar.header()).toBe('');
  });

  it('copes with no cookies at all', () => {
    const jar = new CookieJar();
    jar.accept({});
    expect(jar.header()).toBe('');
  });
});
