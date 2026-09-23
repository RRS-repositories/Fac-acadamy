import type { Pool } from 'pg';
import type { CertificateJob, CertificateRenderer } from '../jobs/certificateJobs.js';
import {
  composeCertificateEmail,
  deliverCertificateEmail,
  markCertificateEmailSent,
  recordCertificateEmail,
} from './email.js';
import type { CertificateIssuer } from './issue.js';
import { findLevelIdByNumber, loadHolder } from './repo.js';

// The `certificates` queue handler.
//
// S08 owns the queue, the worker and the payload contract
// (server/src/jobs/certificateJobs.ts): `{ kind: 'LEVEL', traineeId, level }`
// or `{ kind: 'DEPARTMENT', traineeId, dept }`, enqueued through
// `producers.enqueueCertificate(...)` on the queue named `certificates`.
// S09 supplies this one function to the worker and never touches BullMQ.
//
// What it does, in order: make sure the certificate exists and its PDF is
// stored (the same idempotent issuer the API calls, so the job and the request
// can race safely), then compose the email, record it, and log that it was not
// sent — because no provider has been chosen. See email.ts for that decision.
//
// Note on payload shape: the queue contract carries ids and codes only, never
// a certificate id, because the job may well run before the API has issued
// anything. The handler resolves the certificate itself, which is also what
// makes it safe to re-drive an old job by hand.

export interface CertificateJobDeps {
  db: Pool;
  issuer: CertificateIssuer;
  /** PUBLIC_BASE_URL: the links inside the composed email. */
  publicBaseUrl: string;
}

export function createCertificateJobHandler(deps: CertificateJobDeps): CertificateRenderer {
  return async function handleCertificateJob(job: CertificateJob): Promise<void> {
    const holder = await loadHolder(deps.db, job.traineeId);
    if (holder === null) {
      console.warn(
        `[academy-certs] certificate job for trainee ${String(job.traineeId)}: no such trainee`,
      );
      return;
    }
    if (holder.track === null) {
      // certificates.track_code is NOT NULL and references academy.tracks, and
      // a certificate without a programme would be meaningless anyway (D13: a
      // new trainee has no track until a manager assigns one).
      console.warn(
        `[academy-certs] certificate job for trainee ${String(job.traineeId)}: no track assigned`,
      );
      return;
    }

    let issued;
    if (job.kind === 'LEVEL') {
      const levelId = await findLevelIdByNumber(deps.db, job.level);
      if (levelId === null) {
        console.warn(`[academy-certs] certificate job: no level ${String(job.level)}`);
        return;
      }
      issued = await deps.issuer.issueForLevel({
        traineeId: job.traineeId,
        levelId,
        track: holder.track,
      });
    } else {
      issued = await deps.issuer.issueForDept({
        traineeId: job.traineeId,
        dept: job.dept,
        track: holder.track,
      });
    }
    if (issued === null) return;

    const message = composeCertificateEmail({
      certificate: issued.certificate,
      to: holder.email,
      publicBaseUrl: deps.publicBaseUrl,
    });
    // One row per certificate: a retried job (BullMQ is at-least-once) records
    // once and would send once.
    const recorded = await recordCertificateEmail(deps.db, issued.certificate.id, message);
    if (!recorded) return;

    const delivery = await deliverCertificateEmail(message);
    await markCertificateEmailSent(deps.db, issued.certificate.id, delivery);
  };
}
