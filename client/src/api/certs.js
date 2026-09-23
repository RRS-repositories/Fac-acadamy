import { useQuery } from '@tanstack/react-query';
import {
  CertVerifyResponseSchema,
  MyCertificatesResponseSchema,
  certDownloadPath,
  certVerifyApiPath,
} from '@fac-academy/shared';
import { ApiError } from './client.js';

/*
 * The certificate data layer (S09) — the only place the browser talks to the
 * certificate API.
 *
 * Two of these calls need a session and one does not:
 *
 *   GET /api/certs                      the signed-in trainee's certificates
 *   GET /api/certs/:id/download         the PDF (a plain link, not fetch)
 *   GET /api/cert/:id/verify            PUBLIC: anybody with the id
 *
 * Nothing here holds any wording: the level name, the academy name and the
 * accomplishment line all arrive from the server, which read them from the
 * database.
 */

export const certKeys = {
  all: ['certs'],
  mine: () => ['certs', 'mine'],
  verify: (publicId) => ['certs', 'verify', publicId],
};

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function failureFrom(status, body) {
  if (status === 503 && body && body.flag === 'off') return new ApiError(status, 'flag_off');
  const code = body && typeof body.error === 'string' ? body.error : 'unknown';
  return new ApiError(status, code);
}

async function certRequest(path) {
  let res;
  try {
    res = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'network', `Request to ${path} could not reach the server`);
  }
  if (!res.ok) throw failureFrom(res.status, await readJson(res));
  return readJson(res);
}

function parseWith(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/** The signed-in trainee's certificates, newest first. */
export async function fetchMyCertificates() {
  return parseWith(MyCertificatesResponseSchema, await certRequest('/api/certs'));
}

/** Check one certificate id. Public: no session, no cookie needed. */
export async function fetchVerification(publicId) {
  return parseWith(CertVerifyResponseSchema, await certRequest(certVerifyApiPath(publicId)));
}

/** The download URL for a certificate. A link, so the browser saves the file. */
export function downloadUrl(publicId) {
  return certDownloadPath(publicId);
}

const NO_RETRY = { retry: false, refetchOnWindowFocus: false };

export function useMyCertificates() {
  return useQuery({ queryKey: certKeys.mine(), queryFn: fetchMyCertificates, ...NO_RETRY });
}

/**
 * The public check. An id that does not exist is not an error — the server
 * answers `{ valid: false }` with a 200 — so the page has one success state
 * with two faces, and errors really are "we could not ask".
 */
export function useVerification(publicId) {
  return useQuery({
    queryKey: certKeys.verify(publicId),
    queryFn: () => fetchVerification(publicId),
    enabled: Boolean(publicId),
    ...NO_RETRY,
  });
}
