import { z } from 'zod';

// Certificate contract (S09): the trainee's own certificates, the download
// link, and the PUBLIC verification answer.
//
// This file ships to the browser, so it holds SHAPES only. Two rules shape it:
//
//  * Every word a trainee or a verifier reads — the level name, the department
//    academy's name, the accomplishment line — comes from the database at
//    runtime (seeded from the approved prototype in S02). None of that wording
//    is written here, or anywhere else in the repo.
//  * The public verify answer is deliberately thin: a name, what was
//    completed, the track, the kind and the date. No email, no score, no
//    stage detail, nothing else about the person. A certificate id is a
//    bearer token for those few facts and nothing more.

/** LEVEL: a level finished. DEPT: a department academy. TRACK: a whole track. */
export const CERT_KINDS = ['LEVEL', 'DEPT', 'TRACK'] as const;
export const CertKindSchema = z.enum(CERT_KINDS);
export type CertKind = z.infer<typeof CertKindSchema>;

/**
 * One of the signed-in trainee's certificates (GET /api/certs).
 *
 * `title` and `accomplishment` are read from academy.levels /
 * academy.departments at request time; `holderName` and `track` were frozen
 * into the row when the certificate was issued, so a later rename or track
 * change never rewrites history.
 */
export const CertificateSchema = z.object({
  /** The unguessable id in the URL: 22+ characters of base64url. */
  publicId: z.string(),
  kind: CertKindSchema,
  /** What was completed, as the database words it. */
  title: z.string(),
  /** The accomplishment line from the database, or null when there is none. */
  accomplishment: z.string().nullable(),
  /** The track code frozen at issue ('CS', 'ADMIN', ...). */
  track: z.string(),
  /** The name printed on the PDF, frozen at issue. */
  holderName: z.string(),
  /** ISO-8601. */
  issuedAt: z.string(),
  revoked: z.boolean(),
  /** True when the PDF is stored and can be downloaded right now. */
  downloadable: z.boolean(),
});
export type Certificate = z.infer<typeof CertificateSchema>;

/** GET /api/certs — the signed-in trainee's certificates, newest first. */
export const MyCertificatesResponseSchema = z.object({
  certificates: z.array(CertificateSchema),
});
export type MyCertificatesResponse = z.infer<typeof MyCertificatesResponseSchema>;

/**
 * GET /api/cert/:publicId/verify — PUBLIC, no session.
 *
 * A real, unrevoked id answers `valid: true` with the five facts below.
 * Anything else — an id that never existed, a tampered id, a revoked
 * certificate — answers exactly `{ valid: false }`, so the response never
 * tells the caller which of those it was.
 */
export const CertVerifyResponseSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    /** The holder's name as printed on the certificate. */
    name: z.string(),
    /** The track code frozen at issue. */
    track: z.string(),
    kind: CertKindSchema,
    /** What they completed, in the database's own words. */
    completed: z.string(),
    /** ISO-8601. */
    issuedAt: z.string(),
  }),
  z.object({ valid: z.literal(false) }),
]);
export type CertVerifyResponse = z.infer<typeof CertVerifyResponseSchema>;

/** Every certificate failure is `{ error: CertErrorCode }`, status as noted. */
export const CERT_ERROR_CODES = [
  // 404 covers all of: no such id, a malformed id, a revoked certificate, and
  // somebody else's certificate. A trainee is never told which — an id must
  // not become a way of asking whether a colleague passed something.
  'not_found',
  'not_signed_in', // 401 no session on a route that needs one
  'rate_limited', // 429 too many verify requests from one address
  'internal', // 500 the certificate exists but its PDF could not be produced
] as const;
export type CertErrorCode = (typeof CERT_ERROR_CODES)[number];
export const CertErrorSchema = z.object({ error: z.enum(CERT_ERROR_CODES) });
export type CertError = z.infer<typeof CertErrorSchema>;

/**
 * The shape of a public id: base64url, long enough that it cannot be guessed.
 * Migration 0002 has the same rule as a CHECK constraint (12–64 characters);
 * everything we issue is 22 or more, and the routes refuse anything shorter
 * before touching the database.
 */
export const CERT_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
export const CertPublicIdSchema = z.string().regex(CERT_PUBLIC_ID_PATTERN);

/** Verify requests allowed from one IP address in a minute (S09 task 3). */
export const CERT_VERIFY_RATE_LIMIT_PER_MINUTE = 30;

/** In-app download (owner or manager, signed in). */
export function certDownloadPath(publicId: string): string {
  return `/api/certs/${encodeURIComponent(publicId)}/download`;
}

/** The public verify endpoint. */
export function certVerifyApiPath(publicId: string): string {
  return `/api/cert/${encodeURIComponent(publicId)}/verify`;
}

/** The page a verifier visits — the line printed on every certificate. */
export function certVerifyPath(publicId: string): string {
  return `/verify/${encodeURIComponent(publicId)}`;
}

/** The absolute verification URL printed on the PDF. */
export function certVerifyUrl(baseUrl: string, publicId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${certVerifyPath(publicId)}`;
}
