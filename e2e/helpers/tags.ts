import type { FullConfig } from '@playwright/test';

// The one tag that decides what a machine with no training content can run.
//
// The training content is seeded from the approved prototype HTML, which holds
// six real client call recordings and real staff names and so can never be
// committed. A GitHub runner therefore has a migrated but EMPTY database. A
// test carrying `@content-free` needs no stage, lesson, quiz, recording or
// certificate, and runs anywhere; every other test in this suite needs the
// seeded content and cannot.
//
// The tag is the single source of truth for that split.
// `scripts/check-e2e-coverage.mjs` reads it back out of Playwright's own test
// list and compares it against e2e-coverage.json, so the set cannot change
// without somebody editing the ledger and saying why.

export const CONTENT_FREE_TAG = '@content-free';

/** The `--grep` / `-g` value this Playwright process was started with, if any. */
function grepFromCommandLine(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--grep' || arg === '-g') return argv[i + 1] ?? '';
    if (arg.startsWith('--grep=')) return arg.slice('--grep='.length);
  }
  return null;
}

/**
 * True when this run has been restricted to the content-free tests — the only
 * selection that is honest on a database with no content in it.
 *
 * Two places are checked, because Playwright does not fold a command-line
 * `--grep` into the `FullConfig` it hands to global setup: the config file's
 * own `grep`, and the process arguments. `--grep-invert` is deliberately not
 * consulted: inverting the tag selects everything that needs content, which is
 * the opposite of what this asks.
 */
export function isContentFreeSelection(config: FullConfig): boolean {
  const greps = Array.isArray(config.grep) ? config.grep : [config.grep];
  if (greps.some((g) => g instanceof RegExp && g.source.includes(CONTENT_FREE_TAG))) return true;
  const fromCli = grepFromCommandLine(process.argv);
  return fromCli !== null && fromCli.includes(CONTENT_FREE_TAG);
}
