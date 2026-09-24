import { useQuery } from '@tanstack/react-query';
import {
  AuthErrorSchema,
  HealthResponseSchema,
  LoginResponseSchema,
  MeSchema,
  MfaResponseSchema,
} from '@fac-academy/shared';

/**
 * A failed API call. `status` is the HTTP status (0 when the server could not
 * be reached). `code` is the server's error code (see AUTH_ERROR_CODES in the
 * shared auth contract), or one of the client-side codes:
 *   'flag_off'     the portal is switched off (503 { flag: 'off' })
 *   'network'      no response at all
 *   'bad_response' the response didn't match the shared contract
 *   'unknown'      any other failure
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? `API request failed (${status} ${code})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorCodeFrom(status, body) {
  if (status === 503 && body && body.flag === 'off') return 'flag_off';
  const parsed = AuthErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : 'unknown';
}

async function request(method, path, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', `Request to ${path} could not reach the server`);
  }

  if (!res.ok) {
    const data = await readJson(res);
    throw new ApiError(res.status, errorCodeFrom(res.status, data));
  }
  if (res.status === 204) return null;
  return readJson(res);
}

/** Parse a response with a shared zod schema; a mismatch becomes an ApiError. */
function parseWith(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/** GET a JSON endpoint on the same origin. Throws ApiError for any failure. */
export function apiGet(path) {
  return request('GET', path);
}

/** POST JSON to an endpoint on the same origin. Resolves to null on 204. */
export function apiPost(path, body) {
  return request('POST', path, body);
}

// --- Sign-in (S03) ----------------------------------------------------------

/** Step 1: CRM email + password → { next: 'challenge' } or { next: 'enrol', enrol }. */
export async function login(email, password) {
  return parseWith(LoginResponseSchema, await apiPost('/api/auth/login', { email, password }));
}

/** Step 2: the 6-digit authenticator code → the signed-in user. */
export async function verifyMfa(code) {
  return parseWith(MfaResponseSchema, await apiPost('/api/auth/mfa', { code })).me;
}

/** The signed-in user, or null when nobody is signed in (401). */
export async function fetchMe() {
  try {
    const data = await apiGet('/api/me');
    return parseWith(MeSchema, data?.me);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function logoutRequest() {
  await apiPost('/api/auth/logout');
}

export async function heartbeatRequest() {
  await apiPost('/api/auth/heartbeat');
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => HealthResponseSchema.parse(await apiGet('/api/health')),
  });
}
