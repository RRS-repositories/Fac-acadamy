// Sets a trainee's track — or takes it away again (D13: first-time trainees
// start with no track; the manager assigns it in S07, and until then IT can set
// it with this command). Validates the code against academy.tracks and writes
// an audit_events row in the same transaction: TRACK_ASSIGNED when a track is
// set, TRACK_CLEARED when one is removed, actor 'ops:<operator>'.
//
// Clearing is the same change a manager makes on the roster: the trainee goes
// back to "waiting for a manager to assign a track" and keeps every lesson,
// attempt and completion, because progress is keyed to the stage, not to the
// track.
//
//   npx tsx ops/admin/set-track.ts --email <email> --track <CODE> --by <operator name> \
//       --expect-db <database name> [--confirm-production] [--dry-run]
//   npx tsx ops/admin/set-track.ts --email <email> --clear --by <operator name> \
//       --expect-db <database name>            (--track none does the same)
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
  'Usage: set-track --email <email> (--track <CODE> | --clear) --by <operator name> ' +
  '--expect-db <database name> [--confirm-production] [--dry-run]';

export interface SetTrackArgs {
  email: string;
  /** null means "take the track away". */
  track: string | null;
  operator: string;
  expectDb: string;
  dryRun: boolean;
}

// Shape only (upper-case code). Whether the code exists is checked against academy.tracks.
const TRACK_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * The --track value, or null for "no track". `--track none` is spelled out
 * rather than accepted as an empty string: an empty --track is far more likely
 * to be a shell variable that did not expand than a deliberate removal.
 */
export function parseTrackCode(raw: string | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? '';
  if (!code) {
    throw new AdminError(
      '--track <CODE> is required (e.g. CS, SALES, ADMIN), or --clear to remove the track.',
    );
  }
  if (code === 'NONE') return null;
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
      clear: { type: 'boolean', default: false },
      by: { type: 'string' },
      'expect-db': { type: 'string' },
      'confirm-production': { type: 'boolean', default: false },

      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  const clear = values.clear === true;
  if (clear && values.track !== undefined && parseTrackCode(values.track) !== null) {
    throw new AdminError('Use either --clear or --track <CODE>, not both.');
  }
  return {
    email: parseEmail(values.email),
    track: clear ? null : parseTrackCode(values.track),
    operator: parseOperator(values.by),
    expectDb: parseExpectDb(values['expect-db'], values['confirm-production'] === true),
    dryRun: values['dry-run'] === true,
  };
}

export interface SetTrackResult {
  traineeId: string;
  email: string;
  from: string | null;
  to: string | null;
  /** false when the trainee already had this track (nothing changed, no audit row). */
  changed: boolean;
  /** The event written, so the printed line and the log cannot disagree. */
  eventType: 'TRACK_ASSIGNED' | 'TRACK_CLEARED' | null;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function setTrack(
  db: Queryable,
  opts: { email: string; track: string | null; operator: string },
): Promise<SetTrackResult> {
  if (opts.track !== null) {
    const tracks = await db.query<{ code: string }>(
      'SELECT code FROM academy.tracks ORDER BY code',
    );
    const codes = tracks.rows.map((r) => r.code);
    if (!codes.includes(opts.track)) {
      throw new AdminError(`Unknown track "${opts.track}". Valid tracks: ${codes.join(', ')}.`);
    }
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
      eventType: null,
      auditId: null,
    };
  }
  // NULL here removes the track. It deletes no progress: lesson_progress,
  // quiz_attempts and the completion tables are keyed to the stage.
  await db.query('UPDATE academy.trainees SET track = $1 WHERE id = $2', [opts.track, trainee.id]);
  const eventType = opts.track === null ? 'TRACK_CLEARED' : 'TRACK_ASSIGNED';
  const auditId = await writeAudit(db, {
    traineeId: trainee.id,
    eventType,
    actor: actorFor(opts.operator),
    payload: opts.track === null ? { from } : { from, to: opts.track },
  });
  return {
    traineeId: trainee.id,
    email: trainee.email,
    from,
    to: opts.track,
    changed: true,
    eventType,
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
        res.to === null
          ? `${prefix}Trainee ${res.traineeId} (${res.email}) has no track already: nothing to do.`
          : `${prefix}Trainee ${res.traineeId} (${res.email}) is already on track ${res.to}: nothing to do.`,
      );
      return 0;
    }
    console.log(
      `${prefix}Trainee ${res.traineeId} (${res.email}): track ${res.from ?? '(none)'} -> ${res.to ?? '(none)'}. ` +
        `Audit event ${res.auditId} (${res.eventType}).`,
    );
    if (res.to === null) {
      console.log(
        '  They now see the "waiting for a manager to assign a track" screen. ' +
          'Their completed stages are untouched and come back with the track.',
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'set-track', main);
