import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseMfaKey } from '../../../src/modules/auth/mfaCrypto.js';

const key = randomBytes(32);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('mfaCrypto', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret(SECRET, key);
    const b = encryptSecret(SECRET, key);
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(12 + 16 + Buffer.byteLength(SECRET));
    expect(decryptSecret(a, key)).toBe(SECRET);
    expect(decryptSecret(b, key)).toBe(SECRET);
  });

  it.each([0, 12, 28, 30])('detects tampering at byte %i', (index) => {
    const buf = encryptSecret(SECRET, key);
    buf[index] = (buf[index] ?? 0) ^ 0x01;
    expect(() => decryptSecret(buf, key)).toThrow();
  });

  it('fails with the wrong key', () => {
    const buf = encryptSecret(SECRET, key);
    expect(() => decryptSecret(buf, randomBytes(32))).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => encryptSecret(SECRET, randomBytes(16))).toThrow(/32 bytes/);
    expect(() => decryptSecret(Buffer.alloc(40), randomBytes(31))).toThrow(/32 bytes/);
  });

  it('rejects a truncated buffer', () => {
    expect(() => decryptSecret(Buffer.alloc(10), key)).toThrow(/too short/);
  });

  describe('parseMfaKey', () => {
    it('accepts a base64 32-byte key', () => {
      expect(parseMfaKey(key.toString('base64')).equals(key)).toBe(true);
    });

    it('rejects a wrong length without echoing the value', () => {
      const short = randomBytes(16).toString('base64');
      expect(() => parseMfaKey(short)).toThrow(/32 bytes/);
      expect(() => parseMfaKey(short)).not.toThrow(short);
    });

    it('rejects non-base64 input without echoing it', () => {
      const bad = 'not base64 at all!!';
      expect(() => parseMfaKey(bad)).toThrow(/base64/);
      expect(() => parseMfaKey(bad)).not.toThrow(bad);
    });
  });
});
