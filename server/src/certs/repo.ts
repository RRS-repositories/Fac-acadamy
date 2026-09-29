import type { Pool, PoolClient } from 'pg';
import { TRACKS } from '@fac-academy/shared';
import type { CertKind } from '@fac-academy/shared';

// Every SQL statement the certificate module runs lives here, so there is one
// place to read when checking what it touches. Nothing in this file decides
// who may see a certificate: the routes do that.

export type Db = Pool | PoolClient;

/** One certificate row, with the wording joined in at read time. */
export interface CertificateRow {
  id: number;
  publicId: string;
  traineeId: number;
  kind: CertKind;
  levelId: number | null;
  dept: string | null;
  /** The track code frozen at issue. */
  track: string;
  /** The name frozen at issue — never the trainee's current name. */
  holderName: string;
  mediaKey: string | null;
  byteSize: number | null;
  issuedAt: Date;
  revokedAt: Date | null;
  /**
   * How many modules (DEPT) or stages (LEVEL) this certificate covers, frozen
   * at issue (migration 0013). It is what lets a trainee hold the certificate
   * for the two-module academy and the one for the three-module academy at the
   * same time, both valid. Null for a TRACK award, and for a certificate
   * issued before 0013 whose scope could not be inferred.
   */
  scopeSize: number | null;
  /** From academy.levels / academy.departments, read now, never stored. */
  title: string;
  accomplishment: string | null;
}

interface DbCertificate {
  id: string;
  public_id: string;
  trainee_id: string;
  kind: string;
  level_id: number | null;
  dept: string | null;
  track_code: string;
  holder_name: string;
  media_key: string | null;
  byte_size: string | null;
  issued_at: Date;
  revoked_at: Date | null;
  scope_size: number | null;
  level_number: number | null;
  level_name: string | null;
  level_accomplishment: string | null;
  dept_name: string | null;
  dept_label: string | null;
  dept_accomplishment: string | null;
}

/** The human label for a track code ('CS' → 'Customer Service'). */
export function trackLabel(code: string | null): string {
  return TRACKS.find((t) => t.code === code)?.label ?? code ?? '';
}

/**
 * What a certificate says it is for, in the database's own words.
 *
 * A LEVEL certificate is titled from academy.levels ("Level 2: Working
 * Claims"), a DEPT one from academy.departments.academy_name (the prototype's
 * "... Academy"), and a TRACK one from the track's own label. No wording is
 * written here or anywhere else in the repo — the words come from the S02
 * seed, which read them from the approved prototype.
 */
function titleOf(row: DbCertificate): string {
  if (row.kind === 'LEVEL') {
    const name = row.level_name ?? '';
    const number = row.level_number;
    if (number === null) return name;
    return name === '' ? `Level ${String(number)}` : `Level ${String(number)}: ${name}`;
  }
  if (row.kind === 'DEPT') return row.dept_name ?? row.dept_label ?? row.dept ?? '';
  return trackLabel(row.track_code);
}

function toRow(row: DbCertificate): CertificateRow {
  return {
    id: Number(row.id),
    publicId: row.public_id,
    traineeId: Number(row.trainee_id),
    kind: row.kind as CertKind,
    levelId: row.level_id,
    dept: row.dept,
    track: row.track_code,
    holderName: row.holder_name,
    mediaKey: row.media_key,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    scopeSize: row.scope_size,
    title: titleOf(row),
    accomplishment:
      row.kind === 'LEVEL'
        ? row.level_accomplishment
        : row.kind === 'DEPT'
          ? row.dept_accomplishment
          : null,
  };
}

const SELECT_CERTIFICATE = `
  SELECT c.id, c.public_id, c.trainee_id, c.kind, c.level_id, c.dept, c.track_code,
         c.holder_name, c.media_key, c.byte_size, c.issued_at, c.revoked_at,
         c.scope_size,
         l.level_number, l.name AS level_name, l.accomplishment AS level_accomplishment,
         d.academy_name AS dept_name, d.label AS dept_label,
         d.accomplishment AS dept_accomplishment
    FROM academy.certificates c
    LEFT JOIN academy.levels l      ON l.id = c.level_id
    LEFT JOIN academy.departments d ON d.code = c.dept`;

/** One certificate by its public id. */
export async function findByPublicId(db: Db, publicId: string): Promise<CertificateRow | null> {
  const { rows } = await db.query<DbCertificate>(`${SELECT_CERTIFICATE} WHERE c.public_id = $1`, [
    publicId,
  ]);
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

/** One trainee's certificates, newest first. */
export async function listForTrainee(db: Db, traineeId: number): Promise<CertificateRow[]> {
  const { rows } = await db.query<DbCertificate>(
    `${SELECT_CERTIFICATE} WHERE c.trainee_id = $1 ORDER BY c.issued_at DESC, c.id DESC`,
    [traineeId],
  );
  return rows.map(toRow);
}

/** What identifies one certificate: the trainee, the milestone, and its scope. */
export interface CertificateTarget {
  traineeId: number;
  kind: CertKind;
  levelId: number | null;
  dept: string | null;
  /**
   * The scope the certificate covers (migration 0013). Part of the identity,
   * not a detail: the certificate for the two-module Admin academy and the one
   * for the three-module Admin academy are different certificates and both are
   * valid, so a lookup that ignored this would find the old one and the grown
   * academy would never be certified.
   */
  scopeSize: number | null;
}

/**
 * The certificate for one milestone at one scope. `level_id`, `dept` and
 * `scope_size` are compared with IS NOT DISTINCT FROM so a NULL matches a NULL
 * — `= NULL` would never match and would issue a second certificate every
 * time. The two partial unique indexes from 0013 are declared NULLS NOT
 * DISTINCT for exactly the same reason, so the lookup and the index agree.
 */
export async function findForTarget(
  db: Db,
  target: CertificateTarget,
): Promise<CertificateRow | null> {
  const { rows } = await db.query<DbCertificate>(
    `${SELECT_CERTIFICATE}
      WHERE c.trainee_id = $1
        AND c.kind = $2
        AND c.level_id IS NOT DISTINCT FROM $3
        AND c.dept IS NOT DISTINCT FROM $4
        AND c.scope_size IS NOT DISTINCT FROM $5`,
    [target.traineeId, target.kind, target.levelId, target.dept, target.scopeSize],
  );
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

/**
 * How much the completion behind this milestone covers — the number this
 * certificate is for.
 *
 * Read from the completion row rather than counted here on purpose. The
 * completion rule (modules/training/completions.ts) is the only thing allowed
 * to decide that an academy is finished and how big it was when it was; if the
 * issuer counted the modules itself, a certificate job re-driven by hand after
 * the academy grew again would mint a certificate for work nobody has done.
 * Reading the recorded scope makes the job safe to re-drive at any time, and
 * makes the request and the worker agree without talking to each other.
 *
 * Null means "unknown, or no completion row", which is a legitimate lookup key
 * and matches the certificates issued before migration 0013.
 */
export async function loadCompletionScope(
  db: Db,
  target: { traineeId: number; kind: CertKind; levelId: number | null; dept: string | null },
): Promise<number | null> {
  if (target.kind === 'LEVEL' && target.levelId !== null) {
    const { rows } = await db.query<{ stages_covered: number | null }>(
      `SELECT stages_covered FROM academy.level_completions
        WHERE trainee_id = $1 AND level_id = $2`,
      [target.traineeId, target.levelId],
    );
    return rows[0]?.stages_covered ?? null;
  }
  if (target.kind === 'DEPT' && target.dept !== null) {
    const { rows } = await db.query<{ modules_covered: number | null }>(
      `SELECT modules_covered FROM academy.dept_completions
        WHERE trainee_id = $1 AND dept = $2`,
      [target.traineeId, target.dept],
    );
    return rows[0]?.modules_covered ?? null;
  }
  // A TRACK award covers a whole track: there is no count to record.
  return null;
}

/** The holder's name and email, read once at issue and then frozen in the row. */
export async function loadHolder(
  db: Db,
  traineeId: number,
): Promise<{ fullName: string; email: string; track: string | null } | null> {
  const { rows } = await db.query<{ full_name: string; email: string; track: string | null }>(
    'SELECT full_name, email, track FROM academy.trainees WHERE id = $1',
    [traineeId],
  );
  const row = rows[0];
  return row === undefined ? null : { fullName: row.full_name, email: row.email, track: row.track };
}

/**
 * academy.levels.id for a level NUMBER (1..5). The queue payload carries the
 * number people use, not the row id (see jobs/certificateJobs.ts), so the job
 * handler translates it here rather than assuming the two are the same.
 */
export async function findLevelIdByNumber(db: Db, levelNumber: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM academy.levels WHERE level_number = $1',
    [levelNumber],
  );
  const row = rows[0];
  return row === undefined ? null : Number(row.id);
}

/**
 * Insert the certificate unless one already exists for this milestone at this
 * scope.
 *
 * The partial unique indexes make this safe under concurrency: two requests
 * that complete the same level at the same moment both try, one inserts, the
 * other does nothing and reads the winner back. Returns null when it inserted
 * nothing.
 *
 * Since 0013 the level and department indexes carry `scope_size` as well, so
 * finishing a grown academy inserts beside the earlier certificate instead of
 * colliding with it. `ON CONFLICT DO NOTHING` names no index on purpose — it
 * covers whichever of them applies, and did so before 0013 too.
 */
export async function insertCertificate(
  db: Db,
  values: {
    publicId: string;
    traineeId: number;
    kind: CertKind;
    levelId: number | null;
    dept: string | null;
    track: string;
    holderName: string;
    issuedBy: string;
    scopeSize: number | null;
  },
): Promise<{ id: number; publicId: string } | null> {
  const { rows } = await db.query<{ id: string; public_id: string }>(
    `INSERT INTO academy.certificates
       (public_id, trainee_id, kind, level_id, dept, track_code, holder_name, issued_by,
        scope_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id, public_id`,
    [
      values.publicId,
      values.traineeId,
      values.kind,
      values.levelId,
      values.dept,
      values.track,
      values.holderName,
      values.issuedBy,
      values.scopeSize,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : { id: Number(row.id), publicId: row.public_id };
}

/** Record the stored PDF against the certificate. */
export async function recordRenderedFile(
  db: Db,
  certificateId: number,
  file: { mediaKey: string; byteSize: number; checksum: string; contentType: string },
): Promise<void> {
  await db.query(
    `UPDATE academy.certificates
        SET media_key = $2, byte_size = $3, checksum_sha256 = $4,
            content_type = $5, rendered_at = now()
      WHERE id = $1`,
    [certificateId, file.mediaKey, file.byteSize, file.checksum, file.contentType],
  );
}

/**
 * Point the completion row at the certificate (S09 checklist: "certificate_ref
 * set on the completion row"). The value is the public id: the durable handle
 * that appears in the URL and on the PDF, and the one the stored key is built
 * from. Only ever written, never cleared.
 */
export async function setCompletionCertificateRef(
  db: Db,
  target: { traineeId: number; levelId: number | null; dept: string | null },
  publicId: string,
): Promise<void> {
  if (target.levelId !== null) {
    await db.query(
      `UPDATE academy.level_completions SET certificate_ref = $3
        WHERE trainee_id = $1 AND level_id = $2 AND certificate_ref IS DISTINCT FROM $3`,
      [target.traineeId, target.levelId, publicId],
    );
    return;
  }
  if (target.dept !== null) {
    await db.query(
      `UPDATE academy.dept_completions SET certificate_ref = $3
        WHERE trainee_id = $1 AND dept = $2 AND certificate_ref IS DISTINCT FROM $3`,
      [target.traineeId, target.dept, publicId],
    );
  }
}
