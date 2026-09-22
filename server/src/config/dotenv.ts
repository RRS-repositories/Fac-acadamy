import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Loads a local .env for development. Production passes real environment
// variables (or its own .env via ENV_FILE); nothing here provides defaults.
// Workspace scripts run with cwd = server/, so the repo-root .env is one up.
export function loadDotenvIfPresent(): string | null {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      // Never overrides variables that are already set in the environment.
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}
