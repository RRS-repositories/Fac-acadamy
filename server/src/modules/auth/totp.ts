import { timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// TOTP as used by Microsoft / Google Authenticator: 30-second step, 6 digits,
// SHA1. We compute the step numbers ourselves so the matched step is known and
// can be stored for replay protection.

const STEP_SECONDS = 30;
const STEP_MS = STEP_SECONDS * 1000;
const DIGITS = 6;
/** Accept the previous, current and next step (clock drift). */
const WINDOW = 1;

const base = authenticator.clone({ step: STEP_SECONDS, digits: DIGITS });

export interface Enrolment {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export async function generateEnrolment(
  account: string,
  issuer = 'FAC Academy',
): Promise<Enrolment> {
  // 20 bytes = 160 bits, the RFC 4226 recommended length; 32 base32 chars.
  const secret = base.generateSecret(20);
  const otpauthUri = base.keyuri(account, issuer, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { type: 'image/png', margin: 1 });
  return { secret, otpauthUri, qrDataUrl };
}

export function stepAt(ms: number): number {
  return Math.floor(ms / STEP_MS);
}

/** The code for a given step (used by tests and by verifyCode). */
export function codeForStep(secret: string, step: number): string {
  return base.clone({ epoch: step * STEP_MS }).generate(secret);
}

export type VerifyResult = { ok: true; step: number } | { ok: false };

export function verifyCode(
  secret: string,
  code: string,
  lastUsedStep: number | null,
  now: number = Date.now(),
): VerifyResult {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const given = Buffer.from(code, 'utf8');
  const current = stepAt(now);
  let matched: number | null = null;
  // Check every step in the window (no early exit) to keep timing uniform.
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    const expected = Buffer.from(codeForStep(secret, step), 'utf8');
    const equal = expected.length === given.length && timingSafeEqual(expected, given);
    // Replay protection: a step at or before the last accepted one never counts.
    const fresh = lastUsedStep === null || step > lastUsedStep;
    if (equal && fresh && matched === null) matched = step;
  }
  if (matched === null) return { ok: false };
  return { ok: true, step: matched };
}
