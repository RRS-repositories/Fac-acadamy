import pg from 'pg';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { pgConfig } from './connection.js';

const CHECK_TIMEOUT_MS = 2_000;

export function createPool(config: Config): Pool {
  const pool = new pg.Pool(
    pgConfig(config, {
      applicationName: 'academy-api',
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      max: config.DB_POOL_MAX,
    }),
  );
  // An idle client losing its connection emits 'error' on the pool. Without a
  // listener that would crash the process; log it and let the pool reconnect.
  pool.on('error', (err) => {
    console.error(`[academy-db] idle client error: ${err.message}`);
  });
  return pool;
}

/** `select 1` with a short timeout. Resolves true/false; never throws. */
export async function checkDb(pool: Pool): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
    timer.unref();
  });
  const query = pool.query('select 1 as ok').then(
    (res) => res.rows.length === 1,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
