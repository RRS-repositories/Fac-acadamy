import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_VARS, validEnv, validProdEnv } from '../config/valid-env.js';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

// Every variable the config reads, so a developer's shell can't leak into the child.
const CONFIG_VARS = [
  ...REQUIRED_VARS,
  'NODE_ENV',
  'PORT',
  'HOST',
  'DB_SSL',
  'DB_POOL_MAX',
  'DB_STATEMENT_TIMEOUT_MS',
  'REDIS_URL',
  'ACADEMY_PROVISIONING',
  'CRM_AUTH_KEY',
  'CRM_AUTH_MODE',
  'COOKIE_SECURE',
  'MEDIA_MAX_UPLOAD_MB',
  'SMTP_URL',
];

/**
 * An environment file that exists but is empty, so the child loads nothing and
 * the repo's own .env is never picked up. ENV_FILE naming a file that is not
 * there is now itself a refusal to start (see the last test here), so a path
 * that does not exist cannot be used for this any more.
 */
const EMPTY_ENV_FILE = (() => {
  const file = join(mkdtempSync(join(tmpdir(), 'academy-boot-')), 'empty.env');
  writeFileSync(file, '# deliberately empty\n');
  return file;
})();

/** validEnv/validProdEnv plus an empty ENV_FILE, with the shell's own config vars removed. */
function childEnv(base: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFIG_VARS) delete env[name];
  Object.assign(env, base);
  env.ENV_FILE = EMPTY_ENV_FILE;
  return env;
}

function runApi(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/entry/api.ts'], {
      cwd: serverDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe('API boot', () => {
  it('refuses to start and names the missing variable', { timeout: 120_000 }, async () => {
    const env = childEnv(validEnv());
    delete env.MFA_ENCRYPTION_KEY;

    const { code, stderr } = await runApi(env);
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('MFA_ENCRYPTION_KEY');
  });

  // The three production-only rules, exercised by the real entry point rather
  // than by loadConfig alone: before this, the built app had only ever been
  // started with NODE_ENV=development, so nothing had ever proved that these
  // refusals reach the log instead of a stack trace.
  it('refuses the mock CRM in production', { timeout: 120_000 }, async () => {
    const { code, stderr } = await runApi(childEnv({ ...validProdEnv(), CRM_AUTH_MODE: 'mock' }));
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('CRM_AUTH_MODE');
    expect(stderr).toContain('refused in production');
  });

  it('refuses to start in production without REDIS_URL', { timeout: 120_000 }, async () => {
    const env = childEnv(validProdEnv());
    delete env.REDIS_URL;

    const { code, stderr } = await runApi(env);
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('REDIS_URL');
  });

  it('refuses to start when ENV_FILE names a file that is not there', async () => {
    const env = childEnv(validProdEnv());
    const missing = join(tmpdir(), 'academy-no-such-file.env');
    env.ENV_FILE = missing;

    const { code, stderr } = await runApi(env);
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('ENV_FILE');
    expect(stderr).toContain(missing);
    // The point of the fix: it must not be a bare list of missing variables.
    expect(stderr).not.toContain('missing environment variables');
  }, 120_000);
});
