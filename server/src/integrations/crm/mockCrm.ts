import type { CrmClient, CrmUser, CrmVerifyResult } from './crmClient.js';

// LOCAL DEVELOPMENT ONLY. Invented accounts (all @example.com) so the sign-in
// flow can be exercised without a CRM. Every account uses the password
// 'dev-password'. Refuses to exist in production.

const MOCK_PASSWORD = 'dev-password';

// The two `shot.*` accounts exist so automated runs (screenshots, demos) never
// re-enrol an authenticator on an account a person signs in with: doing that
// leaves their phone holding a dead QR code.
export const MOCK_CRM_ACCOUNTS: readonly CrmUser[] = Object.freeze([
  {
    id: 900006,
    email: 'shot.agent@example.com',
    fullName: 'Screenshot Agent',
    role: 'Customer Service',
    isApproved: true,
    locked: false,
  },
  {
    id: 900007,
    email: 'shot.dept@example.com',
    fullName: 'Screenshot Department',
    role: 'Admin',
    isApproved: true,
    locked: false,
  },
  {
    id: 900001,
    email: 'trainee.one@example.com',
    fullName: 'Trainee One',
    role: 'Sales',
    isApproved: true,
    locked: false,
  },
  {
    id: 900002,
    email: 'trainee.two@example.com',
    fullName: 'Trainee Two',
    role: 'Customer Service',
    isApproved: true,
    locked: false,
  },
  {
    id: 900003,
    email: 'manager.one@example.com',
    fullName: 'Manager One',
    role: 'Management',
    isApproved: true,
    locked: false,
  },
  {
    id: 900004,
    email: 'pending.one@example.com',
    fullName: 'Pending One',
    role: 'Sales',
    isApproved: false,
    locked: false,
  },
  {
    id: 900005,
    email: 'locked.one@example.com',
    fullName: 'Locked One',
    role: 'Sales',
    isApproved: true,
    locked: true,
  },
]);

export function createMockCrmClient(): CrmClient {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The mock CRM client must never be used in production');
  }
  return {
    async verify(email, password): Promise<CrmVerifyResult> {
      const account = MOCK_CRM_ACCOUNTS.find(
        (a) => a.email.toLowerCase() === email.trim().toLowerCase(),
      );
      if (account === undefined || password !== MOCK_PASSWORD) {
        return { ok: false, reason: 'invalid_credentials' };
      }
      if (account.locked) return { ok: false, reason: 'locked' };
      if (!account.isApproved) return { ok: false, reason: 'not_approved' };
      return { ok: true, user: { ...account } };
    },
  };
}
