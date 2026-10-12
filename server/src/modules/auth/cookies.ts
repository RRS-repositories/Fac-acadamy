import type { CookieOptions, Request, Response } from 'express';
import { isWellFormedId } from './sessions.js';

// The academy session cookie is HttpOnly, SameSite=Lax, Path=/ and host-only:
// no Domain attribute, so it is never sent to the CRM or any other
// fastactionclaims.com host. Secure follows COOKIE_SECURE (on in production).
// It has no Max-Age: the server enforces the 12 h idle expiry, and the cookie
// goes when the browser closes.

export const SESSION_COOKIE = 'academy_sid';

function base(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/' };
}

export function setSessionCookie(res: Response, id: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, id, base(secure));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, base(secure));
}

/** The cookie's id, or null when missing or not something this server issues. */
export function readCookieId(req: Request, name: string): string | null {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return null;
  const value = (cookies as Record<string, unknown>)[name];
  return isWellFormedId(value) ? value : null;
}
