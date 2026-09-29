// The transcriber seam: the settings it reads, and what it makes of an engine's
// answer.
//
// NO PYTHON IS EVER RUN HERE. There is no faster-whisper installation on a CI
// runner and there may not be one on a developer's machine either, so nothing in
// this file spawns anything: the part worth testing without an installation is
// the boundary — what happens when the environment is not configured, and what is
// made of the JSON that comes back.
//
// Everything is invented. The "segments" are three made-up lines between two
// made-up people; no real call, and nothing from the prototype.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  TranscriberError,
  createWhisperTranscriber,
  parseTranscriberOutput,
  transcriberSettingsFromEnv,
} from '../../../src/media/transcriber.js';
import { readSegments } from '../../../src/media/transcriptStore.js';

const CONFIGURED = {
  TRANSCRIBE_PYTHON: '/invented/venv/bin/python',
  TRANSCRIBE_SCRIPT: '/invented/repo/ops/media/transcribe.py',
  TRANSCRIBE_MODEL: 'small',
};

describe('the transcriber settings', () => {
  it('reads the interpreter, the script and the model from the environment', () => {
    const settings = transcriberSettingsFromEnv(CONFIGURED);
    expect(settings).toEqual({
      python: '/invented/venv/bin/python',
      script: '/invented/repo/ops/media/transcribe.py',
      model: 'small',
      timeoutMs: DEFAULT_TRANSCRIBE_TIMEOUT_MS,
    });
  });

  it('names every missing variable, rather than guessing a path', () => {
    // Nothing here has a default: the interpreter lives in a virtual environment
    // whose location is a property of the machine, and a guessed path would fail
    // for the first time on a live upload.
    try {
      transcriberSettingsFromEnv({});
      expect.unreachable('it should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriberError);
      expect((err as TranscriberError).reason).toBe('not_configured');
      const message = (err as Error).message;
      for (const name of ['TRANSCRIBE_PYTHON', 'TRANSCRIBE_SCRIPT', 'TRANSCRIBE_MODEL']) {
        expect(message).toContain(name);
      }
    }

    // And one at a time, so the message is about what is actually missing.
    for (const name of ['TRANSCRIBE_PYTHON', 'TRANSCRIBE_SCRIPT', 'TRANSCRIBE_MODEL'] as const) {
      const partial = { ...CONFIGURED, [name]: '   ' };
      expect(() => transcriberSettingsFromEnv(partial)).toThrow(new RegExp(name));
    }
  });

  it('leaves the beam width and the thread count unset unless the machine says', () => {
    // Unset is the normal case and it means something: the beam default lives in
    // the script (1, measured at 2.4x the speed of 5 for the same words) and the
    // thread default lives in the library (right on a 3-core box shared with 26
    // other applications). Two copies of a default are two things to disagree.
    const bare = transcriberSettingsFromEnv(CONFIGURED);
    expect('beamSize' in bare).toBe(false);
    expect('cpuThreads' in bare).toBe(false);

    const set = transcriberSettingsFromEnv({
      ...CONFIGURED,
      TRANSCRIBE_BEAM_SIZE: '5',
      TRANSCRIBE_CPU_THREADS: '16',
    });
    expect(set.beamSize).toBe(5);
    expect(set.cpuThreads).toBe(16);

    // Refused rather than clamped: transcribing the backlog at beam 37 for a week
    // is worse than not starting.
    for (const bad of ['0', '-1', 'lots', '2.5', '99']) {
      expect(() =>
        transcriberSettingsFromEnv({ ...CONFIGURED, TRANSCRIBE_BEAM_SIZE: bad }),
      ).toThrow(/TRANSCRIBE_BEAM_SIZE/);
    }
    for (const bad of ['0', '-4', 'all', '1000']) {
      expect(() =>
        transcriberSettingsFromEnv({ ...CONFIGURED, TRANSCRIBE_CPU_THREADS: bad }),
      ).toThrow(/TRANSCRIBE_CPU_THREADS/);
    }
  });

  it('takes the timeout from the environment and refuses a silly one', () => {
    expect(
      transcriberSettingsFromEnv({ ...CONFIGURED, TRANSCRIBE_TIMEOUT_MS: '600000' }).timeoutMs,
    ).toBe(600_000);
    for (const bad of ['1000', 'ages', '-5', '999999999']) {
      expect(() =>
        transcriberSettingsFromEnv({ ...CONFIGURED, TRANSCRIBE_TIMEOUT_MS: bad }),
      ).toThrow(/TRANSCRIBE_TIMEOUT_MS/);
    }
  });

  it('records the model in the engine name, so a transcript can be traced', () => {
    // Which model ships is still being judged from real transcripts, so the day
    // will come when somebody has to find the ones made by the rejected model.
    expect(createWhisperTranscriber(transcriberSettingsFromEnv(CONFIGURED)).name).toBe(
      'faster-whisper:small',
    );
    expect(
      createWhisperTranscriber(
        transcriberSettingsFromEnv({ ...CONFIGURED, TRANSCRIBE_MODEL: 'medium' }),
      ).name,
    ).toBe('faster-whisper:medium');
  });
});

describe("what is made of the engine's answer", () => {
  const good = JSON.stringify({
    segments: [
      { start: 0, end: 3.5, text: ' Good morning, this is Dana from the claims team.' },
      { start: 3.5, end: 5.25, text: 'Speaking.' },
      { start: 6, end: 9.75, text: 'I am calling about the questionnaire.' },
    ],
    language: 'en',
    duration: 10.5,
    model: 'small',
  });

  it('keeps the timings, trims the text and joins it into one transcript', () => {
    const result = parseTranscriberOutput(good, 'faster-whisper:small');
    expect(result.segments).toEqual([
      { start: 0, end: 3.5, text: 'Good morning, this is Dana from the claims team.' },
      { start: 3.5, end: 5.25, text: 'Speaking.' },
      { start: 6, end: 9.75, text: 'I am calling about the questionnaire.' },
    ]);
    expect(result.text.split('\n')).toHaveLength(3);
    expect(result.language).toBe('en');
    expect(result.durationSecs).toBe(10.5);
    expect(result.engine).toBe('faster-whisper:small');
  });

  it('drops blank segments, clamps a reversed one and sorts them', () => {
    const messy = JSON.stringify({
      segments: [
        { start: 9, end: 12, text: 'Last thing said.' },
        { start: 4, end: 2, text: 'Out of order and ends before it starts.' },
        { start: 5, end: 6, text: '   ' },
        { start: -1, end: 1, text: 'First thing said.' },
      ],
    });
    const result = parseTranscriberOutput(messy, 'engine');
    expect(result.segments).toEqual([
      // A negative start is clamped to 0 and a reversed end to its own start:
      // one odd timing is not a reason to throw away half an hour of CPU.
      { start: 0, end: 1, text: 'First thing said.' },
      { start: 4, end: 4, text: 'Out of order and ends before it starts.' },
      { start: 9, end: 12, text: 'Last thing said.' },
    ]);
    expect(result.language).toBeNull();
    expect(result.durationSecs).toBeNull();
  });

  it('carries the speaker through, and leaves the key off when there is none', () => {
    // 'A' and 'B' are the recording's two channels. The key is ABSENT rather than
    // null on a line nobody could attribute: it is stored as JSON, and a null on
    // every line of every unlabelled transcript would be a third case for every
    // reader to get right.
    const labelled = parseTranscriberOutput(
      JSON.stringify({
        segments: [
          { start: 0, end: 2, text: 'One side.', speaker: 'A' },
          { start: 2, end: 4, text: 'The other.', speaker: 'B' },
          { start: 4, end: 6, text: 'Both at once.' },
          // Something a later engine might send. It must not fail the whole
          // transcript, and it must not reach a trainee either.
          { start: 6, end: 8, text: 'A third voice?', speaker: 'C' },
        ],
      }),
      'engine',
    );
    expect(labelled.segments).toEqual([
      { start: 0, end: 2, text: 'One side.', speaker: 'A' },
      { start: 2, end: 4, text: 'The other.', speaker: 'B' },
      { start: 4, end: 6, text: 'Both at once.' },
      { start: 6, end: 8, text: 'A third voice?' },
    ]);
    expect('speaker' in labelled.segments[2]!).toBe(false);
    expect('speaker' in labelled.segments[3]!).toBe(false);
  });

  it('refuses an answer it cannot use, without quoting it', () => {
    for (const bad of [
      '',
      'Traceback (most recent call last): ModuleNotFoundError: faster_whisper',
      '{"segments": "all of them"}',
      '{"segments": [{"start": "0", "end": 1, "text": "x"}]}',
      // Something ran, and said nothing was said. There is no transcript to save.
      '{"segments": []}',
      '{"segments": [{"start": 0, "end": 1, "text": "  "}]}',
    ]) {
      try {
        parseTranscriberOutput(bad, 'engine');
        expect.unreachable(`it should have refused: ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(TranscriberError);
        expect((err as TranscriberError).reason).toBe('unusable_answer');
        // A failing engine loves to echo its input. The message carries a length
        // and a reason, never the output itself.
        expect((err as Error).message).not.toContain('Traceback');
        expect((err as Error).message).not.toContain('segments');
      }
    }
  });
});

describe('reading segments back out of the database', () => {
  it('returns them in order, and survives a row nothing in this app wrote', () => {
    // 0010's CHECK guarantees an array; the ELEMENTS are unchecked, so a
    // hand-written backfill or a future pipeline could put anything in one. A
    // partly readable transcript is better than a player that will not draw.
    expect(
      readSegments([
        { start: 4, end: 5, text: 'Second.' },
        { start: 1, end: 2, text: ' First. ' },
        { start: 9, end: 9, text: '' },
        { start: 'x', end: 2, text: 'Not a number.' },
        null,
        'a line',
        { start: 7, end: 3, text: 'Ends before it starts.' },
      ]),
    ).toEqual([
      { start: 1, end: 2, text: 'First.' },
      { start: 4, end: 5, text: 'Second.' },
      { start: 7, end: 7, text: 'Ends before it starts.' },
    ]);
  });

  it('keeps a speaker it recognises and drops anything else', () => {
    // The elements of the column are unchecked by the database. A hand-written
    // backfill must not be able to put an arbitrary string in front of a trainee
    // as if it were the name of the person on the call.
    expect(
      readSegments([
        { start: 0, end: 1, text: 'Left.', speaker: 'A' },
        { start: 1, end: 2, text: 'Right.', speaker: 'B' },
        { start: 2, end: 3, text: 'Nobody could tell.' },
        { start: 3, end: 4, text: 'Made up.', speaker: 'Mrs Smith' },
        { start: 4, end: 5, text: 'Not a string.', speaker: 7 },
      ]),
    ).toEqual([
      { start: 0, end: 1, text: 'Left.', speaker: 'A' },
      { start: 1, end: 2, text: 'Right.', speaker: 'B' },
      { start: 2, end: 3, text: 'Nobody could tell.' },
      { start: 3, end: 4, text: 'Made up.' },
      { start: 4, end: 5, text: 'Not a string.' },
    ]);
  });

  it('treats anything that is not an array as no segments at all', () => {
    for (const value of [null, undefined, {}, '[]', 3]) {
      expect(readSegments(value)).toEqual([]);
    }
  });
});
