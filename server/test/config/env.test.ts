import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import {
  CRM_KEY_VALUE,
  MEDIA_ROOT_VALUE,
  MFA_KEY_VALUE,
  REQUIRED_VARS,
  SECRET_TOKEN_VALUE,
  validEnv,
  validProdEnv,
} from './valid-env.js';

function without(...names: string[]): Record<string, string> {
  const env = validEnv();
  for (const name of names) delete env[name];
  return env;
}

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('loadConfig', () => {
  it('parses a complete valid environment and applies defaults', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.DB_PORT).toBe(5432);
    expect(cfg.DB_SSL).toBe(false);
    expect(cfg.PORT).toBe(4100);
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.DB_POOL_MAX).toBe(10);
    expect(cfg.DB_STATEMENT_TIMEOUT_MS).toBe(10_000);
    expect(cfg.ACADEMY_PROVISIONING).toBe(false);
    expect(cfg.REDIS_URL).toBeUndefined();
  });

  it('parses the string false as false and true as true', () => {
    expect(loadConfig({ ...validEnv(), ACADEMY_V2: 'false' }).ACADEMY_V2).toBe(false);
    expect(loadConfig({ ...validEnv(), ACADEMY_V2: 'true' }).ACADEMY_V2).toBe(true);
    expect(loadConfig({ ...validEnv(), STAGE1_AUTH_REQUIRED: 'true' }).STAGE1_AUTH_REQUIRED).toBe(
      true,
    );
  });

  // The five settings D18/D19 made meaningless (Mattermost, SES) and the four
  // nothing ever read are gone. An environment that still has them on the
  // server must start, not refuse: leftovers in a .env are not an error.
  it('ignores the removed settings instead of refusing to start', () => {
    const cfg = loadConfig({
      ...validEnv(),
      SES_REGION: 'eu-west-2',
      SES_SENDER: 'academy@example.com',
      MATTERMOST_URL: 'http://localhost:8065',
      MATTERMOST_BOT_TOKEN: SECRET_TOKEN_VALUE,
      MATTERMOST_IT_CHANNEL_ID: 'channel-synthetic',
      PROVISIONING_RESPONDERS: 'someone',
      SESSION_SECRET: 'x'.repeat(40),
      AUTH_STRICT: 'true',
      CRM_PUBLIC_URL: 'http://localhost:3000',
    });
    expect(cfg.ACADEMY_V2).toBe(false);
    expect(cfg).not.toHaveProperty('SESSION_SECRET');
    expect(cfg).not.toHaveProperty('MATTERMOST_URL');
  });

  it('defaults NODE_ENV to development when it is not set', () => {
    const env = validEnv();
    delete env.NODE_ENV;
    // A live server that leaves NODE_ENV out runs in development mode: an
    // insecure cookie and a mock CRM would be allowed. .env.example says so.
    expect(loadConfig(env).NODE_ENV).toBe('development');
    expect(loadConfig(env).COOKIE_SECURE).toBe(false);
  });

  it('rejects a boolean that is not exactly true or false', () => {
    const err = configError({ ...validEnv(), ACADEMY_V2: 'yes' });
    expect(err.invalid).toEqual(['ACADEMY_V2']);
    expect(err.message).not.toContain('yes');
  });

  it.each(REQUIRED_VARS)('names %s when it is missing', (name) => {
    const err = configError(without(name));
    expect(err.missing).toEqual([name]);
    expect(err.invalid).toEqual([]);
    expect(err.message).toContain(name);
  });

  it('treats a blank value as missing', () => {
    const err = configError({ ...validEnv(), CRM_AUTH_KEY: '  ' });
    expect(err.missing).toEqual(['CRM_AUTH_KEY']);
  });

  it('names every missing variable at once', () => {
    const err = configError(without('DB_PASSWORD', 'MEDIA_ROOT', 'PUBLIC_BASE_URL'));
    expect(err.missing).toEqual(['DB_PASSWORD', 'MEDIA_ROOT', 'PUBLIC_BASE_URL']);
    for (const name of err.missing) expect(err.message).toContain(name);
  });

  it('never prints a secret value in the error message', () => {
    const env = {
      ...validEnv(),
      CRM_AUTH_URL: SECRET_TOKEN_VALUE,
      DB_PASSWORD: 'short-pw',
    };
    const err = configError(env);
    expect(err.invalid).toEqual(['CRM_AUTH_URL', 'DB_PASSWORD']);
    expect(err.message).not.toContain(SECRET_TOKEN_VALUE);
    expect(err.message).not.toContain('short-pw');
    expect(err.message).not.toContain(CRM_KEY_VALUE);
  });

  it('requires REDIS_URL only in production', () => {
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: 'development' })).not.toThrow();
    const err = configError({ ...validProdEnv(), REDIS_URL: '' });
    expect(err.missing).toEqual(['REDIS_URL']);
    expect(loadConfig(validProdEnv()).REDIS_URL).toBe('redis://localhost:6379');
  });

  it('rejects a DB_PASSWORD shorter than 12 characters', () => {
    const err = configError({ ...validEnv(), DB_PASSWORD: 'x'.repeat(11) });
    expect(err.invalid).toEqual(['DB_PASSWORD']);
    expect(err.message).toContain('at least 12 characters');
    expect(loadConfig({ ...validEnv(), DB_PASSWORD: 'x'.repeat(12) }).DB_PASSWORD).toHaveLength(12);
  });

  it('requires https for CRM_AUTH_URL and PUBLIC_BASE_URL in production only', () => {
    // http is fine on a laptop: Vite and the mock CRM both serve it.
    expect(() => loadConfig(validEnv())).not.toThrow();

    const both = configError({
      ...validProdEnv(),
      CRM_AUTH_URL: 'http://crm.example.invalid/api/auth/academy-verify',
      PUBLIC_BASE_URL: 'http://academy.example.invalid',
    });
    expect(both.invalid).toEqual(['CRM_AUTH_URL', 'PUBLIC_BASE_URL']);

    const one = configError({
      ...validProdEnv(),
      PUBLIC_BASE_URL: 'http://academy.example.invalid',
    });
    expect(one.invalid).toEqual(['PUBLIC_BASE_URL']);

    const cfg = loadConfig(validProdEnv());
    expect(cfg.PUBLIC_BASE_URL).toBe('https://academy.example.invalid');
    expect(cfg.CRM_AUTH_URL.startsWith('https://')).toBe(true);
  });

  it('defaults CRM_AUTH_MODE to http and decodes the MFA key to 32 bytes', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.CRM_AUTH_MODE).toBe('http');
    expect(cfg.CRM_AUTH_KEY).toBe(CRM_KEY_VALUE);
    expect(Buffer.isBuffer(cfg.MFA_ENCRYPTION_KEY)).toBe(true);
    expect(cfg.MFA_ENCRYPTION_KEY).toHaveLength(32);
  });

  it('requires CRM_AUTH_KEY (32+ characters) when CRM_AUTH_MODE is http', () => {
    expect(configError(without('CRM_AUTH_KEY')).missing).toEqual(['CRM_AUTH_KEY']);
    const short = configError({ ...validEnv(), CRM_AUTH_KEY: 'k'.repeat(31) });
    expect(short.invalid).toEqual(['CRM_AUTH_KEY']);
    expect(short.message).not.toContain('k'.repeat(31));
  });

  it('does not need CRM_AUTH_KEY in mock mode outside production', () => {
    const env = { ...without('CRM_AUTH_KEY'), CRM_AUTH_MODE: 'mock', NODE_ENV: 'development' };
    expect(loadConfig(env).CRM_AUTH_MODE).toBe('mock');
  });

  it('refuses CRM_AUTH_MODE=mock in production', () => {
    const err = configError({ ...validProdEnv(), CRM_AUTH_MODE: 'mock' });
    expect(err.invalid).toEqual(['CRM_AUTH_MODE']);
    expect(err.message).toContain('refused in production');
  });

  it('rejects an unknown CRM_AUTH_MODE', () => {
    expect(configError({ ...validEnv(), CRM_AUTH_MODE: 'fake' }).invalid).toEqual([
      'CRM_AUTH_MODE',
    ]);
  });

  it.each([
    ['not base64', 'not base64 at all!'],
    ['16 bytes', Buffer.alloc(16, 2).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 2).toString('base64')],
  ])('rejects an MFA_ENCRYPTION_KEY that is %s, without echoing it', (_label, value) => {
    const err = configError({ ...validEnv(), MFA_ENCRYPTION_KEY: value });
    expect(err.invalid).toEqual(['MFA_ENCRYPTION_KEY']);
    expect(err.message).not.toContain(value);
  });

  it('never prints the MFA key or the CRM key', () => {
    const err = configError(without('DB_HOST'));
    expect(err.message).not.toContain(MFA_KEY_VALUE);
    expect(err.message).not.toContain(CRM_KEY_VALUE);
  });

  it('requires MEDIA_ROOT and refuses a relative path', () => {
    // Media lives on the server's own disk (D15). A relative path would follow
    // whatever working directory pm2 happened to start in, so it is refused.
    expect(loadConfig(validEnv()).MEDIA_ROOT).toBe(MEDIA_ROOT_VALUE);
    expect(configError({ ...validEnv(), MEDIA_ROOT: './media' }).invalid).toEqual(['MEDIA_ROOT']);
    expect(configError({ ...validEnv(), MEDIA_ROOT: 'media/recordings' }).invalid).toEqual([
      'MEDIA_ROOT',
    ]);
    const err = configError({ ...validEnv(), MEDIA_ROOT: '  ' });
    expect(err.missing).toEqual(['MEDIA_ROOT']);
  });

  it('defaults MEDIA_MAX_UPLOAD_MB to 200 and rejects a silly value', () => {
    expect(loadConfig(validEnv()).MEDIA_MAX_UPLOAD_MB).toBe(200);
    expect(loadConfig({ ...validEnv(), MEDIA_MAX_UPLOAD_MB: '500' }).MEDIA_MAX_UPLOAD_MB).toBe(500);
    for (const bad of ['0', '-5', 'lots', '1.5']) {
      expect(configError({ ...validEnv(), MEDIA_MAX_UPLOAD_MB: bad }).invalid).toEqual([
        'MEDIA_MAX_UPLOAD_MB',
      ]);
    }
  });

  it('defaults COOKIE_SECURE to true in production and false elsewhere', () => {
    expect(loadConfig(validEnv()).COOKIE_SECURE).toBe(false);
    const prod = validProdEnv();
    expect(loadConfig(prod).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...prod, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...validEnv(), COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(configError({ ...validEnv(), COOKIE_SECURE: 'yes' }).invalid).toEqual(['COOKIE_SECURE']);
  });
});
