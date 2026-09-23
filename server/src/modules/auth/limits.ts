import { createHash, createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';

// Two limits on sign-in (S03 task 6):
//  - per client IP: 5 login attempts a minute, then 429;
//  - per email: 10 failed attempts in a row (wrong password or wrong code)
//    lock sign-in for that email for 15 minutes (423). A successful sign-in
//    clears the count.
// Redis-backed when Redis is configured, so the limits hold across restarts
// and processes; an in-memory limiter is the insurance if Redis drops.

export interface LoginLimitSettings {
  perIpPerMinute: number;
  lockoutThreshold: number;
  lockoutSeconds: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimitSettings = {
  perIpPerMinute: 5,
  lockoutThreshold: 10,
  lockoutSeconds: 15 * 60,
};

export interface LoginLimiters {
  /** Counts one attempt for the IP. False = over the limit (respond 429). */
  consumeIp(ip: string): Promise<boolean>;
  isLocked(email: string): Promise<boolean>;
  /** Counts a failure. `lockedNow` is true on the failure that triggers the lock. */
  recordFailure(email: string): Promise<{ lockedNow: boolean }>;
  reset(email: string): Promise<void>;
}

function limiter(
  redis: Redis | null,
  opts: { keyPrefix: string; points: number; duration: number },
): RateLimiterAbstract {
  const memory = new RateLimiterMemory(opts);
  if (redis === null) return memory;
  return new RateLimiterRedis({ ...opts, storeClient: redis, insuranceLimiter: memory });
}

/**
 * The key the two limiters count against: the address normalised, and NOTHING
 * else — no hash, whatever the old name suggested. It only ever lives in Redis
 * (or in memory) under a counter that expires, so an address typed by whoever
 * is at the login box is held for fifteen minutes and then gone.
 *
 * It must never be written to academy.audit_events, which is append-only,
 * manager-readable and exported as CSV. Use emailAuditKey() there.
 */
export function lockoutKey(email: string): string {
  return email.trim().toLowerCase();
}

const AUDIT_KEY_INFO = 'academy:audit-email:v1';

// One derived key per secret, so the MFA key is never used directly for this.
const derivedKeys = new WeakMap<Buffer, Buffer>();

function auditKeyFrom(secret: Buffer): Buffer {
  const cached = derivedKeys.get(secret);
  if (cached !== undefined) return cached;
  const derived = createHash('sha256').update(secret).update(AUDIT_KEY_INFO).digest();
  derivedKeys.set(secret, derived);
  return derived;
}

/**
 * What a failed sign-in may record about the address that was typed: a keyed
 * hash of it, and never the address.
 *
 * A failed attempt carries attacker-supplied input — any string at all can be
 * put in that box — and the audit table keeps it forever. Hashing keeps the one
 * property the audit needs, that two attempts on the same address match, while
 * storing nothing a reader can turn back into a person. The key is derived from
 * MFA_ENCRYPTION_KEY, so the digests cannot be brute-forced from the low-entropy
 * space of "every email address at this firm" without the secret.
 */
export function emailAuditKey(email: string, secret: Buffer): string {
  return createHmac('sha256', auditKeyFrom(secret))
    .update(lockoutKey(email))
    .digest('hex')
    .slice(0, 32);
}

export function createLoginLimiters(
  redis: Redis | null,
  settings: LoginLimitSettings = DEFAULT_LOGIN_LIMITS,
): LoginLimiters {
  const perIp = limiter(redis, {
    keyPrefix: 'academy:rl-login-ip',
    points: settings.perIpPerMinute,
    duration: 60,
  });
  const failures = limiter(redis, {
    keyPrefix: 'academy:rl-login-fail',
    points: settings.lockoutThreshold,
    duration: settings.lockoutSeconds,
  });

  return {
    async consumeIp(ip) {
      try {
        await perIp.consume(ip);
        return true;
      } catch (rej) {
        if (rej instanceof Error) throw rej;
        return false;
      }
    },

    async isLocked(email) {
      const res = await failures.get(lockoutKey(email));
      return res !== null && res.consumedPoints >= settings.lockoutThreshold;
    },

    async recordFailure(email) {
      const key = lockoutKey(email);
      const res = await failures.penalty(key, 1);
      if (res.consumedPoints === settings.lockoutThreshold) {
        // Restart the clock so the lock lasts the full period from this failure.
        await failures.block(key, settings.lockoutSeconds);
        return { lockedNow: true };
      }
      return { lockedNow: false };
    },

    async reset(email) {
      await failures.delete(lockoutKey(email));
    },
  };
}
