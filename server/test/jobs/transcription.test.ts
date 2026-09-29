// The worker's transcription handler (plan §3.3).
//
// NO DATABASE AND NO PYTHON. The database is a recorder that answers the one
// SELECT and remembers every UPDATE, and the transcriber is a stub — so what is
// under test is the DECISION the handler makes in each case, which is the part
// that matters: which cases complete quietly, which case marks the recording
// FAILED and re-throws so the existing dead-letter behaviour takes over, and that
// a recording is never transcribed twice.
//
// Everything is invented: recording 4321 does not exist and the two "segments"
// are made-up lines between made-up people.
import { describe, expect, it } from 'vitest';
import { createTranscriptionHandler } from '../../src/jobs/mediaJobs.js';
import type { TranscriptionJob } from '../../src/jobs/mediaJobs.js';
import { TranscriberError } from '../../src/media/transcriber.js';
import type { Transcriber, TranscriptResult } from '../../src/media/transcriber.js';
import type { TranscriptDb } from '../../src/media/transcriptStore.js';
import type { QueueLogger } from '../../src/queues/logging.js';
import { DEFAULT_CONCURRENCY } from '../../src/queues/runtime.js';
import type { JobContext } from '../../src/queues/runtime.js';

const RECORDING_ID = 4321;
const MEDIA_ROOT = '/invented/media';
const MEDIA_KEY = 'academy/media/invented-call-aaaaaaaa.mp3';

const RESULT: TranscriptResult = {
  segments: [
    { start: 0, end: 2.5, text: 'Good morning, this is Dana from the claims team.' },
    { start: 2.5, end: 4, text: 'Speaking.' },
  ],
  text: 'Good morning, this is Dana from the claims team.\nSpeaking.',
  language: 'en',
  durationSecs: 4,
  engine: 'stub-engine:small',
};

interface Recorded {
  sql: string;
  values: readonly unknown[];
}

interface RowShape {
  transcript_status: string;
  transcript: string | null;
  transcript_segments: unknown;
  media_type: 'AUDIO' | 'VIDEO';
  media_key: string | null;
}

/** A database that answers the handler's one SELECT and records every write. */
function fakeDb(row: RowShape | null): { db: TranscriptDb; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const db = {
    query: (sql: string, values: readonly unknown[] = []) => {
      if (sql.trimStart().startsWith('SELECT')) {
        return Promise.resolve({ rows: row === null ? [] : [row] });
      }
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as TranscriptDb;
  return { db, writes };
}

function audioRow(over: Partial<RowShape> = {}): RowShape {
  return {
    transcript_status: 'PENDING',
    transcript: null,
    transcript_segments: null,
    media_type: 'AUDIO',
    media_key: MEDIA_KEY,
    ...over,
  };
}

/** A transcriber that counts its calls and can be told to fail. */
class StubTranscriber implements Transcriber {
  readonly name = 'stub-engine:small';
  readonly files: string[] = [];
  failWith: TranscriberError | Error | null = null;

  transcribe(file: string): Promise<TranscriptResult> {
    this.files.push(file);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve(RESULT);
  }
}

/** The lines the handler logged, so "it said so" is an assertion. */
function recorder(): { logger: QueueLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => lines.push(`info: ${message}`),
      warn: (message: string) => lines.push(`warn: ${message}`),
      error: (message: string) => lines.push(`error: ${message}`),
    },
  };
}

function job(): JobContext {
  const data: TranscriptionJob = {
    recordingId: RECORDING_ID,
    mediaKey: MEDIA_KEY,
    contentType: 'audio/mpeg',
    durationSecs: 4,
  };
  return { id: `transcribe-${String(RECORDING_ID)}`, name: 'transcribe', data, attemptsMade: 0 };
}

describe('the transcription handler', () => {
  it('runs ONE recording at a time — the queue is concurrency 1', () => {
    // Not decoration. The live box has 3 cores and a load of about 6.5 before we
    // add anything; two transcriptions at once is the thing that would be felt by
    // somebody on the phone. If this number ever changes, it was a decision.
    expect(DEFAULT_CONCURRENCY['transcription']).toBe(1);
  });

  it('transcribes the file under MEDIA_ROOT and writes text, timings, engine and status', async () => {
    const { db, writes } = fakeDb(audioRow());
    const transcriber = new StubTranscriber();
    const { logger, lines } = recorder();

    await createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job());

    // The PATH is handed to the engine: nothing is uploaded and nothing is copied.
    expect(transcriber.files).toHaveLength(1);
    expect(transcriber.files[0]).toContain('invented-call-aaaaaaaa.mp3');

    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.sql).toContain('transcript_segments = $3::jsonb');
    expect(write.sql).toContain("transcript_status = 'DONE'");
    expect(write.values[0]).toBe(RECORDING_ID);
    expect(write.values[1]).toBe(RESULT.text);
    expect(JSON.parse(String(write.values[2]))).toEqual(RESULT.segments);
    expect(write.values[3]).toBe('stub-engine:small');

    // Counts and seconds in the log, never a word of what was said.
    const said = lines.join('\n');
    expect(said).toContain('2 segments');
    expect(said).not.toContain('Dana');
  });

  it('marks the recording FAILED and re-throws, so the dead-letter bay takes it', async () => {
    // The whole failure contract in one test: the row stops looking like it is
    // still waiting its turn, and the job fails so BullMQ retries it and parks it
    // on the last attempt — the existing behaviour, with no new machinery.
    const { db, writes } = fakeDb(audioRow());
    const transcriber = new StubTranscriber();
    transcriber.failWith = new TranscriberError('not_started', 'spawn ENOENT');
    const { logger, lines } = recorder();

    await expect(
      createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job()),
    ).rejects.toThrow(TranscriberError);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain("transcript_status = 'FAILED'");
    expect(writes[0]!.values).toEqual([RECORDING_ID]);
    // Nothing was written to transcript or transcript_segments: a failed run of a
    // recording that already had a transcript must not take the transcript away.
    expect(writes[0]!.sql).not.toContain('transcript =');
    expect(lines.join('\n')).toContain('not_started');
  });

  it('still re-throws when it cannot even record the failure', async () => {
    const transcriber = new StubTranscriber();
    transcriber.failWith = new TranscriberError('timeout', '7200000ms');
    const db = {
      query: (sql: string) =>
        sql.trimStart().startsWith('SELECT')
          ? Promise.resolve({ rows: [audioRow()] })
          : Promise.reject(new Error('the database went away')),
    } as unknown as TranscriptDb;
    const { logger, lines } = recorder();

    // The real error must reach BullMQ, not the bookkeeping one.
    await expect(
      createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job()),
    ).rejects.toThrow(/timeout/);
    expect(lines.join('\n')).toContain('could not be marked FAILED');
  });

  it('does not transcribe a recording that already has one', async () => {
    // BullMQ is at-least-once: this job may well have run before. Doing it again
    // would cost half an hour of CPU to produce the same text.
    const { db, writes } = fakeDb(
      audioRow({
        transcript: RESULT.text,
        transcript_segments: RESULT.segments,
        transcript_status: 'DONE',
      }),
    );
    const transcriber = new StubTranscriber();
    const { logger, lines } = recorder();

    await createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job());

    expect(transcriber.files).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(lines.join('\n')).toContain('already has a transcript');
  });

  it('marks a video NOT_REQUIRED instead of leaving it PENDING for ever', async () => {
    // Transcripts are for calls in version one (plan §7). A video job that simply
    // completed would leave the row saying PENDING and make the backlog unreadable.
    const { db, writes } = fakeDb(audioRow({ media_type: 'VIDEO' }));
    const transcriber = new StubTranscriber();
    const { logger, lines } = recorder();

    await createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job());

    expect(transcriber.files).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain("transcript_status = 'NOT_REQUIRED'");
    expect(lines.join('\n')).toContain('NOT_REQUIRED');
  });

  it('completes quietly for a "coming soon" slot and for a recording that is gone', async () => {
    for (const row of [audioRow({ media_key: null }), null]) {
      const { db, writes } = fakeDb(row);
      const transcriber = new StubTranscriber();
      const { logger } = recorder();
      await expect(
        createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber, logger })(job()),
      ).resolves.toBeUndefined();
      expect(transcriber.files).toHaveLength(0);
      expect(writes).toHaveLength(0);
    }
  });

  it('completes without touching the database when transcription is not configured', async () => {
    // What every environment that has never heard of faster-whisper does, and
    // what the handler did for months while it was a stub. Not a failure: a
    // switched-off feature must not fill the dead-letter bay.
    const { db, writes } = fakeDb(audioRow());
    const { logger, lines } = recorder();

    await createTranscriptionHandler({ db, mediaRoot: MEDIA_ROOT, transcriber: null, logger })(
      job(),
    );
    await createTranscriptionHandler({ db: null, mediaRoot: '', transcriber: null, logger })(job());

    expect(writes).toHaveLength(0);
    expect(lines.filter((line) => line.includes('not configured'))).toHaveLength(2);
  });
});
