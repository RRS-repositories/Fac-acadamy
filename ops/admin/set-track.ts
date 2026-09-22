// Sets a trainee's track (D13: first-time trainees start with no track; the
// manager assigns it in S07, and until then IT can set it with this command).
// Validates the code against academy.tracks and writes an audit_events row
// (TRACK_ASSIGNED, actor 'ops:<operator>') in the same transaction.
//
//   npx tsx ops/admin/set-track.ts --email <email> --track <CODE> --by <operator name> \
//       --expect-db <database name> [--dry-run]
//   (or from ops/: npm run admin:set-track -- --email ... )
import { parseArgs } from 'node:util';
import {
  AdminError,
  type Queryable,
  actorFor,
  connectAdmin,
  findTraineeByEmail,
  inTransaction,
  parseEmail,
  parseExpectDb,
  parseOperator,
  runIfMain,
  writeAudit,
} from './lib.js';

export const SET_TRACK_USAGE =
  'Usage: set-track --email <email> --track <CODE> --by <operator name> ' +
  '--expect-db <database name> [--dry-run]';

export interface SetTrackArgs {
  email: string;
  track: string;
  operator: string;
  expectDb: string;
  dryRun: boolean;
}

// Shape only (upper-case code). Whether the code exists is checked against academy.tracks.
const TRACK_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

export function parseTrackCode(raw: string | undefined): string {
  const code = raw?.trim().toUpperCase() ?? '';
  if (!code) throw new AdminError('--track <CODE> is required (e.g. CS, SALES, ADMIN).');
  if (!TRACK_RE.test(code)) throw new AdminError(`--track "${raw}" is not a track code.`);
  return code;
}

export function parseSetTrackArgs(argv: string[]): SetTrackArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      email: { type: 'string' },
      track: { type: 'string' },
      by: { type: 'string' },
      'expect-db': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  return {
    email: parseEmail(values.email),
    track: parseTrackCode(values.track),
    operator: parseOperator(values.by),
    expectDb: parseExpectDb(values['expect-db']),
    dryRun: values['dry-run'] === true,
  };
}

export interface SetTrackResult {
  traineeId: string;
  email: string;
  from: string | null;
  to: string;
  /** false when the trainee already had this track (nothing changed, no audit row). */
  changed: boolean;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function setTrack(
  db: Queryable,
  opts: { email: string; track: string; operator: string },
): Promise<SetTrackResult> {
  const tracks = await db.query<{ code: string }>('SELECT code FROM academy.tracks ORDER BY code');
  const codes = tracks.rows.map((r) => r.code);
  if (!codes.includes(opts.track)) {
    throw new AdminError(`Unknown track "${opts.track}". Valid tracks: ${codes.join(', ')}.`);
  }
  const trainee = await findTraineeByEmail(db, opts.email);
  // Lock the row so a concurrent change cannot slip between the read and the write.
  const cur = await db.query<{ track: string | null }>(
    'SELECT track FROM academy.trainees WHERE id = $1 FOR UPDATE',
    [trainee.id],
  );
  const from = cur.rows[0]?.track ?? null;
  if (from === opts.track) {
    return {
      traineeId: trainee.id,
      email: trainee.email,
      from,
      to: opts.track,
      changed: false,
      auditId: null,
    };
  }
  await db.query('UPDATE academy.trainees SET track = $1 WHERE id = $2', [opts.track, trainee.id]);
  const auditId = await writeAudit(db, {
    traineeId: trainee.id,
    eventType: 'TRACK_ASSIGNED',
    actor: actorFor(opts.operator),
    payload: { from, to: opts.track },
  });
  return {
    traineeId: trainee.id,
    email: trainee.email,
    from,
    to: opts.track,
    changed: true,
    auditId,
  };
}

async function main(): Promise<number> {
  const args = parseSetTrackArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(SET_TRACK_USAGE);
    return 0;
  }
  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const res = await inTransaction(client, args.dryRun, () => setTrack(client, args));
    const prefix = args.dryRun ? '[dry run, rolled back] ' : '';
    if (!res.changed) {
      console.log(
        `${prefix}Trainee ${res.traineeId} (${res.email}) is already on track ${res.to}: nothing to do.`,
      );
      return 0;
    }
    console.log(
      `${prefix}Trainee ${res.traineeId} (${res.email}): track ${res.from ?? '(none)'} -> ${res.to}. ` +
        `Audit event ${res.auditId} (TRACK_ASSIGNED).`,
    );
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'set-track', main);
