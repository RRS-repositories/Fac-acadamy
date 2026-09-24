#!/usr/bin/env node
// Make a browser test that CANNOT run in CI a fact somebody signed for.
//
// WHY THIS EXISTS
// ---------------
// The Playwright suite in e2e/ walks real user journeys through the real app,
// and almost all of them need the training content — the stages, lessons,
// quizzes and call recordings. That content is seeded from the approved
// prototype HTML, which holds six real client call recordings and real staff
// names and emails, so it can never be committed. A GitHub runner therefore
// has a migrated but EMPTY database, exactly as it has for the unit suites
// (see scripts/check-test-skips.mjs and test-skips.json).
//
// So most of this suite cannot run in CI. The danger is not that fact; it is
// the fact going unsaid. A workflow that runs 8 of 41 browser tests and prints
// a green tick tells a reviewer that the customer-service journey is covered.
// It is not.
//
// Every test therefore falls on one side of one tag, `@content-free`:
//
//   tagged   — needs no stage, lesson, quiz, recording or certificate, and so
//              runs anywhere, including CI;
//   untagged — needs the seeded content, and cannot run in CI at all.
//
// This script asks Playwright itself which tests carry the tag (no database,
// no browser, no app — just the test list) and compares that against
// e2e-coverage.json. It fails when:
//
//   * a tagged test is not in the ledger's `runsAnywhere`   (claim not signed)
//   * a ledger `runsAnywhere` entry no longer exists        (stale)
//   * a file has untagged tests and no ledger entry         (new blind spot)
//   * a file's untagged count differs from the ledger       (the blind spot
//                                                            grew or shrank)
//   * a ledger entry's file has no untagged tests any more  (stale)
//
// The counts are exact, not ceilings: unlike the unit ledger, this list comes
// from static collection and reads the same on every machine, so "about right"
// is not good enough.
//
// It also writes a plain-English summary to the GitHub job summary, so the
// green tick arrives next to the sentence "33 browser journeys did not run,
// here is what that leaves unchecked".
//
//   node scripts/check-e2e-coverage.mjs            # check
//   node scripts/check-e2e-coverage.mjs --update   # rewrite the ledger's lists

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_ROOT = path.join(REPO_ROOT, 'e2e');
const LEDGER_PATH = path.join(REPO_ROOT, 'e2e-coverage.json');
const TAG = '@content-free';

const UPDATE = process.argv.includes('--update');

// ---------------------------------------------------------------------------
// Ask Playwright for the test list
// ---------------------------------------------------------------------------

function playwrightCli() {
  const require = createRequire(path.join(REPO_ROOT, 'package.json'));
  try {
    return path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  } catch {
    return path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  }
}

/** Every test in the suite: repo-relative file, title, and whether it is tagged. */
function listTests(outDir) {
  const outFile = path.join(outDir, 'list.json');
  const result = spawnSync(
    process.execPath,
    [playwrightCli(), 'test', '--list', '--reporter=json'],
    {
      cwd: E2E_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outFile },
    },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    throw new Error(
      `playwright produced no readable test list (exit ${String(result.status)}).\n` +
        `stderr: ${(result.stderr || '').trim().split('\n').slice(-5).join('\n')}`,
    );
  }

  const tests = [];
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      // The JSON reporter prints tags without the leading '@'.
      const tags = (spec.tags ?? []).map((t) => (t.startsWith('@') ? t : `@${t}`));
      tests.push({ file, title: spec.title, contentFree: tags.includes(TAG) });
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  // `suite.file` is relative to the report's rootDir (e2e/tests). The ledger
  // keys are repo-relative with forward slashes, so they read the same on
  // Windows and on a runner.
  const rootDir = report.config?.rootDir ?? path.join(E2E_ROOT, 'tests');
  for (const suite of report.suites ?? []) {
    const abs = path.resolve(rootDir, String(suite.file));
    walk(suite, path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
  }
  if (tests.length === 0) throw new Error('playwright listed no tests at all.');
  return tests;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return { tag: TAG, runsAnywhere: {}, needsSeededContent: {} };
  }
}

function groupByFile(tests) {
  const byFile = new Map();
  for (const test of tests) {
    if (!byFile.has(test.file)) byFile.set(test.file, []);
    byFile.get(test.file).push(test.title);
  }
  return byFile;
}

function check(tests, ledger) {
  const problems = [];
  const declaredRuns = ledger.runsAnywhere ?? {};
  const declaredExcluded = ledger.needsSeededContent ?? {};

  if (ledger.tag !== TAG) {
    problems.push(
      `The ledger declares the tag "${String(ledger.tag)}" but the suite uses "${TAG}".`,
    );
  }

  // --- what runs: exact titles, both ways ---------------------------------
  const running = groupByFile(tests.filter((t) => t.contentFree));
  for (const [file, titles] of running) {
    const declared = declaredRuns[file] ?? [];
    for (const title of titles) {
      if (!declared.includes(title)) {
        problems.push(
          `UNDECLARED CLAIM: ${file} › "${title}" carries ${TAG} and would run in CI, but the\n` +
            '    ledger does not list it. Add it to runsAnywhere — and be sure it really needs\n' +
            '    no seeded content, because in CI there is none and it must not pass vacuously.',
        );
      }
    }
  }
  for (const [file, titles] of Object.entries(declaredRuns)) {
    for (const title of titles) {
      if (!(running.get(file) ?? []).includes(title)) {
        problems.push(
          `LOST COVERAGE: the ledger says ${file} › "${title}" runs in CI, but it no longer\n` +
            `    carries ${TAG} (or no longer exists). CI is testing less than the ledger claims.`,
        );
      }
    }
  }

  // --- what does not run: exact counts, both ways -------------------------
  const excluded = groupByFile(tests.filter((t) => !t.contentFree));
  for (const [file, titles] of excluded) {
    const entry = declaredExcluded[file];
    if (entry === undefined) {
      problems.push(
        `NEW BLIND SPOT: ${file} has ${String(titles.length)} test(s) that cannot run in CI and\n` +
          '    is not in e2e-coverage.json. Either give them the tag (only if they truly need no\n' +
          '    content), or add an entry saying why they cannot run and what is therefore unproven.',
      );
      continue;
    }
    if (entry.tests !== titles.length) {
      problems.push(
        `BLIND SPOT CHANGED: ${file} now has ${String(titles.length)} test(s) that cannot run in\n` +
          `    CI; the ledger says ${String(entry.tests)}. Update the count and the "unproven" line.\n` +
          `    Declared reason: ${String(entry.reason)}`,
      );
    }
  }
  for (const file of Object.keys(declaredExcluded)) {
    if (!excluded.has(file)) {
      problems.push(
        `STALE LEDGER ENTRY: ${file} has no tests that need seeded content any more — delete\n` +
          `    its entry. It said: ${String(declaredExcluded[file].reason)}`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function summarise(tests, ledger) {
  const runs = tests.filter((t) => t.contentFree).length;
  const excluded = tests.length - runs;
  const byFile = groupByFile(tests.filter((t) => !t.contentFree));

  const lines = [];
  lines.push('## Browser tests (Playwright): what ran and what could not', '');
  lines.push(
    `**${String(runs)} of ${String(tests.length)} browser tests ran here. ` +
      `${String(excluded)} did not run at all.**`,
    '',
  );
  if (excluded === 0) {
    lines.push('Every browser test ran.');
    return lines.join('\n');
  }
  lines.push(
    'The training content — stages, lessons, quizzes, call recordings — is seeded from the',
    'approved prototype HTML, which carries six real client call recordings and real staff',
    'names and so can never be committed. A runner has an empty database, so every journey',
    'through that content is impossible here. These did not run:',
    '',
  );
  lines.push('| Tests not run | Where | Why | What is therefore unproven here |');
  lines.push('|---:|---|---|---|');
  for (const [file, titles] of [...byFile].sort()) {
    const entry = ledger.needsSeededContent?.[file];
    lines.push(
      `| ${String(titles.length)} | \`${file}\` | ${entry?.reason ?? '**undeclared**'} | ` +
        `${entry?.unproven ?? '—'} |`,
    );
  }
  lines.push(
    '',
    `A green tick on this run does **not** cover the rows above. They run on a machine that`,
    'has the seeded content: `npm run test:e2e -w @fac-academy/e2e`.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/** Thrown to leave the block early without skipping the temp-directory cleanup. */
class Done extends Error {}

const outDir = mkdtempSync(path.join(tmpdir(), 'academy-e2e-coverage-'));
try {
  const tests = listTests(outDir);

  if (UPDATE) {
    const ledger = readLedger();
    const runsAnywhere = {};
    for (const [file, titles] of [...groupByFile(tests.filter((t) => t.contentFree))].sort()) {
      runsAnywhere[file] = titles;
    }
    const needsSeededContent = {};
    for (const [file, titles] of [...groupByFile(tests.filter((t) => !t.contentFree))].sort()) {
      needsSeededContent[file] = {
        tests: titles.length,
        reason: ledger.needsSeededContent?.[file]?.reason ?? 'TODO: say why these cannot run here',
        unproven:
          ledger.needsSeededContent?.[file]?.unproven ?? 'TODO: say what is therefore untested',
      };
    }
    writeFileSync(
      LEDGER_PATH,
      `${JSON.stringify({ tag: TAG, runsAnywhere, needsSeededContent }, null, 2)}\n`,
    );
    console.log(`Wrote ${LEDGER_PATH}.`);
    console.log('Now fill in every TODO by hand. An unexplained gap is the thing this catches.');
    // `process.exit` would skip the cleanup in `finally`; this leaves the same
    // way the happy path does.
    throw new Done();
  }

  const ledger = readLedger();
  const summary = summarise(tests, ledger);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
  }

  const problems = check(tests, ledger);
  if (problems.length > 0) {
    console.error('\ncheck-e2e-coverage: FAILED\n');
    for (const p of problems) console.error(`  - ${p}\n`);
    console.error('Run `node scripts/check-e2e-coverage.mjs --update` to re-record, then');
    console.error('write a real reason for every entry. Do not update it to silence this.');
    process.exitCode = 1;
  } else {
    console.log('\ncheck-e2e-coverage: OK — the CI selection matches e2e-coverage.json exactly.');
  }
} catch (err) {
  if (!(err instanceof Done)) {
    console.error(`\ncheck-e2e-coverage: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
