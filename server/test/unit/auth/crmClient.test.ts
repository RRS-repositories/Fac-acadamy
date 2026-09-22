import { describe, expect, it, vi } from 'vitest';
import { createHttpCrmClient } from '../../../src/integrations/crm/crmClient.js';

const URL = 'http://crm.test/api/academy/verify';
const KEY = 'test-academy-key-not-real';
const PASSWORD = 'S3cret-Password-Should-Never-Log';

const user = {
  id: 42,
  email: 'someone@example.com',
  fullName: 'Some One',
  role: 'Sales',
  isApproved: true,
  locked: false,
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  });
}

function client(fetchImpl: typeof fetch, log = vi.fn<(line: string) => void>()) {
  return { crm: createHttpCrmClient({ url: URL, key: KEY, fetchImpl, log }), log };
}

describe('createHttpCrmClient', () => {
  it('sends the key, client IP and body, and returns the user on 200', async () => {
    const f = fakeFetch(200, { ok: true, user });
    const { crm } = client(f as unknown as typeof fetch);
    await expect(crm.verify('someone@example.com', PASSWORD, '10.0.0.9')).resolves.toEqual({
      ok: true,
      user,
    });
    const [calledUrl, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-academy-key']).toBe(KEY);
    expect(headers['x-academy-client-ip']).toBe('10.0.0.9');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'someone@example.com',
      password: PASSWORD,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the client IP header when none is given', async () => {
    const f = fakeFetch(200, { ok: true, user });
    const { crm } = client(f as unknown as typeof fetch);
    await crm.verify('someone@example.com', PASSWORD);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-academy-client-ip']).toBeUndefined();
  });

  it.each([
    [401, { ok: false, error: 'invalid_credentials' }, 'invalid_credentials'],
    [401, { ok: false, error: 'unauthorised_client' }, 'unavailable'],
    [403, { ok: false, error: 'not_approved' }, 'not_approved'],
    [423, { ok: false, error: 'locked' }, 'locked'],
    [429, { ok: false, error: 'rate_limited' }, 'rate_limited'],
    [400, { ok: false, error: 'invalid_request' }, 'invalid_credentials'],
    [404, 'Not Found', 'unavailable'],
    [500, { error: 'boom' }, 'unavailable'],
    [502, '<html>bad gateway</html>', 'unavailable'],
    [200, { ok: true, user: { id: 'x' } }, 'unavailable'],
    [200, 'not json', 'unavailable'],
    [200, { ok: false, error: 'invalid_credentials' }, 'unavailable'],
  ])('maps %i %j to %s', async (status, body, reason) => {
    const { crm } = client(fakeFetch(status, body) as unknown as typeof fetch);
    await expect(crm.verify('someone@example.com', PASSWORD)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('maps a network error to unavailable', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { crm, log } = client(f as unknown as typeof fetch);
    await expect(crm.verify('a@example.com', PASSWORD)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('maps a timeout to unavailable', async () => {
    const f = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const crm = createHttpCrmClient({
      url: URL,
      key: KEY,
      timeoutMs: 20,
      fetchImpl: f as unknown as typeof fetch,
      log: () => {},
    });
    await expect(crm.verify('a@example.com', PASSWORD)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('logs each outage cause once and never logs the password, key or email', async () => {
    const f = fakeFetch(500, { detail: PASSWORD });
    const { crm, log } = client(f as unknown as typeof fetch);
    await crm.verify('someone@example.com', PASSWORD);
    await crm.verify('someone@example.com', PASSWORD);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('someone@example.com');
  });
});
