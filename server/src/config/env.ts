import { z } from 'zod';
import { DbSettingsSchema } from '../db/connection.js';

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

  // Feature flags. ACADEMY_V2 and STAGE1_AUTH_REQUIRED must be set explicitly.
  ACADEMY_V2: bool,
  STAGE1_AUTH_REQUIRED: bool,
  ACADEMY_PROVISIONING: bool.default('false'),
  AUTH_STRICT: bool.default('true'),

  // CRM API.
  CRM_AUTH_URL: z.string().url(),
  CRM_AUTH_KEY: z.string().min(1).optional(),
  CRM_PUBLIC_URL: z.string().url().optional(),

  // Email.
  SES_REGION: z.string().min(1),
  SES_SENDER: z.string().email(),
  SMTP_URL: z.string().url().optional(),

  // Media.
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),

  // Mattermost.
  MATTERMOST_URL: z.string().url(),
  MATTERMOST_BOT_TOKEN: z.string().min(1),
  MATTERMOST_IT_CHANNEL_ID: z.string().min(1),
  PROVISIONING_RESPONDERS: z.string().min(1).optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV === 'production' && cfg.REDIS_URL === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'required' });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

// Short, value-free hints for the checks that are not obvious from the name.
const HINTS: Record<string, string> = {
  SESSION_SECRET: 'at least 32 characters',
  ACADEMY_V2: "'true' or 'false'",
  STAGE1_AUTH_REQUIRED: "'true' or 'false'",
  ACADEMY_PROVISIONING: "'true' or 'false'",
  AUTH_STRICT: "'true' or 'false'",
  DB_SSL: "'true' or 'false'",
  S3_FORCE_PATH_STYLE: "'true' or 'false'",
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
  // A blank value (`S3_ENDPOINT=` in .env) counts as unset.
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
