// A durable "has this already been done?" marker in Redis.
//
// BullMQ is at-least-once: kill a worker with a job in flight and the job is
// re-run by whoever picks it up next. Handlers that write to Postgres get
// their exactly-once from a unique key there (the notification rules use
// academy.notifications_sent). Handlers with no table of their own use this.
//
// The marker is claimed BEFORE the work, with SET NX, so two runs of the same
// job can never both do the work. The trade is the usual one and it is
// deliberate: if the process dies between the claim and the work, that piece
// of work is skipped rather than done twice. For a notification, "not sent" is
// recoverable (the dead-letter entry and the audit trail both show it);
// "sent twice" is what the checklist forbids.

import type { Redis } from 'ioredis';

/** A fortnight: long enough that no realistic retry outlives the marker. */
export const DEFAULT_MARKER_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface OnceMarker {
  /** True the first time this key is claimed, false every time after. */
  claim(key: string): Promise<boolean>;
  /** Give the key back, so the work can be attempted again. */
  release(key: string): Promise<void>;
  claimed(key: string): Promise<boolean>;
}

export function createRedisOnceMarker(
  connection: Redis,
  options: { prefix?: string; ttlSeconds?: number } = {},
): OnceMarker {
  const prefix = options.prefix ?? 'academy:once:';
  const ttl = options.ttlSeconds ?? DEFAULT_MARKER_TTL_SECONDS;
  return {
    async claim(key) {
      const result = await connection.set(`${prefix}${key}`, '1', 'EX', ttl, 'NX');
      return result === 'OK';
    },
    async release(key) {
      await connection.del(`${prefix}${key}`);
    },
    async claimed(key) {
      return (await connection.exists(`${prefix}${key}`)) === 1;
    },
  };
}

/**
 * Run `work` at most once for `key`. If the work throws, the marker is given
 * back so a retry can try again — only a hard process kill between the claim
 * and the marker's release can lose a piece of work.
 */
export async function runOnce(
  marker: OnceMarker,
  key: string,
  work: () => Promise<void>,
): Promise<boolean> {
  if (!(await marker.claim(key))) return false;
  try {
    await work();
    return true;
  } catch (err) {
    await marker.release(key).catch(() => undefined);
    throw err;
  }
}
