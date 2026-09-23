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

const ConfigSchema = DbSettingsSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().min(1).default('127.0.0.1'),
  PUBLIC_BASE_URL: z.string().url(),

  // Database pool (the DB_* connection settings come from DbSettingsSchema).
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // Same statement timeout as the CRM's pool.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

  // Required in production; optional locally (health then reports redis:false).
  REDIS_URL: z.string().url().optional(),

  SESSION_SECRET: z.string().min(32),

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
  ACADEMY_V2: bool,
  STAGE1_AUTH_REQUIRED: bool,
  ACADEMY_PROVISIONING: bool.default('false'),
  AUTH_STRICT: bool.default('true'),

  // CRM API. CRM_AUTH_MODE 'mock' swaps the CRM sign-in check for invented
  // local accounts; it is refused in production. The shared key is required
  // whenever the real CRM is called.
  CRM_AUTH_URL: z.string().url(),
  CRM_AUTH_MODE: z.enum(['http', 'mock']).default('http'),
  CRM_AUTH_KEY: z.string().min(32).optional(),
  CRM_PUBLIC_URL: z.string().url().optional(),

  // Email.
  SES_REGION: z.string().min(1),
  SES_SENDER: z.string().email(),
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

  // Mattermost.
  MATTERMOST_URL: z.string().url(),
  MATTERMOST_BOT_TOKEN: z.string().min(1),
  MATTERMOST_IT_CHANNEL_ID: z.string().min(1),
  PROVISIONING_RESPONDERS: z.string().min(1).optional(),
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
  })
  .transform((cfg) => ({
    ...cfg,
    COOKIE_SECURE: cfg.COOKIE_SECURE ?? cfg.NODE_ENV === 'production',
  }));

export type Config = z.infer<typeof ConfigSchema>;

// Short, value-free hints for the checks that are not obvious from the name.
const HINTS: Record<string, string> = {
  SESSION_SECRET: 'at least 32 characters',
  CRM_AUTH_KEY: 'at least 32 characters',
  CRM_AUTH_MODE: "'http' or 'mock'; 'mock' is refused in production",
  MFA_ENCRYPTION_KEY: 'base64 of exactly 32 bytes, e.g. openssl rand -base64 32',
  COOKIE_SECURE: "'true' or 'false'",
  ACADEMY_V2: "'true' or 'false'",
  STAGE1_AUTH_REQUIRED: "'true' or 'false'",
  ACADEMY_PROVISIONING: "'true' or 'false'",
  AUTH_STRICT: "'true' or 'false'",
  DB_SSL: "'true' or 'false'",
  MEDIA_ROOT:
    'an absolute path to the media folder, outside the repo and outside the website folder',
  MEDIA_MAX_UPLOAD_MB: 'a whole number of megabytes',
  ACADEMY_NOTIFY_MODE: "'shadow', 'log' or 'off' (no provider chosen yet, so no 'send')",
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
