#!/usr/bin/env node
// Proves that no quiz answer or lesson sentence ships in the browser bundle,
// without committing those strings. The fixture ops/fixtures/leak-canaries.json
// holds only { label, length, sha256 } of each canary (normalised: lower-case,
// whitespace collapsed). We slide a window of each length over every built file
// in client/dist and compare hashes.
//
//   npm run check:bundle                                    scan client/dist
//   node scripts/check-bundle-leaks.mjs --hash "some text" [--label name]
//                                                           print a fixture entry

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'client', 'dist');
const CANARY_FILE = path.join(REPO_ROOT, 'ops', 'fixtures', 'leak-canaries.json');
const SCANNED_EXT = new Set(['.js', '.css', '.html', '.json', '.map']);
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Lower-case and collapse every whitespace run to one space. Used on both sides. */
export function normalise(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Fixture entry for a canary string. Paste the output, never the string. */
export function hashEntry(text, label = 'CHANGE-ME') {
  const norm = normalise(text);
  return { label, length: norm.length, sha256: sha256(norm) };
}

// Minified JS often escapes characters (’, \", \n). Scan a decoded copy too.
function decodeJsEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["'`\\/])/g, '$1');
}

function isWordStart(text, i) {
  return WORD_CHAR.test(text[i] ?? '') && (i === 0 || !WORD_CHAR.test(text[i - 1] ?? ''));
}

/** Returns the labels of every canary found in `text`. */
export function findCanaries(text, canaries) {
  const byLength = new Map();
  for (const c of canaries) {
    if (!byLength.has(c.length)) byLength.set(c.length, new Map());
    byLength.get(c.length).set(c.sha256, c.label);
  }
  const found = new Set();
  for (const variant of new Set([normalise(text), normalise(decodeJsEscapes(text))])) {
    for (let i = 0; i < variant.length; i += 1) {
      if (!isWordStart(variant, i)) continue; // cheap pre-filter: canaries start at a word
      for (const [len, hashes] of byLength) {
        if (i + len > variant.length) continue;
        const label = hashes.get(sha256(variant.slice(i, i + len)));
        if (label !== undefined) found.add(label);
      }
    }
  }
  return [...found];
}

function loadCanaries() {
  if (!existsSync(CANARY_FILE)) {
    console.error(`check-bundle-leaks: missing ${path.relative(REPO_ROOT, CANARY_FILE)}`);
    process.exit(1);
  }
  const list = JSON.parse(readFileSync(CANARY_FILE, 'utf8'));
  if (!Array.isArray(list)) {
    console.error('check-bundle-leaks: leak-canaries.json must be an array.');
    process.exit(1);
  }
  for (const [i, c] of list.entries()) {
    const ok =
      c &&
      typeof c.label === 'string' &&
      Number.isInteger(c.length) &&
      c.length > 0 &&
      typeof c.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(c.sha256);
    if (!ok) {
      console.error(`check-bundle-leaks: canary #${i} must be { label, length, sha256 }.`);
      process.exit(1);
    }
  }
  return list;
}

function listDistFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDistFiles(full));
    else if (SCANNED_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function runHashCli(argv) {
  const text = argv[argv.indexOf('--hash') + 1];
  if (typeof text !== 'string' || text.length === 0) {
    console.error('Usage: node scripts/check-bundle-leaks.mjs --hash "some text" [--label name]');
    process.exit(1);
  }
  const labelIdx = argv.indexOf('--label');
  const label = labelIdx >= 0 ? argv[labelIdx + 1] : undefined;
  const entry = hashEntry(text, label);
  if (!WORD_CHAR.test(normalise(text)[0] ?? '')) {
    console.error('WARNING: the canary must start with a letter or digit, or it will never match.');
  }
  console.log(JSON.stringify(entry, null, 2));
}

function runScan() {
  if (!existsSync(DIST_DIR)) {
    console.error('check-bundle-leaks: client/dist not found. Run npm run build first.');
    process.exit(1);
  }
  const canaries = loadCanaries();
  const files = listDistFiles(DIST_DIR);
  if (canaries.length === 0) {
    console.warn(
      `check-bundle-leaks: WARNING no canaries yet (they arrive in S02). ` +
        `${files.length} files in client/dist not checked for leaks.`,
    );
    return;
  }

  let leaks = 0;
  for (const file of files) {
    const labels = findCanaries(readFileSync(file, 'utf8'), canaries);
    for (const label of labels) {
      console.error(`LEAK  ${path.relative(REPO_ROOT, file)}  contains canary "${label}"`);
      leaks += 1;
    }
  }
  if (leaks > 0) {
    console.error(
      `\ncheck-bundle-leaks: ${leaks} leak(s). Quiz answers and lesson text must reach ` +
        'the browser only through the API.',
    );
    process.exit(1);
  }
  console.log(
    `check-bundle-leaks: OK (${canaries.length} canaries, ${files.length} files in client/dist)`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes('--hash')) runHashCli(process.argv);
  else runScan();
}
