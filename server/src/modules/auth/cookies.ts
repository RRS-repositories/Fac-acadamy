import type { CookieOptions, Request, Response } from 'express';
import { PENDING_MFA_TTL_MS, isWellFormedId } from './sessions.js';

// Both academy cookies are HttpOnly, SameSite=Lax, Path=/ and host-only: no
// Domain attribute, so they are never sent to the CRM or any other
// fastactionclaims.com host. Secure follows COOKIE_SECURE (on in production).
// The session cookie has no Max-Age: the server enforces the 12 h idle expiry,
// and the cookie goes when the browser closes.

export const SESSION_COOKIE = 'academy_sid';
export const PENDING_MFA_COOKIE = 'academy_mfa';

function base(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/' };
}

export function setSessionCookie(res: Response, id: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, id, base(secure));
}

export function setPendingCookie(res: Response, id: string, secure: boolean): void {
  res.cookie(PENDING_MFA_COOKIE, id, { ...base(secure), maxAge: PENDING_MFA_TTL_MS });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, base(secure));
}

export function clearPendingCookie(res: Response, secure: boolean): void {
  res.clearCookie(PENDING_MFA_COOKIE, base(secure));
}

/** The cookie's id, or null when missing or not something this server issues. */
export function readCookieId(req: Request, name: string): string | null {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return null;
  const value = (cookies as Record<string, unknown>)[name];
  return isWellFormedId(value) ? value : null;
}
