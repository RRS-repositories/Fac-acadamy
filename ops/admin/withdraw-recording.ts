// Takes recordings out of the training — or puts them back.
//
// WHY THIS COMMAND EXISTS
// -----------------------
// A recording that should not be shown (on 26 Oct 2026: two DSAR screen
// recordings made with the microphone off, so trainees got picture and no
// sound) needs a supported way out. is_active is the switch the whole app
// already reads: a withdrawn row is gone from the stage page and the video
// shelf, and it stops counting towards the "listen to every recording" rule
// that unlocks a stage's quiz. Nothing is deleted:
//   * the file stays in the media store, so --restore needs no re-upload;
//   * listen_progress rows stay, so a restored recording keeps who heard it;
//   * the seed never sets is_active, so a re-seed does not bring it back.
// Re-ingesting a new file into the slot with ingest-media --replace also sets
// is_active back to TRUE, which is the normal way back after a re-recording.
//
//   npx tsx ops/admin/withdraw-recording.ts --code <code> [--code <code> ...] \
//       --by <operator name> --reason "<text>" --expect-db <database name> \
//       [--restore] [--confirm-production] [--dry-run]
//   (or from ops/: npm run admin:withdraw-recording -- --code ... )
//
// Codes are call_recordings.code ('<stage>-rec<n>' for a seeded slot). Each
// line printed names the title, so a --dry-run shows exactly what would go.
// Every code must exist, or nothing changes. Writes one audit_events row per
// change (RECORDING_WITHDRAWN / RECORDING_RESTORED, actor 'ops:<operator>') in
// the same transaction. Takes effect on the next page load.
import { parseArgs } from 'node:util';
import {
  AdminError,
  type Queryable,
  actorFor,
  connectAdmin,
  inTransaction,
  parseExpectDb,
  parseOperator,
  parseReason,
  runIfMain,
  writeAudit,
} from './lib.js';

export const WITHDRAW_RECORDING_USAGE =
  'Usage: withdraw-recording --code <code> [--code <code> ...] --by <operator name> ' +
  '--reason "<text>" --expect-db <database name> [--restore] [--confirm-production] [--dry-run]';

export interface WithdrawArgs {
  codes: string[];
  operator: string;
  reason: string;
  expectDb: string;
  /** true puts the recordings back instead. */
  restore: boolean;
  dryRun: boolean;
}

// Shape only. Whether the code exists is checked against academy.call_recordings.
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseRecordingCode(raw: string): string {
  const code = raw.trim();
  if (!CODE_RE.test(code)) throw new AdminError(`--code "${raw}" is not a recording code.`);
  return code;
}

export function parseWithdrawArgs(argv: string[]): WithdrawArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      code: { type: 'string', multiple: true },
      by: { type: 'string' },
      reason: { type: 'string' },
      'expect-db': { type: 'string' },
      restore: { type: 'boolean', default: false },
      'confirm-production': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  const codes = [...new Set((values.code ?? []).map(parseRecordingCode))];
  if (codes.length === 0) throw new AdminError('--code <code> is required (repeat it for more).');
  return {
    codes,
    operator: parseOperator(values.by),
    reason: parseReason(values.reason, true)!,
    expectDb: parseExpectDb(values['expect-db'], values['confirm-production'] === true),
    restore: values.restore === true,
    dryRun: values['dry-run'] === true,
  };
}

export interface WithdrawResult {
  code: string;
  title: string;
  /** The stage's code, or null for a library video. */
  stage: string | null;
  /** false when it was already in the state asked for (nothing changed, no audit row). */
  changed: boolean;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function withdrawRecordings(
  db: Queryable,
  opts: { codes: string[]; operator: string; reason: string; restore: boolean },
): Promise<WithdrawResult[]> {
  // Lock the rows so a concurrent change cannot slip between the read and the write.
  const { rows } = await db.query<{
    id: string;
    code: string;
    title: string;
    stage: string | null;
    is_active: boolean;
  }>(
    `SELECT r.id::text AS id, r.code, r.title, s.code AS stage, r.is_active
       FROM academy.call_recordings r
       LEFT JOIN academy.stages s ON s.id = r.stage_id
      WHERE r.code = ANY($1::text[])
        FOR UPDATE OF r`,
    [opts.codes],
  );
  const missing = opts.codes.filter((c) => !rows.some((r) => r.code === c));
  if (missing.length > 0) {
    throw new AdminError(`No recording with code ${missing.join(', ')}. Nothing was changed.`);
  }

  const want = opts.restore;
  const results: WithdrawResult[] = [];
  for (const code of opts.codes) {
    const row = rows.find((r) => r.code === code)!;
    if (row.is_active === want) {
      results.push({ code, title: row.title, stage: row.stage, changed: false, auditId: null });
      continue;
    }
    await db.query('UPDATE academy.call_recordings SET is_active = $1 WHERE id = $2', [
      want,
      row.id,
    ]);
    const auditId = await writeAudit(db, {
      traineeId: null,
      eventType: want ? 'RECORDING_RESTORED' : 'RECORDING_WITHDRAWN',
      actor: actorFor(opts.operator),
      payload: {
        recordingId: row.id,
        code,
        title: row.title,
        stage: row.stage,
        reason: opts.reason,
      },
    });
    results.push({ code, title: row.title, stage: row.stage, changed: true, auditId });
  }
  return results;
}

async function main(): Promise<number> {
  const args = parseWithdrawArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(WITHDRAW_RECORDING_USAGE);
    return 0;
  }
  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const results = await inTransaction(client, args.dryRun, () =>
      withdrawRecordings(client, args),
    );
    const prefix = args.dryRun ? '[dry run, rolled back] ' : '';
    const verb = args.restore ? 'restored' : 'withdrawn';
    for (const r of results) {
      const where = r.stage === null ? 'video library' : `stage ${r.stage}`;
      console.log(
        r.changed
          ? `${prefix}${r.code} "${r.title}" (${where}): ${verb}. Audit event ${r.auditId}.`
          : `${prefix}${r.code} "${r.title}" (${where}): already ${verb}, nothing to do.`,
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'withdraw-recording', main);
