import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { TRANSCRIPT_SPEAKERS } from '@fac-academy/shared';
import type { TranscriptSpeaker } from '@fac-academy/shared';

// The ONE place that turns a file on disk into timed lines of text.
//
// Everything else in the codebase — the backlog script in ops/media/ and the
// worker's transcription handler — sees only the `Transcriber` interface below.
// Swapping faster-whisper for something else (a different model runner, a
// different engine, one day a service) is this file and nothing else: write a
// second `create…Transcriber` here, return it from the settings, and neither the
// script nor the queue handler changes a line. That is deliberate, because which
// engine and which model size we ship is still an open question — the plan says
// to judge it from a real transcript rather than in advance.
//
// TWO THINGS THAT ARE NOT NEGOTIABLE IN THIS FILE
//
// WHERE THE AUDIO GOES: nowhere. The bytes are a real client call. This module
// hands a LOCAL FILE PATH to a LOCAL interpreter and reads text back from its
// standard output. Nothing is uploaded, and there is no URL anywhere in here —
// that is the whole reason transcription runs on our own hardware (plan §1) and
// the difference between this and the summary model, which can be configured to
// reach a third party. If you add a network call to this file you have changed
// what the company agreed to.
//
// WHAT IS LOGGED: never a word of the transcript, and never the language model's
// stderr verbatim beyond its last couple of lines (a Python traceback can quote
// the input path, which is fine, but a chatty library could quote content). Ids,
// counts, seconds and the model name only.

/** One timed line: what was said, and between which two seconds of the media. */
export interface TranscribedSegment {
  start: number;
  end: number;
  text: string;
  /**
   * Which channel said it: 'A' left, 'B' right. Absent when nobody could tell —
   * see TRANSCRIPT_SPEAKERS in the shared contract for why it is not 'agent' and
   * 'client', and ops/media/transcribe.py for how it is worked out (channel
   * energy, no model).
   */
  speaker?: TranscriptSpeaker;
}

/** Everything one run produces. `engine` is stored in transcript_engine. */
export interface TranscriptResult {
  /** Ascending by `start`, with the blank segments dropped. */
  segments: TranscribedSegment[];
  /** The whole transcript as plain text, one line per segment. */
  text: string;
  /** Whatever the engine detected, e.g. 'en'. Null when it does not say. */
  language: string | null;
  /** The engine's own idea of the media length, in seconds. Null when absent. */
  durationSecs: number | null;
  /** What produced it, e.g. 'faster-whisper:small'. Recorded with the text. */
  engine: string;
}

export interface Transcriber {
  /** The engine and model, as recorded in transcript_engine. */
  readonly name: string;
  /** Resolves to the text and its timings, or throws TranscriberError. */
  transcribe(file: string): Promise<TranscriptResult>;
}

/**
 * Anything that stopped us getting a transcript. `reason` is safe to log, safe
 * to count and safe to put in a dead-letter entry; there is deliberately no
 * field carrying transcript text.
 */
export class TranscriberError extends Error {
  readonly reason:
    'not_configured' | 'unreadable_file' | 'not_started' | 'failed' | 'timeout' | 'unusable_answer';

  constructor(reason: TranscriberError['reason'], detail: string) {
    super(`transcription failed (${reason}: ${detail})`);
    this.name = 'TranscriberError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// What the Python side prints
// ---------------------------------------------------------------------------

/**
 * ops/media/transcribe.py prints exactly this, as one JSON object on stdout and
 * nothing else. Unknown keys are ignored, so the script may grow a field
 * without this end having to be redeployed first.
 */
const TranscriberOutputSchema = z.object({
  segments: z.array(
    z.object({
      start: z.number().finite(),
      end: z.number().finite(),
      text: z.string(),
      // Absent on a line nobody could attribute, and absent on every line of a
      // file that turned out not to be dual-channel. `catch` rather than a plain
      // optional: an unexpected value (a third speaker from some future engine)
      // becomes "unknown" instead of failing the whole transcript.
      speaker: z.enum(TRANSCRIPT_SPEAKERS).optional().catch(undefined),
    }),
  ),
  language: z.string().nullable().optional(),
  duration: z.number().finite().nullable().optional(),
});

/**
 * The engine's answer, tidied into a TranscriptResult.
 *
 * Exported because it is the part worth testing without a Python installation:
 * everything that could realistically be wrong with an engine's output — a
 * segment that ends before it starts, a blank one, whitespace Whisper puts at
 * the front of every line, segments out of order — is handled here.
 */
export function parseTranscriberOutput(stdout: string, engine: string): TranscriptResult {
  let parsed: z.infer<typeof TranscriberOutputSchema>;
  try {
    parsed = TranscriberOutputSchema.parse(JSON.parse(stdout));
  } catch {
    // Never the output itself: on a bad run it can be a Python traceback that
    // quotes the file, or in the worst case a partial transcript.
    throw new TranscriberError(
      'unusable_answer',
      `not the expected JSON shape (${String(stdout.length)} chars on stdout)`,
    );
  }

  const segments: TranscribedSegment[] = [];
  for (const raw of parsed.segments) {
    const text = raw.text.trim();
    // A blank segment is a pause the engine bothered to mention. It would be a
    // clickable empty row in the panel, so it is dropped here rather than in
    // three places downstream.
    if (text === '') continue;
    const start = Math.max(0, raw.start);
    // A segment that ends before it starts cannot be highlighted against a
    // playing clock. Clamp rather than refuse the whole transcript: one odd
    // timing is not a reason to throw away thirty minutes of CPU.
    const end = Math.max(start, raw.end);
    // The key is left off entirely when there is no speaker, rather than set to
    // null: it is stored as JSON, and `{"speaker": null}` on every line of every
    // unlabelled transcript would be noise in the column and a third case
    // ('missing', 'null', 'set') for every reader to get right.
    segments.push(
      raw.speaker === undefined ? { start, end, text } : { start, end, text, speaker: raw.speaker },
    );
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);

  if (segments.length === 0) {
    throw new TranscriberError('unusable_answer', 'no speech in the answer');
  }

  return {
    segments,
    text: segments.map((s) => s.text).join('\n'),
    language: parsed.language ?? null,
    durationSecs: parsed.duration ?? null,
    engine,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface WhisperSettings {
  /** TRANSCRIBE_PYTHON: the interpreter of the virtual environment. */
  python: string;
  /** TRANSCRIBE_SCRIPT: the absolute path of ops/media/transcribe.py. */
  script: string;
  /** TRANSCRIBE_MODEL: 'small', 'base', 'medium' — a setting, not a constant. */
  model: string;
  /** TRANSCRIBE_TIMEOUT_MS. */
  timeoutMs: number;
  /**
   * TRANSCRIBE_BEAM_SIZE: the decoder's beam width. Undefined means "whatever the
   * script's own default is", which is 1.
   *
   * MEASURED on one real 13m29s call with the `small` model: beam 1 took 371
   * seconds and beam 5 took 894 — two and a half times the work for the same word
   * count and a read that was no better. Beam search earns its keep on ambiguous
   * audio; a two-party phone call in English is not that. It is a setting only so
   * that the comparison can be repeated the day a genuinely bad recording turns
   * up, and it is passed through rather than defaulted here so that the script
   * stays the one place the default lives.
   */
  beamSize?: number;
  /**
   * TRANSCRIBE_CPU_THREADS: how many threads the decoder may use. Undefined means
   * "let the library decide", which is the right answer on the live box — 3 cores
   * shared with 26 other applications. The development machine has 16 cores and
   * nothing competing, and the backlog is transcribed there, so it can say so.
   * A property of the MACHINE, which is exactly why it is in the environment.
   */
  cpuThreads?: number;
  /**
   * Run at the lowest priority the OS offers. True everywhere except a test.
   * On the server this is not optional: see spawnLowest below.
   */
  lowestPriority?: boolean;
}

/** Two hours. A 20-minute call at the plan's worst case (4x) is 80 minutes. */
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * The settings from the environment, or a refusal that names what is missing.
 *
 * Nothing here has a default path. The interpreter lives in a virtual
 * environment whose location is a property of the machine, and the script's
 * location is a property of the deployment (the API and the worker are bundled
 * into server/dist, so a path relative to this module is right in development
 * and wrong in production — which is exactly the kind of difference that only
 * shows up the first time somebody uploads a recording to the live academy).
 * So all three are named in the environment, and a missing one is a clear
 * message rather than a guess.
 */
export function transcriberSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): WhisperSettings {
  const read = (name: string): string => env[name]?.trim() ?? '';
  const python = read('TRANSCRIBE_PYTHON');
  const script = read('TRANSCRIBE_SCRIPT');
  const model = read('TRANSCRIBE_MODEL');

  const missing = [
    python === '' ? 'TRANSCRIBE_PYTHON' : null,
    script === '' ? 'TRANSCRIBE_SCRIPT' : null,
    model === '' ? 'TRANSCRIBE_MODEL' : null,
  ].filter((n): n is string => n !== null);

  if (missing.length > 0) {
    throw new TranscriberError(
      'not_configured',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'TRANSCRIBE_PYTHON is the interpreter of the virtual environment that has ' +
        'faster-whisper installed, TRANSCRIBE_SCRIPT is the absolute path of ' +
        "ops/media/transcribe.py, and TRANSCRIBE_MODEL is the model to use ('small' " +
        "is where the plan says to start; 'base' is quicker and 'medium' more accurate).",
    );
  }

  const rawTimeout = read('TRANSCRIBE_TIMEOUT_MS');
  let timeoutMs = DEFAULT_TRANSCRIBE_TIMEOUT_MS;
  if (rawTimeout !== '') {
    const value = Number(rawTimeout);
    if (!Number.isInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1000) {
      throw new TranscriberError(
        'not_configured',
        'TRANSCRIBE_TIMEOUT_MS must be a whole number of milliseconds between 60000 and 86400000',
      );
    }
    timeoutMs = value;
  }

  // Two optional numbers. Unset is the normal case and means "the script decides"
  // (beam 1) and "the library decides" (threads); a nonsense value is refused
  // rather than clamped, because silently transcribing at beam 37 for a week is
  // worse than not starting.
  const optionalCount = (name: string, max: number): number | undefined => {
    const raw = read(name);
    if (raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new TranscriberError(
        'not_configured',
        `${name} must be a whole number between 1 and ${String(max)}`,
      );
    }
    return value;
  };

  const settings: WhisperSettings = { python, script, model, timeoutMs };
  const beamSize = optionalCount('TRANSCRIBE_BEAM_SIZE', 10);
  if (beamSize !== undefined) settings.beamSize = beamSize;
  const cpuThreads = optionalCount('TRANSCRIBE_CPU_THREADS', 256);
  if (cpuThreads !== undefined) settings.cpuThreads = cpuThreads;
  return settings;
}

// ---------------------------------------------------------------------------
// Lowest priority
// ---------------------------------------------------------------------------

/**
 * Start a process at the lowest priority the operating system offers.
 *
 * This is the single most important line of the server half of this feature. The
 * box has 3 cores, runs 26 applications for the whole company and already sits
 * at a load of about 6.5 — twice oversubscribed before we add anything (plan
 * §4). Transcribing is CPU-hungry for tens of minutes at a time. At nice 19 the
 * kernel gives it whatever nobody else wants, so the CRM always wins the
 * processor; at the default priority it would compete with the CRM as an equal,
 * and the first person to notice would be a member of staff on the phone.
 *
 * On Linux and macOS that is `nice -n 19 <interpreter> …`, which is also the
 * version an operator can SEE: `ps -o ni` prints 19 beside the process, so the
 * promise is checkable from outside this codebase rather than only inside it.
 *
 * Windows has no `nice`. There the process is started normally and then dropped
 * to the lowest priority class through os.setPriority. The gap between the two
 * calls is a few milliseconds of a job that runs for half an hour, and the
 * development machine has 16 cores with nothing else competing — the plan puts
 * the backlog there precisely because it can afford it.
 */
export function spawnLowest(
  command: string,
  args: readonly string[],
  lowest = true,
): ChildProcessWithoutNullStreams {
  const useNice = lowest && process.platform !== 'win32';
  const child = useNice
    ? spawn('nice', ['-n', '19', command, ...args], { windowsHide: true })
    : spawn(command, [...args], { windowsHide: true });

  if (lowest && !useNice && child.pid !== undefined) {
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      // Not fatal, and not silent: a machine that refuses the call still gets
      // its transcript, and whoever reads the log knows the promise was not
      // kept on this run.
      console.warn(
        '[academy-transcribe] could not lower the process priority; ' +
          'it is running at the normal priority instead',
      );
    }
  }
  return child;
}

// ---------------------------------------------------------------------------
// faster-whisper, through ops/media/transcribe.py
// ---------------------------------------------------------------------------

/** Most bytes we will read from the script's stdout: ~8 MB of JSON is 90 minutes. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/**
 * The faster-whisper transcriber: one local Python process per recording, its
 * JSON read off stdout.
 *
 * No retry. A failure means nothing was written, the caller records FAILED and
 * the queue's own attempts (or the backlog script's next run) decide whether to
 * try again. A silent retry inside here would double a half-hour job and hide a
 * broken installation from whoever has to fix it.
 */
export function createWhisperTranscriber(settings: WhisperSettings): Transcriber {
  const engine = `faster-whisper:${settings.model}`;

  return {
    name: engine,

    async transcribe(file: string): Promise<TranscriptResult> {
      // The file first: a missing or unreadable path is a configuration mistake
      // and must not look like an engine failure.
      try {
        await access(file, constants.R_OK);
        const info = await stat(file);
        if (!info.isFile()) throw new Error('not a file');
        if (info.size === 0) throw new Error('empty');
      } catch (err) {
        throw new TranscriberError('unreadable_file', (err as Error).message);
      }

      const child = spawnLowest(
        settings.python,
        [
          settings.script,
          '--file',
          file,
          '--model',
          settings.model,
          // Only when set: an unset one leaves the script's own default in place,
          // so there is one place per default rather than two that can disagree.
          ...(settings.beamSize === undefined ? [] : ['--beam-size', String(settings.beamSize)]),
          ...(settings.cpuThreads === undefined
            ? []
            : ['--cpu-threads', String(settings.cpuThreads)]),
        ],
        settings.lowestPriority ?? true,
      );

      const out: Buffer[] = [];
      let outBytes = 0;
      let overflowed = false;
      const errTail: string[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          overflowed = true;
          return;
        }
        out.push(chunk);
      });
      // Whisper's progress chatter goes to stderr. Only the last few lines are
      // kept, and only so a failure can say something useful.
      child.stderr.on('data', (chunk: Buffer) => {
        errTail.push(chunk.toString('utf8'));
        if (errTail.length > 20) errTail.splice(0, errTail.length - 20);
      });

      const finished = await new Promise<
        { ok: true } | { ok: false; reason: TranscriberError['reason']; detail: string }
      >((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({
            ok: false,
            reason: 'timeout',
            detail: `${String(settings.timeoutMs)}ms`,
          });
        }, settings.timeoutMs);
        timer.unref();

        child.once('error', (err: Error) => {
          clearTimeout(timer);
          // ENOENT here is the interpreter or `nice` not being where we were
          // told it is — the commonest failure on a fresh machine, and worth
          // saying plainly rather than as "exit code null".
          resolve({ ok: false, reason: 'not_started', detail: err.message });
        });

        child.once('close', (code: number | null, signal: string | null) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ ok: true });
            return;
          }
          const tail = errTail.join('').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
          resolve({
            ok: false,
            reason: 'failed',
            detail: `exit ${code === null ? `signal ${signal ?? '?'}` : String(code)}${
              tail === '' ? '' : `: ${tail}`
            }`,
          });
        });
      });

      if (!finished.ok) throw new TranscriberError(finished.reason, finished.detail);
      if (overflowed) {
        throw new TranscriberError(
          'unusable_answer',
          `more than ${String(MAX_STDOUT_BYTES)} bytes on stdout`,
        );
      }

      return parseTranscriberOutput(Buffer.concat(out).toString('utf8'), engine);
    },
  };
}

/**
 * The configured transcriber, or a refusal naming what is missing. One call for
 * both the worker and the backlog script, so they can never disagree about which
 * engine or which model is in use.
 */
export function createTranscriberFromEnv(env: NodeJS.ProcessEnv = process.env): Transcriber {
  return createWhisperTranscriber(transcriberSettingsFromEnv(env));
}
