import { z } from 'zod';
import type { PoolConfig } from 'pg';

// Database settings use the CRM's variable names (DB_HOST, DB_PORT, DB_NAME,
// DB_USER, DB_PASSWORD, DB_SSL). Every field is passed to pg explicitly, so the
// PG* variables on the production server (they belong to a different app's
// database) are never picked up as defaults.

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const DbSettingsSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL: bool.default('false'),
});

export type DbSettings = z.infer<typeof DbSettingsSchema>;

// `citext` is installed in `public`, so `public` must stay on the path:
// without it, `email = $1` on a CITEXT column silently falls back to a
// case-sensitive text comparison. The academy_app role has no rights on
// public's CRM tables, so this grants nothing extra.
export const ACADEMY_SEARCH_PATH = 'academy, public';

export function pgConfig(
  db: DbSettings,
  opts: { applicationName: string; statementTimeoutMs?: number; max?: number },
): PoolConfig {
  return {
    host: db.DB_HOST,
    port: db.DB_PORT,
    database: db.DB_NAME,
    user: db.DB_USER,
    password: db.DB_PASSWORD,
    // Same as the CRM's pool: TLS on, no CA pinning (the database is on the same host).
    ssl: db.DB_SSL ? { rejectUnauthorized: false } : false,
    application_name: opts.applicationName,
    options: `-c search_path=${ACADEMY_SEARCH_PATH.replace(/ /g, '')}`,
    ...(opts.statementTimeoutMs !== undefined && { statement_timeout: opts.statementTimeoutMs }),
    ...(opts.max !== undefined && { max: opts.max }),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}
