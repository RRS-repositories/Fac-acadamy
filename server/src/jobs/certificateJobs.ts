// certificates: the queue contract between this section (S08, the queue and
// the worker) and Section 09 (the certificate renderer).
//
// S09 owns server/src/certs/**. It does NOT need to know about BullMQ: it
// enqueues through `producers.enqueueCertificate(job)` and supplies a
// renderer function to the worker. This file is the documented payload both
// sides agree on, so neither has to edit the other's code.
//
// QUEUE: 'certificates' (plain name, prefix 'academy' — never 'academy:...',
// BullMQ 6 throws on a ':' in a queue name).
//
// PAYLOAD (ids and codes only, never a name or an email — the renderer reads
// the trainee's name out of the database itself):
//
//   { kind: 'LEVEL',      traineeId, level }      a level certificate
//   { kind: 'DEPARTMENT', traineeId, dept }       a department certificate
//
// IDEMPOTENCY: the jobId is `cert-<kind>-<traineeId>-<ref>`, so the same
// milestone enqueued twice is one job. The renderer must ALSO be idempotent
// (BullMQ is at-least-once): write the academy.certificates row with
// ON CONFLICT DO NOTHING and re-use the existing PDF when there is one.
//
// RETRIES: the queue default — 5 attempts, exponential backoff from 2 s. A
// job that exhausts them is parked in the dead-letter bay with its payload and
// error, and can be re-driven once the cause is fixed.

export const CERTIFICATE_JOBS = {
  /** Render (or re-use) one certificate PDF and record it. */
  render: 'render',
} as const;

export type CertificateJobName = (typeof CERTIFICATE_JOBS)[keyof typeof CERTIFICATE_JOBS];

export interface LevelCertificateJob {
  kind: 'LEVEL';
  traineeId: number;
  /** levels.level_number (1..5), not the row id. */
  level: number;
}

export interface DepartmentCertificateJob {
  kind: 'DEPARTMENT';
  traineeId: number;
  /** departments.code. */
  dept: string;
}

export type CertificateJob = LevelCertificateJob | DepartmentCertificateJob;

/** The one function Section 09 supplies to the worker. */
export type CertificateRenderer = (job: CertificateJob) => Promise<void>;

/** The reference half of the jobId: the thing the certificate is for. */
export function certificateRef(job: CertificateJob): string {
  return job.kind === 'LEVEL' ? `level-${String(job.level)}` : `dept-${job.dept}`;
}
