import { describe, expect, it } from 'vitest';
import { resolveRole } from '../../../src/modules/auth/roles.js';

describe('resolveRole', () => {
  it.each([
    ['Management', null, 'MANAGER'],
    ['IT', null, 'STAFF'],
    ['Sales', null, 'STAFF'],
    ['management', null, 'STAFF'],
    ['', null, 'STAFF'],
    ['Management', 'STAFF', 'STAFF'],
    ['IT', 'MANAGER', 'MANAGER'],
    ['Sales', 'STAFF', 'STAFF'],
  ] as const)('CRM role %j with override %j gives %s', (crmRole, override, expected) => {
    expect(resolveRole(crmRole, override)).toBe(expected);
  });
});
