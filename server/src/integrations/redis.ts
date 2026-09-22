import { Redis } from 'ioredis';

const CHECK_TIMEOUT_MS = 2_000;

/**
 * Redis client for sessions and BullMQ, or null when REDIS_URL is not set
 * (local development before Redis is running). The URL is never logged: it
 * can carry a password.
 */
export function createRedis(url: string | undefined): Redis | null {
  if (url === undefined) return null;
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    // Fail fast while disconnected instead of queueing commands forever.
    enableOfflineQueue: false,
  });
  // Without a listener ioredis prints every reconnect failure. Log each
  // distinct error once until the connection recovers.
  let lastError = '';
  client.on('error', (err: Error) => {
    if (err.message !== lastError) {
      lastError = err.message;
      console.error(`[academy-redis] ${err.message}`);
    }
  });
  client.on('ready', () => {
    lastError = '';
  });
  return client;
}

async function ping(client: Redis): Promise<boolean> {
  // lazyConnect: the first check opens the connection.
  if (client.status === 'wait') await client.connect();
  return (await client.ping()) === 'PONG';
}

/** PING with a short timeout. Resolves true/false; never throws. */
export async function checkRedis(client: Redis | null): Promise<boolean> {
  if (client === null) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([ping(client).catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
