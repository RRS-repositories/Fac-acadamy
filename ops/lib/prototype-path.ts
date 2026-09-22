// Resolves the approved prototype HTML for the ops scripts (seed in S02, media
// extraction in S06). Data hygiene: the prototype embeds real client call
// recordings and staff details, so it must live OUTSIDE this repo.

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const INSIDE_REPO =
  'PROTOTYPE_PATH points inside the repo. The prototype holds real client recordings and ' +
  'staff details: keep it in the build pack, outside the repo.';

// Windows paths are case-insensitive: E:\RRC and e:\rrc are the same folder.
function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolvePrototypePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['PROTOTYPE_PATH']?.trim();
  if (!raw) {
    throw new Error(
      'PROTOTYPE_PATH is not set. Point it at the prototype HTML in the build pack, outside this repo.',
    );
  }

  const given = path.resolve(raw);
  if (!existsSync(given) || !statSync(given).isFile()) {
    throw new Error(`PROTOTYPE_PATH does not point at a file: ${given}`);
  }

  // Check both the path as given and its real target, so a symlink cannot hide it.
  const resolved = realpathSync(given);
  const repoRoot = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;
  if (isInside(given, REPO_ROOT) || isInside(resolved, repoRoot)) {
    throw new Error(INSIDE_REPO);
  }

  return resolved;
}
