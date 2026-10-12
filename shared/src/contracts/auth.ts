import { z } from 'zod';
import { ROLES, TRACK_CODES } from '../constants.js';
import type { TrackCode } from '../constants.js';

// Sign-in contract (S03). Flow: POST /api/auth/login (CRM email + password)
// → session cookie (HttpOnly) + the signed-in user, in one step. There is no
// authenticator-app step: it was removed because it blocked new joiners
// (decision D21). The browser never sees a token.

export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MeSchema = z.object({
  id: z.number().int().positive(),
  fullName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  /** null = waiting for a manager to assign a track (decision D13) */
  track: z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]).nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const LoginResponseSchema = z.object({ me: MeSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** Every auth failure is { error: AuthErrorCode } with the HTTP status noted. */
export const AUTH_ERROR_CODES = [
  'invalid_request', // 400
  'invalid_credentials', // 401 wrong email/password (never says which)
  'not_signed_in', // 401 no or expired session
  'forbidden', // 403 staff calling a manager route
  'not_approved', // 403 CRM account not approved
  'disabled', // 403 academy account disabled by a manager
  'locked', // 423 CRM lock, or too many failed attempts
  'rate_limited', // 429
  'auth_unavailable', // 503 the CRM could not be reached
] as const;
export const AuthErrorSchema = z.object({ error: z.enum(AUTH_ERROR_CODES) });
export type AuthError = z.infer<typeof AuthErrorSchema>;
