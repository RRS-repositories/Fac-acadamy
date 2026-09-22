import { z } from 'zod';
import { ROLES, TRACK_CODES } from '../constants.js';
import type { TrackCode } from '../constants.js';

// Sign-in contract (S03). Flow: POST /api/auth/login (CRM email + password)
// → either enrol (first time: QR + manual key) or challenge (6-digit code)
// → POST /api/auth/mfa with the code → session cookie + the signed-in user.
// Between the two steps the server holds a short-lived pending state in an
// HttpOnly cookie; the browser never sees a token.

export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.discriminatedUnion('next', [
  z.object({
    next: z.literal('challenge'),
  }),
  z.object({
    next: z.literal('enrol'),
    enrol: z.object({
      /** data:image/png;base64 QR of the otpauth:// URI */
      qrDataUrl: z.string().startsWith('data:image/png;base64,'),
      /** base32 key for manual entry */
      secret: z.string().min(16),
      issuer: z.string(),
      account: z.string(),
    }),
  }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MfaRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type MfaRequest = z.infer<typeof MfaRequestSchema>;

export const MeSchema = z.object({
  id: z.number().int().positive(),
  fullName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  /** null = waiting for a manager to assign a track (decision D13) */
  track: z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]).nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const MfaResponseSchema = z.object({ me: MeSchema });
export type MfaResponse = z.infer<typeof MfaResponseSchema>;

/** Every auth failure is { error: AuthErrorCode } with the HTTP status noted. */
export const AUTH_ERROR_CODES = [
  'invalid_request', // 400
  'invalid_credentials', // 401 wrong email/password (never says which)
  'not_signed_in', // 401 no or expired session
  'mfa_required', // 401 the pending step is missing or expired: start again
  'invalid_code', // 401 wrong/replayed authenticator code
  'forbidden', // 403 staff calling a manager route
  'not_approved', // 403 CRM account not approved
  'disabled', // 403 academy account disabled by a manager
  'locked', // 423 CRM lock, or too many failed attempts
  'rate_limited', // 429
  'auth_unavailable', // 503 the CRM could not be reached
] as const;
export const AuthErrorSchema = z.object({ error: z.enum(AUTH_ERROR_CODES) });
export type AuthError = z.infer<typeof AuthErrorSchema>;
