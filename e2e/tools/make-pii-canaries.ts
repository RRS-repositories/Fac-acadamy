import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { hashEntry } from '../../scripts/check-bundle-leaks.mjs';
import { E2E_ROOT, loadEnv } from '../helpers/env.js';

// Builds the PII canary fixture from the approved prototype, and PRINTS NOTHING
// but labels, lengths and hashes.
//
//   PROTOTYPE_PATH=<build pack>/FAC-Academy-Portal-v2.5.html \
//     npx tsx e2e/tools/make-pii-canaries.ts
//
// The prototype carries real staff email addresses and a worked DSAR example
// with a real name, account number and date of birth (CLAUDE.md: "never commit
// the prototype HTML"). Those strings must never reach a response, and they
// must never reach this repo either — so the fixture holds only
// { label, length, sha256 } of each one, exactly the shape
// ops/fixtures/leak-canaries.json uses, and the suite slides a window of that
// length over every response body and compares hashes.
//
// Everything is found by RULE, never by eye:
//
//   1. every email address whose domain is not a placeholder domain, plus its
//      local part when that is long enough to be a name;
//   2. the value that follows a "Name:", "Account number" or "Date of birth"
//      label in the DSAR worked example;
//   3. UK sort codes and telephone numbers.
//
// Re-run it whenever the prototype changes. The output file is committed; the
// prototype is not.

const OUT_FILE = path.join(E2E_ROOT, 'fixtures', 'pii-canaries.json');

/** Domains that are invented for documentation, so not anybody's address. */
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'company.co.uk', 'email.com'];

/** Nothing shorter is a safe canary: it would match innocent text by accident. */
const MIN_LENGTH = 6;
/**
 * A local part shorter than this, or in this list, is a shared mailbox rather
 * than a person — `irl@`, `info@` and the like. Those addresses are PRINTED IN
 * THE TRAINING ITSELF ("email the team at ..."), so they are content, not
 * personal data, and making them canaries would fail the sweep on the approved
 * lessons that carry them on purpose.
 */
const MIN_LOCAL_PART = 6;
const SHARED_MAILBOXES = [
  'info',
  'admin',
  'contact',
  'support',
  'sales',
  'hello',
  'enquiries',
  'noreply',
  'no-reply',
  'accounts',
  'complaints',
];

export interface CanaryEntry {
  label: string;
  length: number;
  sha256: string;
}

export function stripMedia(html: string): string {
  return html.replace(/data:[a-z/+-]+;base64,[A-Za-z0-9+/=]+/g, '[media]');
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The text just after a LABELLED field, up to the next separator.
 *
 * The label must be a whole word followed by a colon — case-sensitive, so
 * "filename:" and "username:" are not fields on a form — and the value is
 * capped at 60 characters and at six words, so a canary can never turn into a
 * sentence of ordinary training copy that then fails the sweep for no reason.
 */
function valuesAfterLabel(text: string, label: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(
    `(?<![A-Za-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`,
    'g',
  );
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const tail = text.slice(start, start + 80);
    const raw = (/^[^·|,;•\n\r<>()]{1,60}/.exec(tail)?.[0] ?? '').trim().replace(/[.\s]+$/, '');
    const value = raw.split(/\s+/).slice(0, 6).join(' ');
    if (value.length >= MIN_LENGTH) out.push(value);
  }
  return out;
}

function add(map: Map<string, string>, label: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_LENGTH) return;
  if (!/^[\p{L}\p{N}]/u.test(trimmed)) return; // the scanner starts at a word
  if (!map.has(trimmed)) map.set(trimmed, label);
}

export function extractCanaries(html: string): CanaryEntry[] {
  const source = stripMedia(html);
  const text = stripTags(source);
  const found = new Map<string, string>(); // value -> label

  let emails = 0;
  let names = 0;
  for (const email of new Set(
    source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [],
  )) {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (PLACEHOLDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    const local = email.split('@')[0] ?? '';
    if (local.length < MIN_LOCAL_PART || SHARED_MAILBOXES.includes(local.toLowerCase())) continue;
    emails += 1;
    add(found, `staff-email-${String(emails)}`, email);
    names += 1;
    add(found, `staff-name-${String(names)}`, local);
  }

  for (const [label, key] of [
    ['dsar-name', 'Name'],
    ['dsar-account', 'Account number'],
    ['dsar-dob', 'Date of birth'],
  ] as const) {
    let n = 0;
    for (const value of valuesAfterLabel(text, key)) {
      n += 1;
      add(found, n === 1 ? label : `${label}-${String(n)}`, value);
    }
  }

  let sortCodes = 0;
  for (const code of new Set(text.match(/\b[0-9]{2}-[0-9]{2}-[0-9]{2}\b/g) ?? [])) {
    sortCodes += 1;
    add(found, `sort-code-${String(sortCodes)}`, code);
  }

  let phones = 0;
  for (const phone of new Set(text.match(/\b(?:0[1-9][0-9]{8,9}|\+44 ?[0-9]{9,10})\b/g) ?? [])) {
    phones += 1;
    add(found, `phone-${String(phones)}`, phone);
  }

  const entries: CanaryEntry[] = [];
  for (const [value, label] of found) {
    const entry = hashEntry(value, label) as CanaryEntry;
    if (entry.length >= MIN_LENGTH) entries.push(entry);
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

function main(): number {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
  });
  if (values.help === true) {
    console.log('Usage: PROTOTYPE_PATH=<prototype.html> tsx e2e/tools/make-pii-canaries.ts');
    return 0;
  }
  loadEnv();
  const prototype = process.env['PROTOTYPE_PATH'];
  if (prototype === undefined || prototype.trim() === '') {
    console.error('make-pii-canaries: PROTOTYPE_PATH is not set.');
    return 1;
  }
  const entries = extractCanaries(readFileSync(prototype, 'utf8'));
  if (entries.length === 0) {
    console.error('make-pii-canaries: no canaries found — check the extraction rules.');
    return 1;
  }
  const out = values.out === undefined ? OUT_FILE : path.resolve(values.out);
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  // Labels and lengths only. The strings themselves never leave this process.
  console.log(`make-pii-canaries: ${String(entries.length)} canaries -> ${out}`);
  for (const e of entries) console.log(`  ${e.label} (${String(e.length)} chars)`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}
