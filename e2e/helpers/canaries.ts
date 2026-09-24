import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findCanaries, hashEntry, normalise, sha256 } from '../../scripts/check-bundle-leaks.mjs';
import { E2E_ROOT, REPO_ROOT } from './env.js';

// Looking for strings the repo is not allowed to hold.
//
// Two fixtures, the same shape and the same scanner:
//   * ops/fixtures/leak-canaries.json — a quiz answer, a lesson sentence and a
//     Status Guide line (S02). Those MAY legitimately appear in a lesson or
//     quiz response; what must never carry them is the browser bundle, the
//     manager screens and anything else that is not the content API.
//   * e2e/fixtures/pii-canaries.json — the real staff email addresses and the
//     names inside them, taken out of the approved prototype by
//     e2e/tools/make-pii-canaries.ts. These may not appear ANYWHERE.
//
// Both hold only { label, length, sha256 } of the normalised string. The
// scanner slides a window of each length over the text and compares hashes, so
// nothing in this repo — fixture, test or report — ever spells the string out.
// The hashing and the window are the ones scripts/check-bundle-leaks.mjs
// already uses, imported rather than written a second time.

export interface Canary {
  label: string;
  length: number;
  sha256: string;
}

function load(file: string): Canary[] {
  const list = JSON.parse(readFileSync(file, 'utf8')) as Canary[];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`e2e: ${file} holds no canaries, so a sweep against it would prove nothing.`);
  }
  return list;
}

export const PII_CANARY_FILE = path.join(E2E_ROOT, 'fixtures', 'pii-canaries.json');
export const CONTENT_CANARY_FILE = path.join(REPO_ROOT, 'ops', 'fixtures', 'leak-canaries.json');

export function piiCanaries(): Canary[] {
  return load(PII_CANARY_FILE);
}

export function contentCanaries(): Canary[] {
  return load(CONTENT_CANARY_FILE);
}

/** The labels of every canary found in `text`. */
export function scan(text: string, canaries: readonly Canary[]): string[] {
  return findCanaries(text, canaries) as string[];
}

/** Build a canary for a string of our own — used for the scanner's control test. */
export function canaryFor(text: string, label: string): Canary {
  return hashEntry(text, label) as Canary;
}

export { normalise, sha256 };
