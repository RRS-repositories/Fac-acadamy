import type { Pool } from 'pg';
import { ROLES, TRACK_CODES } from '@fac-academy/shared';
import type { Me, Role, TrackCode } from '@fac-academy/shared';
import type { CrmUser } from '../../integrations/crm/crmClient.js';

// academy.trainees access for sign-in. The CRM account exists before day one
// (decision D11); the academy row is found by crm_user_id, else by email (and
// linked), else created with track NULL = waiting for a manager to assign one
// (decision D13).

export interface TraineeRow {
  id: number;
  crmUserId: number | null;
  fullName: string;
  email: string;
  track: TrackCode | null;
  isDisabled: boolean;
}

interface DbTrainee {
  id: string;
  crm_user_id: string | null;
  full_name: string;
  email: string;
  track: string | null;
  is_disabled: boolean;
}

const COLUMNS = 'id, crm_user_id, full_name, email, track, is_disabled';

function toTrackCode(value: string | null): TrackCode | null {
  return value !== null && (TRACK_CODES as readonly string[]).includes(value)
    ? (value as TrackCode)
    : null;
}

function toRow(r: DbTrainee): TraineeRow {
  return {
    id: Number(r.id),
    crmUserId: r.crm_user_id === null ? null : Number(r.crm_user_id),
    fullName: r.full_name,
    email: r.email,
    track: toTrackCode(r.track),
    isDisabled: r.is_disabled,
  };
}

export class CrmIdentityConflict extends Error {
  constructor() {
    super('The email belongs to an academy trainee linked to a different CRM user');
    this.name = 'CrmIdentityConflict';
  }
}

export async function findTraineeById(db: Pool, id: number): Promise<TraineeRow | null> {
  const { rows } = await db.query<DbTrainee>(
    `SELECT ${COLUMNS} FROM academy.trainees WHERE id = $1`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Find by CRM id, else by email (linking the CRM id), else create. */
export async function findOrCreateFromCrm(db: Pool, user: CrmUser): Promise<TraineeRow> {
  const byCrm = await db.query<DbTrainee>(
    `SELECT ${COLUMNS} FROM academy.trainees WHERE crm_user_id = $1`,
    [user.id],
  );
  if (byCrm.rows[0]) return toRow(byCrm.rows[0]);

  // email is CITEXT, so this match ignores case.
  const byEmail = await db.query<DbTrainee>(
    `SELECT ${COLUMNS} FROM academy.trainees WHERE email = $1`,
    [user.email],
  );
  const existing = byEmail.rows[0];
  if (existing) {
    if (existing.crm_user_id !== null) throw new CrmIdentityConflict();
    const linked = await db.query<DbTrainee>(
      `UPDATE academy.trainees SET crm_user_id = $2
       WHERE id = $1 AND crm_user_id IS NULL
       RETURNING ${COLUMNS}`,
      [existing.id, user.id],
    );
    if (linked.rows[0]) return toRow(linked.rows[0]);
    return findOrCreateFromCrm(db, user); // linked concurrently: read it again
  }

  const inserted = await db.query<DbTrainee>(
    `INSERT INTO academy.trainees (full_name, email, crm_user_id, track, status)
     VALUES ($1, $2, $3, NULL, 'ACTIVE')
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [user.fullName, user.email, user.id],
  );
  if (inserted.rows[0]) return toRow(inserted.rows[0]);
  // A concurrent first sign-in created it: read it again.
  const again = await db.query<DbTrainee>(
    `SELECT ${COLUMNS} FROM academy.trainees WHERE crm_user_id = $1`,
    [user.id],
  );
  if (again.rows[0]) return toRow(again.rows[0]);
  throw new CrmIdentityConflict();
}

/** The academy.role_overrides row for this CRM user, if any. */
export async function findRoleOverride(db: Pool, crmUserId: number | null): Promise<Role | null> {
  if (crmUserId === null) return null;
  const { rows } = await db.query<{ role: string }>(
    'SELECT role FROM academy.role_overrides WHERE crm_user_id = $1',
    [crmUserId],
  );
  const role = rows[0]?.role;
  return role !== undefined && (ROLES as readonly string[]).includes(role) ? (role as Role) : null;
}

export function toMe(t: TraineeRow, role: Role): Me {
  return { id: t.id, fullName: t.fullName, email: t.email, role, track: t.track };
}
