import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvFileNotFound, loadDotenvIfPresent } from '../../src/config/dotenv.js';

// ENV_FILE is how the real server points at its environment file (pm2 sets it).
// A typo there used to be invisible: the file was skipped, nothing said so, and
// the only symptom was the config refusing to start with a list of missing
// variables that never mentioned the file.

const TEST_VAR = 'ACADEMY_DOTENV_TEST_VALUE';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'academy-dotenv-'));
}

const cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
  delete process.env.ENV_FILE;
  delete process.env[TEST_VAR];
});

describe('loadDotenvIfPresent', () => {
  it('throws EnvFileNotFound, naming ENV_FILE and the path, when the file is not there', () => {
    const missing = join(tempDir(), 'not-here.env');
    process.env.ENV_FILE = missing;

    expect(() => loadDotenvIfPresent()).toThrow(EnvFileNotFound);
    try {
      loadDotenvIfPresent();
      expect.unreachable('loadDotenvIfPresent should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvFileNotFound);
      const error = err as EnvFileNotFound;
      expect(error.path).toBe(resolve(missing));
      expect(error.message).toContain('ENV_FILE');
      expect(error.message).toContain(missing);
    }
  });

  it('treats a blank ENV_FILE as unset rather than as a missing file', () => {
    process.chdir(tempDir());
    process.env.ENV_FILE = '   ';
    expect(loadDotenvIfPresent()).toBeNull();
  });

  it('loads the file ENV_FILE names and returns its resolved path', () => {
    const file = join(tempDir(), 'given.env');
    writeFileSync(file, `${TEST_VAR}=from-env-file\n`);
    process.env.ENV_FILE = file;

    expect(loadDotenvIfPresent()).toBe(resolve(file));
    expect(process.env[TEST_VAR]).toBe('from-env-file');
  });

  it('never overrides a variable that is already set in the environment', () => {
    const file = join(tempDir(), 'given.env');
    writeFileSync(file, `${TEST_VAR}=from-env-file\n`);
    process.env.ENV_FILE = file;
    process.env[TEST_VAR] = 'from-the-real-environment';

    loadDotenvIfPresent();
    expect(process.env[TEST_VAR]).toBe('from-the-real-environment');
  });

  it('returns null when ENV_FILE is unset and there is no .env to find', () => {
    process.chdir(tempDir());
    expect(loadDotenvIfPresent()).toBeNull();
  });

  it('falls back to a .env in the working directory when ENV_FILE is unset', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${TEST_VAR}=from-cwd\n`);
    process.chdir(dir);

    expect(loadDotenvIfPresent()).toBe(resolve(dir, '.env'));
    expect(process.env[TEST_VAR]).toBe('from-cwd');
  });
});
