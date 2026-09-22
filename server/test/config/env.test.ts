import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { REQUIRED_VARS, SECRET_TOKEN_VALUE, validEnv } from './valid-env.js';

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
    expect(cfg.AUTH_STRICT).toBe(true);
    expect(cfg.REDIS_URL).toBeUndefined();
  });

  it('parses the string false as false and true as true', () => {
    expect(loadConfig({ ...validEnv(), ACADEMY_V2: 'false' }).ACADEMY_V2).toBe(false);
    expect(loadConfig({ ...validEnv(), ACADEMY_V2: 'true' }).ACADEMY_V2).toBe(true);
    expect(loadConfig({ ...validEnv(), AUTH_STRICT: 'false' }).AUTH_STRICT).toBe(false);
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
    const err = configError({ ...validEnv(), MATTERMOST_BOT_TOKEN: '  ' });
    expect(err.missing).toEqual(['MATTERMOST_BOT_TOKEN']);
  });

  it('names every missing variable at once', () => {
    const err = configError(without('DB_PASSWORD', 'SES_SENDER', 'MATTERMOST_BOT_TOKEN'));
    expect(err.missing).toEqual(['DB_PASSWORD', 'MATTERMOST_BOT_TOKEN', 'SES_SENDER']);
    for (const name of err.missing) expect(err.message).toContain(name);
  });

  it('never prints a secret value in the error message', () => {
    const env = {
      ...validEnv(),
      MATTERMOST_URL: SECRET_TOKEN_VALUE,
      SESSION_SECRET: 'short-secret',
    };
    const err = configError(env);
    expect(err.invalid).toEqual(['MATTERMOST_URL', 'SESSION_SECRET']);
    expect(err.message).not.toContain(SECRET_TOKEN_VALUE);
    expect(err.message).not.toContain('short-secret');
    expect(err.message).not.toContain('db-password-synthetic');
  });

  it('requires REDIS_URL only in production', () => {
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: 'development' })).not.toThrow();
    const err = configError({ ...validEnv(), NODE_ENV: 'production' });
    expect(err.missing).toEqual(['REDIS_URL']);
    const cfg = loadConfig({
      ...validEnv(),
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(cfg.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    const err = configError({ ...validEnv(), SESSION_SECRET: 'x'.repeat(31) });
    expect(err.invalid).toEqual(['SESSION_SECRET']);
    const cfg = loadConfig({ ...validEnv(), SESSION_SECRET: 'x'.repeat(32) });
    expect(cfg.SESSION_SECRET).toHaveLength(32);
  });
});
