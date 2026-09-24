// Checklist 03, "repo-wide grep for the old demo passcode → zero matches".
// The needle is built from parts so this file does not match itself. Scans
// every repository file, tracked or new-and-not-ignored.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const NEEDLE = ['FAC', '2026'].join('');

function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out.split('\0').filter((f) => f !== '');
}

describe('no demo passcode in the repository', () => {
  it('no file contains the old demo passcode', { timeout: 60_000 }, () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const rel of repoFiles()) {
      const abs = join(repoRoot, rel);
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        continue; // deleted in the working tree
      }
      if (size > 20 * 1024 * 1024) continue;
      scanned++;
      if (readFileSync(abs).toString('latin1').toUpperCase().includes(NEEDLE)) hits.push(rel);
    }
    expect(scanned).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });
});
