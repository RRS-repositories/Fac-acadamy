import type { Pool, PoolClient } from 'pg';
import { certVerifyUrl } from '@fac-academy/shared';
import type { CertificateRow } from './repo.js';

// The certificate email — composed, recorded, logged, and NOT sent.
//
// Why not sent: no email provider has been chosen (open question Q3; there is
// no AWS account, so SES is not a given). Rather than guess, the worker does
// everything except the last step: it writes the subject, the body and the
// name of the PDF that would be attached into academy.certificate_emails and
// logs a line. When a provider is finally picked, deliverCertificateEmail()
// below is the ONE function that changes, and the rows already in that table
// are the backlog to send.
//
// If the notification seam being built in S08 (server/src/modules/notifications)
// lands later, this is also the one place to route through it: compose here,
// hand the composed message over there, and leave the recording as it is.
//
// Nothing in this file holds training wording. The subject and the body are
// built from the certificate row, whose title and accomplishment were read
// from the database.

/** A composed message, ready for whichever provider is eventually chosen. */
export interface ComposedCertificateEmail {
  to: string;
  subject: string;
  /** Plain text. No HTML part: nothing in this message needs one. */
  bodyText: string;
  /**
   * The stored PDF that would be attached, as a media-store key — never a
   * filesystem path, and never the bytes. The sender fetches it from the
   * store when there is a sender.
   */
  attachmentKey: string | null;
}

export interface ComposeInput {
  certificate: CertificateRow;
  /** The trainee's current email address, read at compose time. */
  to: string;
  /** PUBLIC_BASE_URL, for the verification and download links. */
  publicBaseUrl: string;
}

export function composeCertificateEmail(input: ComposeInput): ComposedCertificateEmail {
  const { certificate } = input;
  const base = input.publicBaseUrl.replace(/\/+$/, '');
  const lines = [
    `Hello ${certificate.holderName},`,
    '',
    `You have completed ${certificate.title}. Your certificate is attached, and it is also in the academy under "My certificates".`,
  ];
  if (certificate.accomplishment !== null && certificate.accomplishment.trim() !== '') {
    lines.push('', certificate.accomplishment);
  }
  lines.push(
    '',
    `Certificate id: ${certificate.publicId}`,
    `Anyone can check it here: ${certVerifyUrl(base, certificate.publicId)}`,
    '',
    `Your certificates: ${base}/certificates`,
    '',
    'FAC Academy',
  );

  return {
    to: input.to,
    subject: `Your FAC Academy certificate: ${certificate.title}`,
    bodyText: lines.join('\n'),
    attachmentKey: certificate.mediaKey,
  };
}

/**
 * Record what would have been sent. Idempotent: one row per certificate
 * (certificate_emails_one_per_certificate), so a retried job records once.
 * Returns true when this call wrote the row.
 */
export async function recordCertificateEmail(
  db: Pool | PoolClient,
  certificateId: number,
  message: ComposedCertificateEmail,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO academy.certificate_emails
       (certificate_id, to_email, subject, body_text, attachment_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (certificate_id) DO NOTHING`,
    [certificateId, message.to, message.subject, message.bodyText, message.attachmentKey],
  );
  return res.rowCount === 1;
}

/** What the (future) provider said. `delivered` is false while there is none. */
export interface CertificateEmailDelivery {
  delivered: boolean;
  /** The provider that accepted it, once there is one. */
  provider: string | null;
  /** Its message id, for the audit trail. */
  providerRef: string | null;
}

/**
 * THE SEND POINT.
 *
 * TODO(email-provider-undecided — plan §3 Q3, and the S08 hand-over):
 * the firm has not chosen an email provider. The build spec assumed Amazon SES
 * (`SES_REGION` / `SES_SENDER` are still in the config schema), but there is no
 * AWS account, so it may end up being SMTP through Microsoft 365, or the
 * provider the CRM's `mail` schema already uses. Until Brad decides:
 *
 *   * nothing is sent — this function delivers nothing and says so;
 *   * every message is still composed and stored in
 *     academy.certificate_emails, so the backlog can be sent the day a
 *     provider exists;
 *   * this is the only function that has to change. Its callers already
 *     handle `delivered: false`.
 */
export function deliverCertificateEmail(
  message: ComposedCertificateEmail,
): Promise<CertificateEmailDelivery> {
  console.log(
    `[academy-certs] certificate email composed but NOT sent (no provider chosen): ` +
      `to=${message.to} subject=${JSON.stringify(message.subject)} ` +
      `attachment=${message.attachmentKey ?? 'none'}`,
  );
  return Promise.resolve({ delivered: false, provider: null, providerRef: null });
}

/** Mark a recorded email as really sent. Used once a provider exists. */
export async function markCertificateEmailSent(
  db: Pool | PoolClient,
  certificateId: number,
  delivery: CertificateEmailDelivery,
): Promise<void> {
  if (!delivery.delivered) return;
  await db.query(
    `UPDATE academy.certificate_emails
        SET sent_at = now(), provider = $2, provider_ref = $3
      WHERE certificate_id = $1 AND sent_at IS NULL`,
    [certificateId, delivery.provider, delivery.providerRef],
  );
}
