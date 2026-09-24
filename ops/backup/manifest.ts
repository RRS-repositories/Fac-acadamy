// The manifest: the small JSON file that says what a backup contains, so the
// restore drill can check the restore rather than assume it.
//
// It records, for the database half: when the backup ran, which database and
// schema it came from, the schema version (the last row of
// academy.schema_migrations), a row count for every academy table and the
// content fingerprint (the same canonical hash ops/seed/verify-seed.ts prints).
// For the media half: one entry per file with its size and sha256, plus the
// totals.
//
// It holds no password and no lesson text — counts, names, sizes and hashes
// only — so it is safe to read, mail and keep beside the dump.

import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BackupError } from './lib.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const MediaFileSchema = z.object({
  /** Media store key: a relative POSIX path under MEDIA_ROOT. */
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256,
});
export type MediaFileEntry = z.infer<typeof MediaFileSchema>;

export const TableCountSchema = z.object({
  table: z.string().min(1),
  rows: z.number().int().nonnegative(),
});
export type TableCount = z.infer<typeof TableCountSchema>;

export const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  tool: z.string().min(1),
  label: z.string().optional(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  database: z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive(),
    user: z.string().min(1),
    schema: z.string().min(1),
    serverVersion: z.string().min(1),
    /** Last applied migration file, or null on an empty database. */
    schemaVersion: z.string().nullable(),
    schemaVersionAppliedAt: z.string().nullable(),
    migrationCount: z.number().int().nonnegative(),
    dumpFile: z.string().min(1),
    dumpBytes: z.number().int().nonnegative(),
    dumpSha256: Sha256,
    tables: z.array(TableCountSchema),
    /** Same canonical content hash ops/seed/verify-seed.ts reports. */
    contentFingerprint: Sha256,
    contentTables: z.record(z.string(), Sha256),
  }),
  media: z.object({
    /** MEDIA_ROOT as it was on the machine that took the backup. */
    root: z.string().min(1),
    /** Folder inside the backup that holds the copy. */
    dir: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    files: z.array(MediaFileSchema),
  }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await writeFile(file, `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`, 'utf8');
}

export async function readManifest(file: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new BackupError(`No manifest at ${file}. That folder is not a backup this tool wrote.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupError(`The manifest at ${file} is not valid JSON.`);
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const where = [...new Set(result.error.issues.map((i) => i.path.join('.')))].slice(0, 8);
    throw new BackupError(
      `The manifest at ${file} is not the expected shape: ${where.join(', ')}.`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Comparisons the drill makes. Pure functions, so they are unit-testable with
// tiny invented fixtures and need no database.
// ---------------------------------------------------------------------------

export interface Difference {
  what: string;
  expected: string;
  actual: string;
}

/** Table names present in one side and not the other. */
export function compareTableList(
  expected: readonly TableCount[],
  actual: readonly TableCount[],
): Difference[] {
  const left = new Set(expected.map((t) => t.table));
  const right = new Set(actual.map((t) => t.table));
  const out: Difference[] = [];
  for (const name of [...left].sort()) {
    if (!right.has(name)) out.push({ what: name, expected: 'present', actual: 'MISSING' });
  }
  for (const name of [...right].sort()) {
    if (!left.has(name)) out.push({ what: name, expected: 'absent', actual: 'UNEXPECTED' });
  }
  return out;
}

/** Row-count differences, for tables that exist on both sides. */
export function compareRowCounts(
  expected: readonly TableCount[],
  actual: readonly TableCount[],
): Difference[] {
  const right = new Map(actual.map((t) => [t.table, t.rows]));
  const out: Difference[] = [];
  for (const { table, rows } of [...expected].sort((a, b) => a.table.localeCompare(b.table))) {
    const got = right.get(table);
    if (got === undefined) continue; // reported by compareTableList
    if (got !== rows) {
      out.push({ what: table, expected: String(rows), actual: String(got) });
    }
  }
  return out;
}

export interface MediaComparison {
  missing: string[];
  corrupt: string[];
  extra: string[];
  matched: number;
}

/**
 * Every file the manifest lists must be there with the same sha256, and there
 * must be nothing else: a restore that quietly dropped a recording, or brought
 * a stray one back, is not a restore.
 */
export function compareMedia(
  expected: readonly MediaFileEntry[],
  actual: readonly MediaFileEntry[],
): MediaComparison {
  const got = new Map(actual.map((f) => [f.key, f]));
  const missing: string[] = [];
  const corrupt: string[] = [];
  let matched = 0;
  for (const want of expected) {
    const have = got.get(want.key);
    if (have === undefined) missing.push(want.key);
    else if (have.sha256 !== want.sha256 || have.bytes !== want.bytes) corrupt.push(want.key);
    else matched += 1;
  }
  const wanted = new Set(expected.map((f) => f.key));
  const extra = actual.map((f) => f.key).filter((k) => !wanted.has(k));
  return { missing: missing.sort(), corrupt: corrupt.sort(), extra: extra.sort(), matched };
}

/** A PDF starts with the five bytes `%PDF-`. Nothing else does by accident. */
export const PDF_MAGIC = '%PDF-';

export function looksLikePdf(head: Buffer): boolean {
  return head.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}
