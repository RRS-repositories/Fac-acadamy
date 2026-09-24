import { describe, expect, it } from 'vitest';
import { createLoginLimiters } from '../../src/modules/auth/limits.js';
import {
  MemoryPendingMfaStore,
  MemorySessionStore,
  PENDING_MFA_TTL_MS,
  SESSION_IDLE_MS,
  isWellFormedId,
  newOpaqueId,
  sidHash,
} from '../../src/modules/auth/sessions.js';

function clock() {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
}

describe('session ids', () => {
  it('are 32 random bytes in base64url', () => {
    const id = newOpaqueId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    expect(newOpaqueId()).not.toBe(id);
    expect(isWellFormedId(id)).toBe(true);
    expect(isWellFormedId('short')).toBe(false);
    expect(isWellFormedId(undefined)).toBe(false);
  });

  it('are stored in the database only as a SHA-256 hex hash', () => {
    const id = newOpaqueId();
    expect(sidHash(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(sidHash(id)).not.toContain(id);
  });
});

describe('MemorySessionStore', () => {
  it('expires after 12 h idle and slides on touch', async () => {
    const c = clock();
    const store = new MemorySessionStore(c.now);
    const id = newOpaqueId();
    await store.create(id, { traineeId: 1, role: 'STAFF', dbSessionId: 10 });
    c.t += SESSION_IDLE_MS - 1;
    const s = await store.get(id);
    expect(s).not.toBeNull();
    await store.touch(id, s!);
    c.t += SESSION_IDLE_MS - 1;
    expect(await store.get(id)).not.toBeNull();
    c.t += 1;
    expect(await store.get(id)).toBeNull();
  });

  it('revokeAll removes every session of one trainee only', async () => {
    const store = new MemorySessionStore();
    const a1 = newOpaqueId();
    const a2 = newOpaqueId();
    const b = newOpaqueId();
    await store.create(a1, { traineeId: 1, role: 'STAFF', dbSessionId: 1 });
    await store.create(a2, { traineeId: 1, role: 'STAFF', dbSessionId: 2 });
    await store.create(b, { traineeId: 2, role: 'MANAGER', dbSessionId: 3 });
    expect(await store.revokeAll(1)).toBe(2);
    expect(await store.get(a1)).toBeNull();
    expect(await store.get(a2)).toBeNull();
    expect(await store.get(b)).not.toBeNull();
  });

  it('touch never resurrects a revoked session', async () => {
    const store = new MemorySessionStore();
    const id = newOpaqueId();
    await store.create(id, { traineeId: 1, role: 'STAFF', dbSessionId: 1 });
    const s = (await store.get(id))!;
    await store.revokeAll(1);
    await store.touch(id, s);
    expect(await store.get(id)).toBeNull();
  });
});

describe('MemoryPendingMfaStore', () => {
  it('expires after 5 minutes', async () => {
    const c = clock();
    const store = new MemoryPendingMfaStore(c.now);
    const id = await store.create({
      traineeId: 1,
      email: 'a@example.com',
      stage: 'challenge',
      crmRole: 'Sales',
    });
    c.t += PENDING_MFA_TTL_MS - 1;
    expect(await store.get(id)).not.toBeNull();
    c.t += 1;
    expect(await store.get(id)).toBeNull();
  });
});

describe('login limiters (memory)', () => {
  it('allows 5 attempts a minute per IP, then refuses', async () => {
    const limits = createLoginLimiters(null);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) results.push(await limits.consumeIp('203.0.113.1'));
    expect(results).toEqual([true, true, true, true, true, false, false]);
    expect(await limits.consumeIp('203.0.113.2')).toBe(true);
  });

  it('locks an email on the 10th failure; reset clears it', async () => {
    const limits = createLoginLimiters(null);
    const email = 'Someone@Example.com';
    const locked: boolean[] = [];
    for (let i = 0; i < 10; i++) locked.push((await limits.recordFailure(email)).lockedNow);
    expect(locked).toEqual([...Array<boolean>(9).fill(false), true]);
    expect(await limits.isLocked('someone@example.com')).toBe(true);
    await limits.reset(email);
    expect(await limits.isLocked(email)).toBe(false);
  });
});
