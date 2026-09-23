import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_VARS, validEnv } from '../config/valid-env.js';

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
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of CONFIG_VARS) delete env[name];
    Object.assign(env, validEnv());
    delete env.MFA_ENCRYPTION_KEY;
    // Point at a file that does not exist so no local .env is loaded.
    env.ENV_FILE = fileURLToPath(new URL('./no-such-file.env', import.meta.url));

    const { code, stderr } = await runApi(env);
    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('MFA_ENCRYPTION_KEY');
  });
});
