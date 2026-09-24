import type { Producers } from '../queues/producers.js';
import type { CertificateIssuer } from './issue.js';

// What happens to certificates when a quiz pass completes a level or a
// department academy. One function, called by the quiz router straight after
// its transaction commits.
//
// Two things happen, on purpose:
//
//  1. **The certificate is issued now**, in the request. A trainee who has
//     just passed reloads the page and the certificate is there. Issuing is
//     idempotent (issue.ts), so this racing the worker is harmless.
//  2. **The `certificates` job is enqueued** through the S08 producers. The
//     worker composes the certificate email (and, until an email provider is
//     chosen, records it rather than sending it — see email.ts). The job also
//     re-renders the PDF if step 1 failed, which is why it is enqueued even
//     when the inline issue throws.
//
// Nothing in here decides what a pass completes: completions.ts does that and
// hands the answer over.

export interface PassCertificateInput {
  /** Null when the API is running without certificates wired (tests). */
  issuer: CertificateIssuer | null;
  producers: Producers;
  traineeId: number;
  track: string;
  /** Set only when THIS pass completed a level. */
  level: { levelId: number; levelNumber: number } | null;
  /** departments.code, set only when THIS pass completed the department. */
  dept: string | null;
}

/**
 * Issue the certificates this pass earned and queue their emails.
 *
 * Never throws: a certificate that cannot be produced must not turn a passed
 * quiz into a 500. Anything that goes wrong is logged, and the queued job is
 * the retry.
 */
export async function issueCertificatesForPass(input: PassCertificateInput): Promise<void> {
  const { level, dept, traineeId, track } = input;
  if (level === null && dept === null) return;

  if (level !== null) {
    try {
      await input.issuer?.issueForLevel({ traineeId, levelId: level.levelId, track });
    } catch (err) {
      console.error(
        `[academy-certs] could not issue the level ${String(level.levelNumber)} certificate ` +
          `for trainee ${String(traineeId)}:`,
        err,
      );
    }
    try {
      await input.producers.enqueueCertificate({
        kind: 'LEVEL',
        traineeId,
        level: level.levelNumber,
      });
    } catch (err) {
      console.error('[academy-certs] could not enqueue the level certificate job:', err);
    }
  }

  if (dept !== null) {
    try {
      await input.issuer?.issueForDept({ traineeId, dept, track });
    } catch (err) {
      console.error(
        `[academy-certs] could not issue the ${dept} certificate for trainee ` +
          `${String(traineeId)}:`,
        err,
      );
    }
    try {
      await input.producers.enqueueCertificate({ kind: 'DEPARTMENT', traineeId, dept });
    } catch (err) {
      console.error('[academy-certs] could not enqueue the department certificate job:', err);
    }
  }
}
