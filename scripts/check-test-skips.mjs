#!/usr/bin/env node
// Make a skipped test a fact somebody signed for.
//
// WHY THIS EXISTS
// ---------------
// Until 24 Sep, CI was green while quietly testing much less than it looked
// like. Most of the interesting suites — the quiz API, the manager API, the
// training read model — need the training content to be in the database, and
// the content is loaded from the approved prototype HTML. That file holds six
// real client call recordings and real staff names, so it can never be
// committed, so CI has no content, so those suites call `describe.skipIf` /
// `it.skipIf` and vanish. Vitest reports them as skipped, prints a tick, and
// exits 0. A reviewer sees a green CI badge and reasonably concludes the quiz
// grader is covered. It is not.
//
// Skipping is the right behaviour — a test that cannot run should not pretend
// to fail. What is wrong is that it happens SILENTLY and WITHOUT A CEILING.
//
// So: every skip must be declared, in advance, in test-skips.json, with a
// reason and a maximum count. This script runs the suites, counts what was
// actually skipped, and fails when:
//
//   * a test file skips tests and is not in the ledger        (new blind spot)
//   * a file skips more tests than the ledger allows          (blind spot grew)
//   * a ledger entry skips nothing any more                   (stale — delete it)
//   * a suite crashed or failed to collect                    (invisible breakage)
//
// The ledger is deliberately annoying to update. That is the point: adding a
// line to it is a decision, visible in a diff, with a reason attached.
//
// It also writes a plain-English summary to the GitHub job summary, so the
// green tick arrives next to the sentence "these 37 tests did not run, here is
// why". Honest, and bounded.
//
//   node scripts/check-test-skips.mjs            # run the suites and check
//   node scripts/check-test-skips.mjs --update   # rewrite the ledger's counts

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'test-skips.json');
const WORKSPACES = ['shared', 'server', 'client', 'ops'];

const UPDATE = process.argv.includes('--update');
// --strict also fails on a ledger entry that no longer skips anything. Only CI
// has a fixed enough environment for that question to be fair; see check().
const STRICT = process.argv.includes('--strict');

// ---------------------------------------------------------------------------
// Run the suites, one workspace at a time, asking for a machine-readable report
// ---------------------------------------------------------------------------

/** @returns {{ workspace: string, report: any } | { workspace: string, error: string }} */
function runWorkspace(workspace, outDir) {
  const outFile = path.join(outDir, `${workspace}.json`);
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`],
    { cwd: path.join(REPO_ROOT, workspace), encoding: 'utf8', shell: process.platform === 'win32' },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return {
      workspace,
      error:
        `vitest produced no readable report (exit ${result.status}). ` +
        `Last stderr: ${(result.stderr || '').trim().split('\n').slice(-3).join(' | ')}`,
    };
  }
  return { workspace, report, exitCode: result.status };
}

// ---------------------------------------------------------------------------
// Turn the reports into { "<workspace>/<test file>": <skipped count> }
// ---------------------------------------------------------------------------

function collectSkips(runs) {
  /** @type {Record<string, number>} */
  const skips = {};
  const failures = [];
  let passed = 0;
  let failed = 0;

  for (const run of runs) {
    if (run.error) {
      failures.push(`${run.workspace}: ${run.error}`);
      continue;
    }
    for (const file of run.report.testResults ?? []) {
      // Vitest gives an absolute path; make it a stable repo-relative key with
      // forward slashes so the ledger reads the same on Windows and on CI.
      const rel = path.relative(REPO_ROOT, file.name).split(path.sep).join('/');
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'passed') passed += 1;
        else if (assertion.status === 'failed') {
          failed += 1;
          failures.push(`${rel}: ${assertion.fullName}`);
        } else {
          // 'skipped', 'pending', 'todo'
          skips[rel] = (skips[rel] ?? 0) + 1;
        }
      }
    }
  }
  return { skips, failures, passed, failed };
}

// ---------------------------------------------------------------------------
// Compare against the ledger
// ---------------------------------------------------------------------------

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return { entries: {} };
  }
}

function check(skips, ledger) {
  const problems = [];
  const entries = ledger.entries ?? {};

  for (const [file, count] of Object.entries(skips).sort()) {
    const entry = entries[file];
    if (entry === undefined) {
      problems.push(
        `NEW BLIND SPOT: ${file} skipped ${count} test(s) and is not in test-skips.json.\n` +
          '    Either make the tests run, or add an entry saying why they cannot and what is lost.',
      );
      continue;
    }
    if (count > entry.max) {
      problems.push(
        `BLIND SPOT GREW: ${file} skipped ${count} test(s); the ledger allows ${entry.max}.\n` +
          `    Declared reason: ${entry.reason}`,
      );
    }
  }

  // A file that skips FEWER tests than its ceiling is good news, not a fault:
  // on a developer's machine the content is seeded and most of these suites run
  // in full. Only in CI is the environment fixed enough for "this entry earns
  // its place" to be a fair question, so the stale check is opt-in.
  if (STRICT) {
    for (const [file, entry] of Object.entries(entries).sort()) {
      if (skips[file] === undefined) {
        problems.push(
          `STALE LEDGER ENTRY: ${file} skips nothing any more — delete its entry.\n` +
            `    It said: ${entry.reason}`,
        );
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function summarise(skips, ledger, passed) {
  const total = Object.values(skips).reduce((a, b) => a + b, 0);
  const lines = [];
  lines.push('## Test honesty check', '');
  lines.push(`**${passed} tests ran and passed. ${total} did not run.**`, '');
  if (total === 0) {
    lines.push('Nothing was skipped.');
    return lines.join('\n');
  }
  lines.push('These were skipped, on purpose, for the reasons recorded in `test-skips.json`:', '');
  lines.push('| Tests not run | Where | Why | What is therefore unproven here |');
  lines.push('|---:|---|---|---|');
  for (const [file, count] of Object.entries(skips).sort()) {
    const entry = ledger.entries?.[file];
    lines.push(
      `| ${count} | \`${file}\` | ${entry?.reason ?? '**undeclared**'} | ${entry?.unproven ?? '—'} |`,
    );
  }
  lines.push('', 'A green tick on this run does **not** cover the rows above.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

const outDir = mkdtempSync(path.join(tmpdir(), 'academy-skips-'));
try {
  const runs = WORKSPACES.map((w) => runWorkspace(w, outDir));
  const { skips, failures, passed, failed } = collectSkips(runs);

  if (UPDATE) {
    const ledger = readLedger();
    const entries = {};
    for (const [file, count] of Object.entries(skips).sort()) {
      entries[file] = {
        max: count,
        reason: ledger.entries?.[file]?.reason ?? 'TODO: say why these cannot run here',
        unproven: ledger.entries?.[file]?.unproven ?? 'TODO: say what is therefore untested',
      };
    }
    writeFileSync(LEDGER_PATH, `${JSON.stringify({ entries }, null, 2)}\n`);
    console.log(`Wrote ${LEDGER_PATH} with ${Object.keys(entries).length} entries.`);
    console.log('Now fill in every TODO by hand. An unexplained skip is the thing this catches.');
    process.exit(0);
  }

  const ledger = readLedger();
  const summary = summarise(skips, ledger, passed);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
  }

  if (failed > 0 || failures.length > 0) {
    console.error('\ncheck-test-skips: the suites did not all pass.');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  const problems = check(skips, ledger);
  if (problems.length > 0) {
    console.error('\ncheck-test-skips: FAILED\n');
    for (const p of problems) console.error(`  - ${p}\n`);
    console.error('Run `node scripts/check-test-skips.mjs --update` to re-record, then');
    console.error('write a real reason for every entry. Do not update it to silence this.');
    process.exit(1);
  }

  console.log('\ncheck-test-skips: OK — every skip is declared and within its ceiling.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
