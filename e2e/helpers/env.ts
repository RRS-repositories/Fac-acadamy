import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root and the local .env, for the suite's own database connection.
// Playwright runs with cwd = e2e/, so the root is one level up.

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_ROOT = path.join(REPO_ROOT, 'e2e');
/** Run state the suite writes and reads. Gitignored. */
export const STATE_DIR = path.join(E2E_ROOT, '.state');

let loaded = false;

/**
 * Loads the repo-root .env once, without overriding anything already set in
 * the environment (the same rule as server/src/config/dotenv.ts).
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = process.env['ENV_FILE'] ?? path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`e2e: ${name} is not set. The suite reads the repo-root .env.`);
  }
  return value;
}

/** The database the suite is allowed to touch. Never production (see db.ts). */
export function targetDatabase(): string {
  loadEnv();
  return process.env['E2E_DB_NAME'] ?? requireEnv('DB_NAME');
}

export function baseUrl(): string {
  loadEnv();
  return process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';
}
