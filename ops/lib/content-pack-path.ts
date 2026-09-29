// Resolves the approved content pack for the ops scripts (ops/seed/seed-pack-content.ts).
//
// The prototype is not the only source of training content any more. A content
// pack is a single JSON file holding a module the prototype never described:
// its lessons as HTML, its quiz, its options and which option is correct.
//
// Data hygiene: a pack carries the same two classes of material the prototype
// does — the department's own commercial rules and worked cases drawn from real
// client files — plus every correct answer in plain text. So it lives OUTSIDE
// this repo, exactly like the prototype, and is read through CONTENT_PACK_PATH.
// scripts/check-forbidden-files.mjs is extension-based and would NOT stop a
// pack being committed, which is why the refusal is enforced here instead.
//
// This is a near-copy of ops/lib/prototype-path.ts on purpose: two content
// sources, one rule, and the rule is legible in both places rather than hidden
// behind a shared abstraction that makes neither obvious.

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const INSIDE_REPO =
  'CONTENT_PACK_PATH points inside the repo. A content pack holds lesson text, the ' +
  'department rules and every correct answer: keep it outside the repo, beside the prototype.';

// Windows paths are case-insensitive: E:\RRC and e:\rrc are the same folder.
function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveContentPackPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['CONTENT_PACK_PATH']?.trim();
  if (!raw) {
    throw new Error(
      'CONTENT_PACK_PATH is not set. Point it at the content pack JSON, outside this repo.',
    );
  }

  const given = path.resolve(raw);
  if (!existsSync(given) || !statSync(given).isFile()) {
    throw new Error(`CONTENT_PACK_PATH does not point at a file: ${given}`);
  }

  // Check both the path as given and its real target, so a symlink cannot hide it.
  const resolved = realpathSync(given);
  const repoRoot = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;
  if (isInside(given, REPO_ROOT) || isInside(resolved, repoRoot)) {
    throw new Error(INSIDE_REPO);
  }

  return resolved;
}
