import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// TOTP secrets are stored encrypted with AES-256-GCM.
// Layout: 12-byte IV | 16-byte auth tag | ciphertext.

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`MFA encryption key must be exactly ${KEY_BYTES} bytes`);
  }
}

export function encryptSecret(plain: string, key: Buffer): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(buf: Buffer, key: Buffer): string {
  assertKey(key);
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted MFA secret is too short');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  // final() throws when the tag does not match (tampered data or wrong key).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Decodes the base64 MFA key. Errors never echo the value. */
export function parseMfaKey(base64: string): Buffer {
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error('MFA encryption key must be base64');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MFA encryption key must decode to exactly ${KEY_BYTES} bytes (generate with: openssl rand -base64 32)`,
    );
  }
  return key;
}
