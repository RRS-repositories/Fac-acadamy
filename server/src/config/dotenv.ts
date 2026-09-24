import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Loads a local .env for development. Production passes real environment
// variables (or its own .env via ENV_FILE); nothing here provides defaults.
// Workspace scripts run with cwd = server/, so the repo-root .env is one up.

/**
 * ENV_FILE was set to a path with no file at it. Left silent, the only symptom
 * is the config refusing to start with a wall of missing variables and nothing
 * saying that the file it was told to read is not there — which is what a typo
 * in pm2's ENV_FILE, or an ecosystem file whose placeholder was never
 * replaced, looks like at 9am on deployment day.
 */
export class EnvFileNotFound extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `ENV_FILE points at a file that does not exist: ${path}. ` +
        "Set ENV_FILE to the environment file's absolute path, or unset it to use the .env beside the app.",
    );
    this.name = 'EnvFileNotFound';
    this.path = path;
  }
}

/**
 * Returns the file that was loaded, or null when there was none to load.
 * Throws {@link EnvFileNotFound} when ENV_FILE names a file that is not there:
 * an explicit path is a promise that the file exists, so a missing one is an
 * error rather than a silent fall-through to the defaults.
 */
export function loadDotenvIfPresent(): string | null {
  const explicit = process.env.ENV_FILE?.trim();
  if (explicit !== undefined && explicit !== '') {
    const file = resolve(explicit);
    if (!existsSync(file)) throw new EnvFileNotFound(file);
    // Never overrides variables that are already set in the environment.
    process.loadEnvFile(file);
    return file;
  }
  for (const file of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}
