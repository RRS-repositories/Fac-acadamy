import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Role } from '@fac-academy/shared';

// Server-side sessions. The browser holds only an opaque 256-bit id in an
// HttpOnly cookie; everything else lives here. Redis in production (keys under
// academy:sess:, a per-trainee index set under academy:user-sess:), memory for
// local development and tests when REDIS_URL is unset (config makes Redis
// mandatory in production).
//
// Each session is mirrored into academy.sessions for the management "online
// now" view: a row on sign-in, last_seen_at on heartbeat/touch, signed_out_at
// on sign-out and revoked = true when a manager disables the account.

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** A session is written back at most this often (sliding expiry, not every request). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
export const PENDING_MFA_TTL_MS = 5 * 60 * 1000;

export const SESSION_KEY_PREFIX = 'academy:sess:';
export const USER_SESSIONS_KEY_PREFIX = 'academy:user-sess:';
export const PENDING_MFA_KEY_PREFIX = 'academy:mfa:';

export type Clock = () => number;

export interface SessionData {
  traineeId: number;
  role: Role;
  dbSessionId: number;
  createdAt: number;
  lastSeenAt: number;
}

export type NewSession = Pick<SessionData, 'traineeId' | 'role' | 'dbSessionId'>;

export interface SessionStore {
  /** Stores a new session under an id from newOpaqueId(). */
  create(id: string, data: NewSession): Promise<void>;
  /** Null when the id is unknown or the session has been idle for 12 h. */
  get(id: string): Promise<SessionData | null>;
  /** Slides the idle expiry and records lastSeenAt = now. */
  touch(id: string, data: SessionData): Promise<void>;
  /** Returns the removed session, if there was one. */
  destroy(id: string): Promise<SessionData | null>;
  /** Deletes every session of the trainee at once. Returns how many there were. */
  revokeAll(traineeId: number): Promise<number>;
}

export interface PendingMfa {
  traineeId: number;
  /** Normalised (lower-case) email: the key for the failed-attempt lockout. */
  email: string;
  stage: 'enrol' | 'challenge';
  crmRole: string;
  /** base64 of the encrypted TOTP secret while enrolling; never the plain secret. */
  secretEnc?: string;
}

export interface PendingMfaStore {
  create(data: PendingMfa): Promise<string>;
  /** Null when unknown or older than 5 minutes. */
  get(id: string): Promise<PendingMfa | null>;
  destroy(id: string): Promise<void>;
}

/** 32 random bytes, base64url: the only thing the cookie carries. */
export function newOpaqueId(): string {
  return randomBytes(32).toString('base64url');
}

const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What academy.sessions.sid_hash holds: lowercase hex SHA-256 of the opaque
 * id. The raw id is never written to the database.
 */
export function sidHash(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

/** Rejects anything that could not have been issued here before it reaches a store. */
export function isWellFormedId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Memory (development and tests only)
// ---------------------------------------------------------------------------

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(private readonly now: Clock = Date.now) {}

  async create(id: string, data: NewSession): Promise<void> {
    const t = this.now();
    this.sessions.set(id, { ...data, createdAt: t, lastSeenAt: t });
  }

  async get(id: string): Promise<SessionData | null> {
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    if (this.now() - s.lastSeenAt >= SESSION_IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    return { ...s };
  }

  async touch(id: string, data: SessionData): Promise<void> {
    if (!this.sessions.has(id)) return;
    this.sessions.set(id, { ...data, lastSeenAt: this.now() });
  }

  async destroy(id: string): Promise<SessionData | null> {
    const s = this.sessions.get(id) ?? null;
    this.sessions.delete(id);
    return s;
  }

  async revokeAll(traineeId: number): Promise<number> {
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (s.traineeId === traineeId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }
}

export class MemoryPendingMfaStore implements PendingMfaStore {
  private readonly pending = new Map<string, { data: PendingMfa; expiresAt: number }>();

  constructor(private readonly now: Clock = Date.now) {}

  async create(data: PendingMfa): Promise<string> {
    const id = newOpaqueId();
    this.pending.set(id, { data: { ...data }, expiresAt: this.now() + PENDING_MFA_TTL_MS });
    return id;
  }

  async get(id: string): Promise<PendingMfa | null> {
    const entry = this.pending.get(id);
    if (entry === undefined) return null;
    if (this.now() >= entry.expiresAt) {
      this.pending.delete(id);
      return null;
    }
    return { ...entry.data };
  }

  async destroy(id: string): Promise<void> {
    this.pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** The shared client is lazyConnect with no offline queue: open it on first use. */
async function ready(client: Redis): Promise<Redis> {
  if (client.status === 'wait') await client.connect();
  return client;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly client: Redis,
    private readonly now: Clock = Date.now,
  ) {}

  async create(id: string, data: NewSession): Promise<void> {
    const redis = await ready(this.client);
    const t = this.now();
    const session: SessionData = { ...data, createdAt: t, lastSeenAt: t };
    const indexKey = USER_SESSIONS_KEY_PREFIX + data.traineeId;
    await redis
      .multi()
      .set(SESSION_KEY_PREFIX + id, JSON.stringify(session), 'PX', SESSION_IDLE_MS)
      .sadd(indexKey, id)
      .pexpire(indexKey, SESSION_IDLE_MS)
      .exec();
  }

  async get(id: string): Promise<SessionData | null> {
    const redis = await ready(this.client);
    const s = parseJson<SessionData>(await redis.get(SESSION_KEY_PREFIX + id));
    if (s === null) return null;
    // Belt and braces: Redis TTL is the primary expiry.
    if (this.now() - s.lastSeenAt >= SESSION_IDLE_MS) {
      await this.destroy(id);
      return null;
    }
    return s;
  }

  async touch(id: string, data: SessionData): Promise<void> {
    const redis = await ready(this.client);
    const session: SessionData = { ...data, lastSeenAt: this.now() };
    const indexKey = USER_SESSIONS_KEY_PREFIX + data.traineeId;
    // XX: never resurrect a session that was revoked in the meantime.
    await redis
      .multi()
      .set(SESSION_KEY_PREFIX + id, JSON.stringify(session), 'PX', SESSION_IDLE_MS, 'XX')
      .pexpire(indexKey, SESSION_IDLE_MS)
      .exec();
  }

  async destroy(id: string): Promise<SessionData | null> {
    const redis = await ready(this.client);
    const key = SESSION_KEY_PREFIX + id;
    const s = parseJson<SessionData>(await redis.get(key));
    await redis.del(key);
    if (s !== null) await redis.srem(USER_SESSIONS_KEY_PREFIX + s.traineeId, id);
    return s;
  }

  async revokeAll(traineeId: number): Promise<number> {
    const redis = await ready(this.client);
    const indexKey = USER_SESSIONS_KEY_PREFIX + traineeId;
    const ids = await redis.smembers(indexKey);
    if (ids.length === 0) {
      await redis.del(indexKey);
      return 0;
    }
    const deleted = await redis.del(...ids.map((id) => SESSION_KEY_PREFIX + id), indexKey);
    // `deleted` includes the index key itself.
    return Math.max(0, deleted - 1);
  }
}

export class RedisPendingMfaStore implements PendingMfaStore {
  constructor(private readonly client: Redis) {}

  async create(data: PendingMfa): Promise<string> {
    const redis = await ready(this.client);
    const id = newOpaqueId();
    await redis.set(PENDING_MFA_KEY_PREFIX + id, JSON.stringify(data), 'PX', PENDING_MFA_TTL_MS);
    return id;
  }

  async get(id: string): Promise<PendingMfa | null> {
    const redis = await ready(this.client);
    return parseJson<PendingMfa>(await redis.get(PENDING_MFA_KEY_PREFIX + id));
  }

  async destroy(id: string): Promise<void> {
    const redis = await ready(this.client);
    await redis.del(PENDING_MFA_KEY_PREFIX + id);
  }
}

// ---------------------------------------------------------------------------
// Session manager: the store plus the academy.sessions mirror.
// ---------------------------------------------------------------------------

export interface SessionManager {
  /** Inserts the academy.sessions row, then the store entry. Returns the cookie id. */
  create(traineeId: number, role: Role): Promise<string>;
  get(id: string): Promise<SessionData | null>;
  /**
   * Slides the expiry and updates last_seen_at. Unless `force`, this writes
   * only when the last write is at least a minute old.
   */
  touch(id: string, session: SessionData, force?: boolean): Promise<void>;
  /** Sign-out: removes the session and sets signed_out_at. */
  destroy(id: string): Promise<SessionData | null>;
  /** Manager disable: removes every session and marks the rows revoked. */
  revokeAll(traineeId: number): Promise<number>;
}

export function createSessionManager(deps: {
  db: Pool;
  store: SessionStore;
  now?: Clock;
}): SessionManager {
  const { db, store } = deps;
  const now = deps.now ?? Date.now;

  return {
    async create(traineeId, role) {
      const id = newOpaqueId();
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO academy.sessions (trainee_id, sid_hash, signed_in_at, last_seen_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
         RETURNING id`,
        [traineeId, sidHash(id), now()],
      );
      const dbSessionId = Number(rows[0]!.id);
      await store.create(id, { traineeId, role, dbSessionId });
      return id;
    },

    get: (id) => store.get(id),

    async touch(id, session, force = false) {
      if (!force && now() - session.lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return;
      await store.touch(id, session);
      await db.query(
        `UPDATE academy.sessions SET last_seen_at = to_timestamp($2 / 1000.0)
         WHERE id = $1 AND signed_out_at IS NULL AND NOT revoked`,
        [session.dbSessionId, now()],
      );
    },

    async destroy(id) {
      const session = await store.destroy(id);
      if (session !== null) {
        await db.query(
          `UPDATE academy.sessions SET signed_out_at = to_timestamp($2 / 1000.0)
           WHERE id = $1 AND signed_out_at IS NULL`,
          [session.dbSessionId, now()],
        );
      }
      return session;
    },

    async revokeAll(traineeId) {
      // Store first: this is what actually stops the next request.
      const count = await store.revokeAll(traineeId);
      await db.query(
        `UPDATE academy.sessions SET revoked = TRUE
         WHERE trainee_id = $1 AND signed_out_at IS NULL AND NOT revoked`,
        [traineeId],
      );
      return count;
    },
  };
}
