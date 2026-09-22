import { describe, expect, it } from 'vitest';
import {
  codeForStep,
  generateEnrolment,
  stepAt,
  verifyCode,
} from '../../../src/modules/auth/totp.js';

// RFC 6238 test secret ("12345678901234567890") in base32.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOW = 1_790_000_015_000; // fixed instant, mid-step
const STEP = stepAt(NOW);

describe('totp', () => {
  it('matches the RFC 6238 SHA1 vector (T=59s, last 6 digits of 94287082)', () => {
    expect(codeForStep(SECRET, 1)).toBe('287082');
  });

  it('accepts the current code and returns its step', () => {
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP), null, NOW)).toEqual({
      ok: true,
      step: STEP,
    });
  });

  it('accepts the previous and next step', () => {
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP - 1), null, NOW)).toEqual({
      ok: true,
      step: STEP - 1,
    });
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP + 1), null, NOW)).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it('rejects codes two steps away', () => {
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP - 2), null, NOW)).toEqual({ ok: false });
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP + 2), null, NOW)).toEqual({ ok: false });
  });

  it('rejects a replay of the same or an earlier step', () => {
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP), STEP, NOW)).toEqual({ ok: false });
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP - 1), STEP, NOW)).toEqual({ ok: false });
    expect(verifyCode(SECRET, codeForStep(SECRET, STEP + 1), STEP, NOW)).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345']) {
      expect(verifyCode(SECRET, bad, null, NOW)).toEqual({ ok: false });
    }
  });

  it('generates an enrolment with a PNG QR and a labelled otpauth URI', async () => {
    const e = await generateEnrolment('trainee.one@example.com');
    expect(e.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(e.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(e.otpauthUri).toContain('issuer=FAC%20Academy');
    expect(e.otpauthUri).toContain(encodeURIComponent('trainee.one@example.com'));
    expect(e.otpauthUri).toContain(`secret=${e.secret}`);
    const now = Date.now();
    expect(verifyCode(e.secret, codeForStep(e.secret, stepAt(now)), null, now).ok).toBe(true);
  });
});
