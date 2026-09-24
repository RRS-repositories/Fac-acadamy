// Shared plumbing for ops/load/load-test.ts: argument parsing, the local-only
// guards, a small HTTP client with its own socket pool, and the statistics.
//
// LOCAL / DEV ONLY. Two guards, and both run before a socket is opened:
//   1. --base-url must point at this machine (localhost, 127.0.0.1 or ::1).
//      A load test that could be aimed at a public host by a typo is a denial
//      of service waiting to happen.
//   2. --expect-db must look local ('dev' or 'test', never 'prod' or 'live')
//      and must equal DB_NAME and current_database() — the same rule every
//      other ops/dev script uses (ops/dev/lib.ts).

import http from 'node:http';
import { parseArgs } from 'node:util';
import { DevError, parseExpectDb } from '../dev/lib.js';

export { DevError as LoadError };

export const DEFAULT_BASE_URL = 'http://127.0.0.1:4100';

/** Hosts that are unambiguously this machine. Nothing else is accepted. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function assertLocalBaseUrl(raw: string | undefined, fallback = DEFAULT_BASE_URL): string {
  const value = raw?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DevError(`--base-url "${value}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DevError(`--base-url "${value}" must be http or https.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DevError(
      `Refusing to drive "${url.hostname}": the load test only ever runs against the local ` +
        'development server (localhost, 127.0.0.1 or ::1). It signs in, submits quizzes and ' +
        'pulls media as fast as it can; it must never be pointed at a real installation.',
    );
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export const LOAD_TEST_USAGE =
  'Usage: load-test --expect-db <database name> [--base-url http://127.0.0.1:4100] ' +
  '[--users 50] [--duration 60] [--ramp 10] [--think 1000] [--p95 500] [--keep-data]';

export interface LoadArgs {
  expectDb: string;
  baseUrl: string;
  users: number;
  durationSec: number;
  rampSec: number;
  thinkMs: number;
  p95BudgetMs: number;
  keepData: boolean;
}

function positive(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new DevError(`--${name} must be a number between 0 and ${String(max)}.`);
  }
  return value;
}

export function parseLoadArgs(argv: string[]): LoadArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'expect-db': { type: 'string' },
      'base-url': { type: 'string' },
      users: { type: 'string' },
      duration: { type: 'string' },
      ramp: { type: 'string' },
      think: { type: 'string' },
      p95: { type: 'string' },
      'keep-data': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) return 'help';

  const users = Math.trunc(positive('users', values.users, 50, 500));
  if (users < 1) throw new DevError('--users must be at least 1.');
  return {
    expectDb: parseExpectDb(values['expect-db']),
    baseUrl: assertLocalBaseUrl(values['base-url']),
    users,
    durationSec: positive('duration', values.duration, 60, 3600),
    rampSec: positive('ramp', values.ramp, 10, 600),
    thinkMs: positive('think', values.think, 1000, 60_000),
    p95BudgetMs: positive('p95', values.p95, 500, 60_000),
    keepData: values['keep-data'] === true,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  body: string;
  ms: number;
}

export interface HttpClient {
  request(opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    /** Response bodies over this size are counted but not kept (media). */
    keepBody?: boolean;
  }): Promise<HttpResult>;
  destroy(): void;
}

/**
 * A plain node:http client with an explicit socket pool.
 *
 * `fetch` would do, but its connection pool is not ours to size: with 50
 * virtual trainees the number of sockets is the thing under test, so it is set
 * here and stated in the report rather than inherited from a default.
 * Timing runs from just before the request is written to just after the last
 * byte of the body has been read, which is what a trainee waits for.
 */
export function createHttpClient(baseUrl: string, maxSockets: number): HttpClient {
  const url = new URL(baseUrl);
  const agent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });

  return {
    async request({ method, path, headers = {}, body, keepBody = true }) {
      const started = process.hrtime.bigint();
      return new Promise<HttpResult>((resolve, reject) => {
        const req = http.request(
          {
            agent,
            host: url.hostname,
            port: url.port === '' ? 80 : Number(url.port),
            method,
            path,
            headers: {
              ...headers,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(body)),
                  }),
            },
          },
          (res) => {
            let bytes = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (keepBody) chunks.push(chunk);
            });
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                bytes,
                body: keepBody ? Buffer.concat(chunks).toString('utf8') : '',
                ms: Number(process.hrtime.bigint() - started) / 1e6,
              });
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    },
    destroy() {
      agent.destroy();
    },
  };
}

/** A per-virtual-user cookie jar. Host-only cookies, which is all the app sets. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  accept(headers: http.IncomingHttpHeaders): void {
    const raw = headers['set-cookie'];
    if (raw === undefined) return;
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const pair = line.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || value === 'undefined') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface Sample {
  endpoint: string;
  ms: number;
  status: number;
  ok: boolean;
  /** Milliseconds since the run started, so the ramp can be excluded. */
  at: number;
}

export interface EndpointStats {
  endpoint: string;
  count: number;
  errors: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile: the smallest value at or above the given share. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

export function statsFor(endpoint: string, samples: readonly Sample[]): EndpointStats {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const mean = times.length === 0 ? 0 : times.reduce((n, v) => n + v, 0) / times.length;
  return {
    endpoint,
    count: samples.length,
    errors,
    mean,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: times.at(-1) ?? 0,
  };
}

export class Recorder {
  private readonly samples: Sample[] = [];

  add(sample: Sample): void {
    this.samples.push(sample);
  }

  /** Samples taken at or after `fromMs` (used to drop the ramp-up). */
  since(fromMs: number): Sample[] {
    return this.samples.filter((s) => s.at >= fromMs);
  }

  all(): Sample[] {
    return [...this.samples];
  }

  /** Per-endpoint statistics, busiest first. */
  static byEndpoint(samples: readonly Sample[]): EndpointStats[] {
    const groups = new Map<string, Sample[]>();
    for (const s of samples) {
      const list = groups.get(s.endpoint);
      if (list) list.push(s);
      else groups.set(s.endpoint, [s]);
    }
    return [...groups.entries()]
      .map(([endpoint, list]) => statsFor(endpoint, list))
      .sort((a, b) => b.p95 - a.p95);
  }

  static slowest(samples: readonly Sample[], n: number): Sample[] {
    return [...samples].sort((a, b) => b.ms - a.ms).slice(0, n);
  }
}

export function ms(value: number): string {
  return value.toFixed(1);
}
