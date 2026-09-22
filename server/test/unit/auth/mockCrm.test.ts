import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_CRM_ACCOUNTS, createMockCrmClient } from '../../../src/integrations/crm/mockCrm.js';

describe('mock CRM client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists only invented @example.com accounts, without passwords', () => {
    expect(MOCK_CRM_ACCOUNTS).toHaveLength(5);
    for (const a of MOCK_CRM_ACCOUNTS) {
      expect(a.email).toMatch(/@example\.com$/);
      expect(a).not.toHaveProperty('password');
    }
  });

  it.each([
    ['trainee.one@example.com', { ok: true, role: 'Sales' }],
    ['trainee.two@example.com', { ok: true, role: 'Customer Service' }],
    ['manager.one@example.com', { ok: true, role: 'Management' }],
    ['pending.one@example.com', { ok: false, reason: 'not_approved' }],
    ['locked.one@example.com', { ok: false, reason: 'locked' }],
  ])('%s behaves as documented', async (email, expected) => {
    const result = await createMockCrmClient().verify(email, 'dev-password');
    const summary = result.ok ? { ok: true, role: result.user.role } : result;
    expect(summary).toEqual(expected);
  });

  it('rejects a wrong password and an unknown email the same way', async () => {
    const crm = createMockCrmClient();
    await expect(crm.verify('trainee.one@example.com', 'wrong')).resolves.toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
    await expect(crm.verify('nobody@example.com', 'dev-password')).resolves.toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
  });

  it('matches email case-insensitively', async () => {
    const r = await createMockCrmClient().verify('Trainee.One@Example.com', 'dev-password');
    expect(r.ok).toBe(true);
  });

  it('refuses to be created in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createMockCrmClient()).toThrow(/production/);
  });
});
