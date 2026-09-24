import { z } from 'zod';

// Client for the CRM's academy sign-in endpoint (POST CRM_AUTH_URL). The
// academy never reads CRM tables; this HTTP call is the only way it checks a
// CRM email + password. Anything other than a clear answer from the CRM
// (network error, timeout, 5xx, 404 when the CRM side is switched off, a
// rejected academy key, a malformed body) is reported as 'unavailable'.
// Logs never include the password, the key or the response body.

export interface CrmUser {
  id: number;
  email: string;
  fullName: string;
  role: string;
  isApproved: boolean;
  locked: boolean;
}

export type CrmVerifyResult =
  | { ok: true; user: CrmUser }
  | {
      ok: false;
      reason: 'invalid_credentials' | 'not_approved' | 'locked' | 'rate_limited' | 'unavailable';
    };

export interface CrmClient {
  verify(email: string, password: string, clientIp?: string): Promise<CrmVerifyResult>;
}

export interface HttpCrmClientOptions {
  url: string;
  key: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Defaults to console.error. Receives short, secret-free lines only. */
  log?: (line: string) => void;
}

const CrmUserSchema = z.object({
  id: z.number().int().positive(),
  email: z.string().min(1),
  fullName: z.string(),
  role: z.string(),
  isApproved: z.boolean(),
  locked: z.boolean(),
});

const OkBodySchema = z.object({ ok: z.literal(true), user: CrmUserSchema });
const ErrorBodySchema = z.object({ ok: z.literal(false), error: z.string() });

const UNAVAILABLE: CrmVerifyResult = { ok: false, reason: 'unavailable' };

export function createHttpCrmClient(opts: HttpCrmClientOptions): CrmClient {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.error(line));

  // Log each distinct cause once, so a CRM outage does not flood the log.
  const logged = new Set<string>();
  const unavailable = (cause: string): CrmVerifyResult => {
    if (!logged.has(cause)) {
      logged.add(cause);
      log(`[academy-auth] CRM sign-in unavailable: ${cause}`);
    }
    return UNAVAILABLE;
  };

  return {
    async verify(email, password, clientIp) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-academy-key': opts.key,
      };
      if (clientIp !== undefined && clientIp !== '') headers['x-academy-client-ip'] = clientIp;

      let res: Response;
      try {
        res = await fetchImpl(opts.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : 'unknown';
        return unavailable(
          name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `network error (${name})`,
        );
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }

      if (res.status === 200) {
        const parsed = OkBodySchema.safeParse(body);
        if (!parsed.success) return unavailable('malformed 200 response');
        return { ok: true, user: parsed.data.user };
      }

      const errorCode = ErrorBodySchema.safeParse(body).data?.error;
      switch (res.status) {
        case 401:
          if (errorCode === 'invalid_credentials') {
            return { ok: false, reason: 'invalid_credentials' };
          }
          return unavailable('CRM rejected the academy key (401)');
        case 403:
          return { ok: false, reason: 'not_approved' };
        case 423:
          return { ok: false, reason: 'locked' };
        case 429:
          return { ok: false, reason: 'rate_limited' };
        case 400:
          // Our own request was malformed as far as the CRM is concerned. The
          // route validates input first, so treat it as bad credentials.
          return { ok: false, reason: 'invalid_credentials' };
        case 404:
          return unavailable('CRM endpoint not found or switched off (404)');
        default:
          return unavailable(`unexpected status ${res.status}`);
      }
    },
  };
}
