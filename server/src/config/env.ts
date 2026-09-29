import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { DbSettingsSchema } from '../db/connection.js';
import { parseMfaKey } from '../modules/auth/mfaCrypto.js';

// One place that reads process.env. The app refuses to start when a required
// variable is missing or invalid (S01 checklist). Error messages name the
// variables only; values are never printed because several are secrets.

// Strict booleans: only the strings 'true' and 'false'. Never z.coerce.boolean,
// which turns the string 'false' into true.
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** `new URL` without the throw: zod has already checked it parses, but the
 *  production-only rules below run over values from other branches too. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const ConfigSchema = DbSettingsSchema.extend({
  // Not just a label: production is what turns the secure session cookie on
  // (COOKIE_SECURE below), refuses the mock CRM, and requires Redis and https.
  // It defaults to 'development' because that is the safe default for a laptop
  // — which is exactly why a live server must set it explicitly.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().min(1).default('127.0.0.1'),
  PUBLIC_BASE_URL: z.string().url(),

  // Database pool (the DB_* connection settings come from DbSettingsSchema).
  // The password is tightened here rather than in DbSettingsSchema, which the
  // ops scripts and the migration runner share: this is the long-lived login
  // the app itself connects with, and it is generated, never typed, so a
  // 'change-me' or an 'academy' must not be able to reach a running server.
  DB_PASSWORD: z.string().min(12),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // Same statement timeout as the CRM's pool.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

  // Required in production; optional locally (health then reports redis:false).
  REDIS_URL: z.string().url().optional(),

  // TOTP secrets are encrypted with this key (base64 of exactly 32 bytes).
  // Decoded once here; the value is never logged.
  MFA_ENCRYPTION_KEY: z.string().transform((value, ctx) => {
    try {
      return parseMfaKey(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid' });
      return z.NEVER;
    }
  }),

  // Secure attribute on the academy cookies. Defaults to true in production.
  COOKIE_SECURE: bool.optional(),

  // Feature flags. ACADEMY_V2 and STAGE1_AUTH_REQUIRED must be set explicitly.
  // STAGE1_AUTH_REQUIRED has no screen anywhere: the only supported way to
  // authorise (or revoke) a trainee is ops/admin/authorise-stage1.ts, which is
  // audited. Switching it on without that command locks everyone after stage 1.
  ACADEMY_V2: bool,
  STAGE1_AUTH_REQUIRED: bool,
  ACADEMY_PROVISIONING: bool.default('false'),

  // CRM API. CRM_AUTH_MODE 'mock' swaps the CRM sign-in check for invented
  // local accounts; it is refused in production. The shared key is required
  // whenever the real CRM is called.
  CRM_AUTH_URL: z.string().url(),
  CRM_AUTH_MODE: z.enum(['http', 'mock']).default('http'),
  CRM_AUTH_KEY: z.string().min(32).optional(),

  // Email. No provider has been chosen (D19), so nothing here is read by any
  // send path yet; SMTP_URL is the seam a local Mailpit plugs into.
  SMTP_URL: z.string().url().optional(),

  // Notifications (S08). No email provider has been chosen yet — Mattermost
  // was dropped on 23 Sep 2026, there is no AWS, and the CRM sends through
  // Microsoft 365/Graph and SMTP — so the default is SHADOW: the message is
  // composed, recorded in audit_events and logged, and nothing is sent.
  //   shadow  compose + audit row + one log line. Nothing leaves the building.
  //   log     one log line only, no audit row.
  //   off     nothing at all.
  // There is deliberately no 'send' value until a provider exists.
  ACADEMY_NOTIFY_MODE: z.enum(['shadow', 'log', 'off']).default('shadow'),

  // Media (D15: no S3 — files live on the server's own disk). MEDIA_ROOT is
  // the folder the API streams from. It must be an absolute path: a relative
  // one would depend on the working directory pm2 happened to start in. The
  // folder itself is checked (and created if missing) at start-up by
  // media/root.ts, which also logs the path once. In production it is owned by
  // the application user and sits OUTSIDE the website folder, so nginx cannot
  // serve it and the only way to a recording is through the API.
  MEDIA_ROOT: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), { message: 'absolute' })
    .transform((value) => resolve(value)),
  // Ceiling for a manager upload (S06). Streaming is unaffected by it.
  MEDIA_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(10_000).default(200),

  // Recording summaries (migration 0009). A trainee presses "Summarise" under
  // the player, the server asks a model to summarise that recording's
  // TRANSCRIPT, and the answer is stored on the recording and served to
  // everybody afterwards: one model call per recording, ever.
  //
  // All four are OPTIONAL and the flag defaults to false, so an environment
  // that says nothing about any of this starts perfectly and the endpoint
  // reports the feature as off. That is deliberate: the academy is live.
  //
  // The endpoint is Ollama-shaped (POST <base>/api/chat). SUMMARY_MODEL_URL is
  // the BASE, without /api: http://127.0.0.1:11434, not .../api/chat.
  ACADEMY_CALL_SUMMARY: bool.default('false'),
  SUMMARY_MODEL_URL: z.string().url().optional(),
  SUMMARY_MODEL_NAME: z.string().min(1).optional(),
  // A local model on a busy box can take a while over a long call. The default
  // is generous; the endpoint holds one database connection while it waits, so
  // it is not unbounded either.
  SUMMARY_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),

  // Transcription (migration 0010). A recording is turned into timed lines of
  // text by faster-whisper, running on OUR hardware: the audio is a real client
  // call and never leaves the machine it is already on.
  //
  // ACADEMY_TRANSCRIBE defaults to FALSE, and off means the worker's handler
  // logs each job and completes it, exactly as the stub did for months. That is
  // the safe default for a reason the plan is blunt about: the live box has 3
  // cores, 26 applications and a load of about 6.5 before we add anything, so
  // transcribing there is to be switched on deliberately, on one recording, with
  // somebody watching the load — not by deploying a branch.
  //
  // The backlog (the 15 recordings we already have) is NOT done here at all. It
  // runs on the development machine with ops/media/transcribe.ts, which reads
  // the same three settings from its own environment.
  //
  // TRANSCRIBE_MODEL is a SETTING and not a constant on purpose: which Whisper
  // model ships ('small' to start, 'base' if speed matters more, 'medium' if the
  // call quality is poor) is meant to be judged from a real transcript.
  ACADEMY_TRANSCRIBE: bool.default('false'),
  /** The interpreter of the virtual environment that has faster-whisper. */
  TRANSCRIBE_PYTHON: z.string().min(1).optional(),
  /** The absolute path of ops/media/transcribe.py on this machine. */
  TRANSCRIBE_SCRIPT: z.string().min(1).optional(),
  TRANSCRIBE_MODEL: z.string().min(1).optional(),
  // The decoder's beam width. Unset means the script's own default, which is 1.
  // MEASURED on one real 13m29s call with `small`: beam 1 took 371 seconds and
  // beam 5 took 894 — two and a half times the work, the same word count, and a
  // read that was no better. Beam search earns its keep on ambiguous audio; a
  // two-party phone call in English is not that. It stays a setting so the
  // comparison can be repeated the day a genuinely bad recording turns up.
  TRANSCRIBE_BEAM_SIZE: z.coerce.number().int().min(1).max(10).optional(),
  // How many threads the decoder may use. Unset means "let the library decide",
  // which is the right answer on the live box: 3 cores shared with 26 other
  // applications. A property of the machine, which is why it is here and not a
  // constant — the development machine has 16 cores and nothing competing.
  TRANSCRIBE_CPU_THREADS: z.coerce.number().int().min(1).max(256).optional(),
  // A 20-minute call at the plan's worst case (4x its length) is 80 minutes, and
  // the job holds a worker slot for all of it — the queue's concurrency is 1, so
  // one recording is transcribed at a time whatever is waiting behind it.
  TRANSCRIBE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(2 * 60 * 60 * 1000),
})
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && cfg.REDIS_URL === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'required' });
    }
    if (cfg.NODE_ENV === 'production' && cfg.CRM_AUTH_MODE === 'mock') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CRM_AUTH_MODE'], message: 'invalid' });
    }
    if (cfg.CRM_AUTH_MODE === 'http' && cfg.CRM_AUTH_KEY === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CRM_AUTH_KEY'], message: 'required' });
    }
    // Optional, but required TOGETHER — the same shape as CRM_AUTH_MODE and
    // CRM_AUTH_KEY above. Switching the summary flag on without an endpoint and
    // a model name would leave a button that fails on every press, and the only
    // clue would be a 502 in somebody's browser. Refuse to start instead.
    if (cfg.ACADEMY_CALL_SUMMARY) {
      for (const name of ['SUMMARY_MODEL_URL', 'SUMMARY_MODEL_NAME'] as const) {
        if (cfg[name] === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'required' });
        }
      }
    }
    // The same shape again: switching transcription on without an interpreter, a
    // script and a model would leave the worker logging "not configured" on every
    // job while whoever turned it on waits for transcripts that are never coming.
    // Refuse to start instead, naming what is missing.
    if (cfg.ACADEMY_TRANSCRIBE) {
      for (const name of ['TRANSCRIBE_PYTHON', 'TRANSCRIBE_SCRIPT', 'TRANSCRIBE_MODEL'] as const) {
        if (cfg[name] === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'required' });
        }
      }
    }
    // The transcript of a real client call is sent in the body of this request.
    // Over plain http, on a wire that leaves the machine, that is the call in
    // clear. A model on this same box (127.0.0.1 / ::1 / localhost) never puts
    // it on a wire at all, so http is fine there and is in fact the normal way
    // to reach a local Ollama; anything else in production must be https.
    if (cfg.NODE_ENV === 'production' && cfg.SUMMARY_MODEL_URL !== undefined) {
      const url = safeUrl(cfg.SUMMARY_MODEL_URL);
      const host = url?.hostname ?? '';
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
      if (url !== null && url.protocol !== 'https:' && !loopback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUMMARY_MODEL_URL'],
          message: 'invalid',
        });
      }
    }
    // In production both of these must be https, and for different reasons.
    //
    // CRM_AUTH_URL carries the trainee's CRM password and the shared key to the
    // CRM on every sign-in. Over http that is both of them in clear.
    //
    // PUBLIC_BASE_URL is the origin printed on every certificate and used in
    // every /verify/<id> link. An http one sends people to a page where the
    // secure-only session cookie is never sent, so they cannot stay signed in —
    // and a certificate cannot be reissued with a corrected link once it has
    // gone out.
    if (cfg.NODE_ENV === 'production') {
      for (const name of ['CRM_AUTH_URL', 'PUBLIC_BASE_URL'] as const) {
        if (!cfg[name].startsWith('https://')) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'invalid' });
        }
      }
    }
  })
  .transform((cfg) => ({
    ...cfg,
    COOKIE_SECURE: cfg.COOKIE_SECURE ?? cfg.NODE_ENV === 'production',
  }));

export type Config = z.infer<typeof ConfigSchema>;

// Short, value-free hints for the checks that are not obvious from the name.
const HINTS: Record<string, string> = {
  CRM_AUTH_KEY: 'at least 32 characters',
  CRM_AUTH_MODE: "'http' or 'mock'; 'mock' is refused in production",
  CRM_AUTH_URL: 'a URL; https:// in production',
  PUBLIC_BASE_URL: 'a URL; https:// in production',
  DB_PASSWORD: 'at least 12 characters',
  MFA_ENCRYPTION_KEY: 'base64 of exactly 32 bytes, e.g. openssl rand -base64 32',
  COOKIE_SECURE: "'true' or 'false'",
  ACADEMY_V2: "'true' or 'false'",
  STAGE1_AUTH_REQUIRED: "'true' or 'false'",
  ACADEMY_PROVISIONING: "'true' or 'false'",
  DB_SSL: "'true' or 'false'",
  MEDIA_ROOT:
    'an absolute path to the media folder, outside the repo and outside the website folder',
  MEDIA_MAX_UPLOAD_MB: 'a whole number of megabytes',
  ACADEMY_NOTIFY_MODE: "'shadow', 'log' or 'off' (no provider chosen yet, so no 'send')",
  ACADEMY_CALL_SUMMARY: "'true' or 'false'; needs SUMMARY_MODEL_URL and SUMMARY_MODEL_NAME",
  SUMMARY_MODEL_URL:
    'the BASE URL of the model API without /api (e.g. http://127.0.0.1:11434);' +
    ' https:// in production unless it is on this machine',
  SUMMARY_MODEL_NAME: 'the model to ask, as the endpoint names it',
  SUMMARY_MODEL_TIMEOUT_MS: 'milliseconds, between 1000 and 600000',
  ACADEMY_TRANSCRIBE:
    "'true' or 'false'; needs TRANSCRIBE_PYTHON, TRANSCRIBE_SCRIPT and TRANSCRIBE_MODEL",
  TRANSCRIBE_PYTHON:
    'the path of the interpreter in the virtual environment that has faster-whisper installed',
  TRANSCRIBE_SCRIPT: 'the absolute path of ops/media/transcribe.py on this machine',
  TRANSCRIBE_MODEL: "the faster-whisper model: 'small', 'base' or 'medium'",
  TRANSCRIBE_TIMEOUT_MS: 'milliseconds, between 60000 and 86400000',
  TRANSCRIBE_BEAM_SIZE: 'a whole number between 1 and 10; leave it unset for 1',
  TRANSCRIBE_CPU_THREADS:
    'a whole number of threads between 1 and 256; leave it unset to let the library decide',
  NODE_ENV: 'development, test or production',
};

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing environment variables: ${missing.join(', ')}`);
    }
    if (invalid.length > 0) {
      const named = invalid.map((n) => (HINTS[n] ? `${n} (expected ${HINTS[n]})` : n));
      parts.push(`invalid environment variables: ${named.join(', ')}`);
    }
    super(parts.join('; '));
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }

  /** Every variable named in the error, missing first. */
  get variables(): string[] {
    return [...this.missing, ...this.invalid];
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // A blank value (`SMTP_URL=` in .env) counts as unset.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }

  const result = ConfigSchema.safeParse(cleaned);
  if (result.success) return result.data;

  // Zod's own messages can echo the received value, so only issue paths are used.
  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '');
    if (name === '') continue;
    if (cleaned[name] === undefined) missing.add(name);
    else invalid.add(name);
  }
  throw new ConfigError([...missing].sort(), [...invalid].sort());
}
