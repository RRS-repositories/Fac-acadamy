import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { certVerifyUrl } from '@fac-academy/shared';
import type { CertKind } from '@fac-academy/shared';
import type { MediaStore } from '../media/store.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import type { AuditActor } from '../modules/audit/audit.js';
import { renderCertificatePdf } from './render.js';
import type { CertificateDocument } from './render.js';
import {
  findForTarget,
  insertCertificate,
  loadHolder,
  recordRenderedFile,
  setCompletionCertificateRef,
  trackLabel,
} from './repo.js';
import type { CertificateRow } from './repo.js';

// Issuing a certificate: the row, the PDF, the stored file and the pointer on
// the completion row.
//
// Where it runs: straight after the quiz transaction commits, beside the
// manager-notify job (quiz.routes.ts). Not inside the transaction, because
// rendering a PDF in a browser is far too slow to hold a database transaction
// open, and not in a worker either, because a trainee who has just passed
// expects their certificate to be there when the page reloads.
//
// It never decides *whether* a level or a department is complete. That rule
// lives in completions.ts and is not repeated here: this module is told what
// was completed and issues one certificate for it.
//
// Idempotent, twice over:
//   * the insert is ON CONFLICT DO NOTHING against the partial unique indexes
//     from migration 0002 (one certificate per trainee per level, per
//     department, per track), so issuing twice produces one certificate;
//   * a certificate whose PDF is missing (a failed render, a restore that
//     missed MEDIA_ROOT) is re-rendered on the next issue or download, and the
//     row, the public id and the date all stay as they were.

/** Where certificate PDFs live inside the media store (D15: not S3). */
export const CERT_KEY_PREFIX = 'academy/certs';

export function certKey(publicId: string): string {
  return `${CERT_KEY_PREFIX}/${publicId}.pdf`;
}

export const CERT_CONTENT_TYPE = 'application/pdf';

/**
 * An unguessable public id: 18 random bytes as base64url, 24 characters.
 *
 * Long enough that the verify endpoint cannot be walked (2^144 possibilities,
 * behind a 30-a-minute rate limit), and inside the 12–64 character CHECK that
 * migration 0002 puts on the column. base64url only, so it is safe in a URL,
 * in a filename and in a QR code.
 */
export function newPublicId(): string {
  return randomBytes(18).toString('base64url');
}

export interface IssueTarget {
  traineeId: number;
  kind: CertKind;
  /** levels.id for a LEVEL certificate, else null. */
  levelId?: number | null;
  /** departments.code for a DEPT certificate, else null. */
  dept?: string | null;
  /** The trainee's track, frozen into the row. */
  track: string;
  /** Who caused it. Defaults to 'system' (an automatic issue on a pass). */
  issuedBy?: AuditActor;
}

export interface IssuedCertificate {
  certificate: CertificateRow;
  /** True only on the call that created the row (the audit row is written then). */
  newlyIssued: boolean;
  /** True when this call produced and stored the PDF. */
  rendered: boolean;
}

export interface CertificateIssuerDeps {
  db: Pool;
  /** The same local store the recordings use (D15). */
  store: MediaStore;
  /** PUBLIC_BASE_URL: the verification line printed on the PDF. */
  publicBaseUrl: string;
  /** Swapped out in tests so the suite does not launch a browser 20 times. */
  render?: (doc: CertificateDocument) => Promise<Buffer>;
}

export interface CertificateIssuer {
  /** Issue (or complete) the certificate for one milestone. */
  issue(target: IssueTarget): Promise<IssuedCertificate | null>;
  /** A level was completed. */
  issueForLevel(input: {
    traineeId: number;
    levelId: number;
    track: string;
  }): Promise<IssuedCertificate | null>;
  /** A department academy was completed. */
  issueForDept(input: {
    traineeId: number;
    dept: string;
    track: string;
  }): Promise<IssuedCertificate | null>;
  /**
   * Make sure the PDF for an existing certificate is on disk, rendering it if
   * it is not. Used by the download route so a missing file repairs itself.
   */
  ensureRendered(certificate: CertificateRow): Promise<CertificateRow>;
}

export function createCertificateIssuer(deps: CertificateIssuerDeps): CertificateIssuer {
  const render = deps.render ?? renderCertificatePdf;

  /** Render, store, and record the key, size and checksum. */
  async function renderAndStore(certificate: CertificateRow): Promise<CertificateRow> {
    const key = certKey(certificate.publicId);
    const doc: CertificateDocument = {
      holderName: certificate.holderName,
      title: certificate.title,
      accomplishment: certificate.accomplishment,
      trackLabel: trackLabel(certificate.track),
      issuedAt: certificate.issuedAt,
      publicId: certificate.publicId,
      verifyUrl: certVerifyUrl(deps.publicBaseUrl, certificate.publicId),
    };
    const pdf = await render(doc);
    const stored = await deps.store.put(key, pdf, { contentType: CERT_CONTENT_TYPE });
    await recordRenderedFile(deps.db, certificate.id, {
      mediaKey: stored.key,
      byteSize: stored.size,
      checksum: stored.sha256,
      contentType: CERT_CONTENT_TYPE,
    });
    return { ...certificate, mediaKey: stored.key, byteSize: stored.size };
  }

  async function ensureRendered(certificate: CertificateRow): Promise<CertificateRow> {
    if (certificate.mediaKey !== null) {
      const stat = await deps.store.stat(certificate.mediaKey);
      if (stat !== null) return certificate;
      // The row says there is a file and the disk disagrees. D15 warns that
      // backups must include MEDIA_ROOT; either way, re-rendering is cheap and
      // the certificate is unchanged, so repair it rather than fail.
      console.warn(
        `[academy-certs] certificate ${certificate.publicId}: stored PDF missing, re-rendering`,
      );
    }
    return renderAndStore(certificate);
  }

  async function issue(target: IssueTarget): Promise<IssuedCertificate | null> {
    const levelId = target.levelId ?? null;
    const dept = target.dept ?? null;
    const holder = await loadHolder(deps.db, target.traineeId);
    if (holder === null) return null; // the trainee row went while we worked

    const existing = await findForTarget(deps.db, {
      traineeId: target.traineeId,
      kind: target.kind,
      levelId,
      dept,
    });

    let certificate = existing;
    let newlyIssued = false;

    if (certificate === null) {
      const inserted = await insertCertificate(deps.db, {
        publicId: newPublicId(),
        traineeId: target.traineeId,
        kind: target.kind,
        levelId,
        dept,
        track: target.track,
        // Frozen here: a later rename never rewrites an issued certificate.
        holderName: holder.fullName,
        issuedBy: target.issuedBy ?? actor.system,
      });
      // Nothing inserted means a parallel request won the unique index; read
      // its row back so both callers describe the same certificate.
      certificate = await findForTarget(deps.db, {
        traineeId: target.traineeId,
        kind: target.kind,
        levelId,
        dept,
      });
      if (certificate === null) return null;
      newlyIssued = inserted !== null;
    }

    if (newlyIssued) {
      // One audit row per certificate, written on the call that created it.
      // Key names avoid the audit scrubber's redact list (no 'code', 'token'…).
      await writeAudit(deps.db, {
        traineeId: target.traineeId,
        eventType: 'CERT_ISSUED',
        actor: target.issuedBy ?? actor.system,
        payload: {
          certificate: certificate.publicId,
          kind: certificate.kind,
          level: certificate.levelId,
          dept: certificate.dept,
          track: certificate.track,
        },
      });
    }

    const before = certificate.mediaKey;
    const withFile = await ensureRendered(certificate);
    await setCompletionCertificateRef(
      deps.db,
      { traineeId: target.traineeId, levelId, dept },
      withFile.publicId,
    );

    return { certificate: withFile, newlyIssued, rendered: before !== withFile.mediaKey };
  }

  return {
    issue,
    issueForLevel: ({ traineeId, levelId, track }) =>
      issue({ traineeId, kind: 'LEVEL', levelId, dept: null, track }),
    issueForDept: ({ traineeId, dept, track }) =>
      issue({ traineeId, kind: 'DEPT', levelId: null, dept, track }),
    ensureRendered,
  };
}
