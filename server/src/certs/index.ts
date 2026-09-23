// The certificate module's public surface (S09). Everything outside
// server/src/certs imports from here.

export {
  createCertificateIssuer,
  certKey,
  newPublicId,
  CERT_KEY_PREFIX,
  CERT_CONTENT_TYPE,
} from './issue.js';
export type {
  CertificateIssuer,
  CertificateIssuerDeps,
  IssueTarget,
  IssuedCertificate,
} from './issue.js';
export { certsRouter } from './routes.js';
export type { CertRoutesDeps } from './routes.js';
export { certVerifyRouter } from './verify.routes.js';
export type { CertVerifyDeps } from './verify.routes.js';
export { createCertificateJobHandler } from './jobs.js';
export type { CertificateJobDeps } from './jobs.js';
export {
  composeCertificateEmail,
  deliverCertificateEmail,
  markCertificateEmailSent,
  recordCertificateEmail,
} from './email.js';
export type { ComposedCertificateEmail, CertificateEmailDelivery } from './email.js';
export { issueCertificatesForPass } from './onPass.js';
export type { PassCertificateInput } from './onPass.js';
export {
  certificateHtml,
  closeCertificateRenderer,
  formatIssuedDate,
  renderCertificatePdf,
  rendererIsRunning,
} from './render.js';
export type { CertificateDocument } from './render.js';
export { findByPublicId, listForTrainee, trackLabel } from './repo.js';
export type { CertificateRow } from './repo.js';
