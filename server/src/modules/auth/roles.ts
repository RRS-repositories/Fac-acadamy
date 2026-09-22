import type { Role } from '@fac-academy/shared';

// Only the CRM role 'Management' maps to MANAGER. An academy.role_overrides
// row, when present, wins in either direction. Everyone else is STAFF.
export function resolveRole(crmRole: string, override: Role | null): Role {
  if (override !== null) return override;
  return crmRole === 'Management' ? 'MANAGER' : 'STAFF';
}
