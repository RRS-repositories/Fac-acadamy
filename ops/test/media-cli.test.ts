// Unit tests for the two media CLIs (ops/media/). No database and no real
// recording: the only audio here is a silent WAV generated in the test, and
// the only "prototype" is a synthetic one written in the fixture below.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEmbeddedMedia } from '../media/embedded.js';
import { parseExtractArgs } from '../media/extract-media.js';
import { ingestKey, parseIngestArgs } from '../media/ingest-media.js';
import { coverageOf, parseTranscribeArgs } from '../media/transcribe.js';
import {
  DEFAULT_MAX_MEDIA_MB,
  assertMediaFileOutsideRepo,
  assertWithinSize,
  looksLikeProduction,
  maxMediaBytes,
  mediaTypeOf,
  parseExpectDb,
  probeDurationSecs,
} from '../media/lib.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** A silent 16-bit mono WAV of `seconds` seconds: a real file, invented content. */
export function makeWav(seconds: number, sampleRate = 8000): Buffer {
  const dataSize = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'academy-media-test-'));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe('the wrong-database guard', () => {
  it('requires --expect-db', () => {
    expect(() => parseExpectDb(undefined)).toThrow(/--expect-db/);
    expect(() => parseExpectDb('   ')).toThrow(/--expect-db/);
  });

  it('refuses a name that looks like production', () => {
    for (const name of ['crm_production', 'academy_prod', 'fac-live', 'LIVE_DB']) {
      expect(looksLikeProduction(name)).toBe(true);
      expect(() => parseExpectDb(name)).toThrow(/looks like production/);
    }
  });

  it('accepts a local or staging name', () => {
    for (const name of ['academy_dev', 'academy_test', 'academy']) {
      expect(looksLikeProduction(name)).toBe(false);
      expect(parseExpectDb(name)).toBe(name);
    }
  });
});

describe('extract-media arguments', () => {
  it('parses --expect-db and --dry-run', () => {
    expect(parseExtractArgs(['--expect-db', 'academy_dev'])).toEqual({
      expectDb: 'academy_dev',
      dryRun: false,
    });
    expect(parseExtractArgs(['--expect-db', 'academy_dev', '--dry-run']).dryRun).toBe(true);
  });

  it('refuses an unknown flag and a production database', () => {
    expect(() => parseExtractArgs(['--expect-db', 'academy_dev', '--force'])).toThrow(/Usage/);
    expect(() => parseExtractArgs(['--expect-db', 'academy_production'])).toThrow(
      /looks like production/,
    );
    expect(() => parseExtractArgs([])).toThrow(/--expect-db/);
  });
});

describe('ingest-media arguments', () => {
  const base = [
    '--file',
    'E:/somewhere/outside/call.mp3',
    '--stage',
    's4',
    '--title',
    'Reminder call done right',
    '--expect-db',
    'academy_dev',
  ];

  it('parses the full set', () => {
    expect(
      parseIngestArgs([
        ...base,
        '--description',
        'Remind and resend only',
        '--recording-code',
        's4-rec1',
      ]),
    ).toEqual({
      file: 'E:/somewhere/outside/call.mp3',
      stageCode: 's4',
      title: 'Reminder call done right',
      description: 'Remind and resend only',
      recordingCode: 's4-rec1',
      expectDb: 'academy_dev',
      dryRun: false,
      replace: false,
    });
  });

  it('only overwrites an existing slot when --replace is given', () => {
    expect(parseIngestArgs(base).replace).toBe(false);
    expect(parseIngestArgs([...base, '--replace']).replace).toBe(true);
  });

  it('requires --file, --stage, --title and --expect-db', () => {
    expect(() => parseIngestArgs(base.slice(2))).toThrow(/--file/);
    expect(() => parseIngestArgs(['--file', 'x.mp3', '--title', 't', '--expect-db', 'd'])).toThrow(
      /--stage/,
    );
    expect(() => parseIngestArgs(['--file', 'x.mp3', '--stage', 's4', '--expect-db', 'd'])).toThrow(
      /--title/,
    );
    expect(() => parseIngestArgs(['--file', 'x.mp3', '--stage', 's4', '--title', 't'])).toThrow(
      /--expect-db/,
    );
  });

  it('checks the shape of the codes and the length of the text', () => {
    expect(() => parseIngestArgs([...base.slice(0, 3), 'bad stage!', ...base.slice(4)])).toThrow(
      /--stage/,
    );
    expect(() => parseIngestArgs([...base, '--recording-code', 'no spaces here'])).toThrow(
      /--recording-code/,
    );
    expect(() => parseIngestArgs([...base.slice(0, 5), 'x'.repeat(201), ...base.slice(6)])).toThrow(
      /--title is too long/,
    );
    expect(() => parseIngestArgs([...base, '--description', 'y'.repeat(1001)])).toThrow(
      /--description is too long/,
    );
  });

  it('refuses a production database', () => {
    expect(() => parseIngestArgs([...base.slice(0, 7), 'academy_live'])).toThrow(
      /looks like production/,
    );
  });
});

describe('transcribe arguments and guards', () => {
  const base = ['--expect-db', 'academy_dev'];

  it('is a DRY RUN unless --commit is given', () => {
    // The opposite way round from ingest-media, on purpose: this one walks every
    // pending recording in the database and rewrites a column on each.
    expect(parseTranscribeArgs(base).commit).toBe(false);
    expect(parseTranscribeArgs([...base, '--commit']).commit).toBe(true);
    // --dry-run is accepted and is what happens anyway; asking for both is a
    // contradiction and is refused rather than guessed at.
    expect(parseTranscribeArgs([...base, '--dry-run']).commit).toBe(false);
    expect(() => parseTranscribeArgs([...base, '--dry-run', '--commit'])).toThrow(/contradict/);
  });

  it('requires --expect-db', () => {
    expect(() => parseTranscribeArgs([])).toThrow(/--expect-db/);
    expect(() => parseTranscribeArgs(['--expect-db', '  '])).toThrow(/--expect-db/);
  });

  it('REFUSES A PRODUCTION DATABASE unless --confirm-production is given', () => {
    // The whole point of the backlog script is that it runs on a development
    // machine. Reaching the live academy from it has to be deliberate, and the
    // live database has to be named twice in two different arguments.
    for (const name of ['client_credentials', 'academy_production', 'fac-live', 'LIVE_DB']) {
      expect(() => parseTranscribeArgs(['--expect-db', name])).toThrow(/--confirm-production/);
      expect(() => parseTranscribeArgs(['--expect-db', name, '--commit'])).toThrow(
        /--confirm-production/,
      );
      expect(parseTranscribeArgs(['--expect-db', name, '--confirm-production']).expectDb).toBe(
        name,
      );
    }
  });

  it('takes one recording, a limit and --replace, and checks the shape of each', () => {
    expect(parseTranscribeArgs(base)).toEqual({
      expectDb: 'academy_dev',
      commit: false,
      recordingId: null,
      limit: null,
      replace: false,
    });
    expect(parseTranscribeArgs([...base, '--recording', '50']).recordingId).toBe(50);
    expect(parseTranscribeArgs([...base, '--limit', '3']).limit).toBe(3);
    expect(parseTranscribeArgs([...base, '--replace']).replace).toBe(true);

    for (const bad of ['0', '-1', 'fifty', '1.5']) {
      expect(() => parseTranscribeArgs([...base, '--recording', bad])).toThrow(/--recording/);
    }
    // A blank value is "not given", the same as leaving the flag off.
    expect(parseTranscribeArgs([...base, '--recording', '  ']).recordingId).toBeNull();
    for (const bad of ['0', 'three', '-2']) {
      expect(() => parseTranscribeArgs([...base, '--limit', bad])).toThrow(/--limit/);
    }
  });

  it('refuses an unknown flag with the usage line', () => {
    expect(() => parseTranscribeArgs([...base, '--force'])).toThrow(/Usage/);
  });
});

describe('did the transcript cover the whole recording', () => {
  // The check that matters after a run, because a transcription does not fail
  // loudly when it goes wrong - it comes back SHORTER, reading perfectly well.
  // The numbers below are the real ones from the trial of 28 Sep 2026: the good
  // configurations covered 98.8-100% of the audio with no gap over 5 seconds, and
  // the one that silently dropped 24% of the call covered 93% with a 19-second
  // gap. Invented words here, real arithmetic.
  const line = (start: number, end: number, words = 10) => ({
    start,
    end,
    text: Array.from({ length: words }, () => 'word').join(' '),
  });

  it('passes a run that accounts for the whole call', () => {
    const cover = coverageOf([line(0, 30, 70), line(30, 60, 70), line(60.5, 120, 145)], 120);
    expect(cover.covered).toBeCloseTo(0.996, 2);
    expect(cover.maxGap).toBeCloseTo(0.5, 5);
    expect(cover.words).toBe(285);
    expect(cover.wordsPerMin).toBeCloseTo(142.5, 1);
    expect(cover.perfect).toBe(true);
  });

  it('FLAGS a run with a hole in the middle, however well it reads', () => {
    // 19 seconds of a two-party phone call in which nobody said anything is not a
    // silence: it is a passage the decoder walked past.
    const cover = coverageOf([line(0, 40), line(59, 120)], 120);
    expect(cover.maxGap).toBeCloseTo(19, 5);
    expect(cover.perfect).toBe(false);
  });

  it('FLAGS a run that stops early, and says where it stopped', () => {
    const cover = coverageOf([line(0, 80), line(80, 90)], 120);
    expect(cover.spanned).toBeCloseTo(0.75, 5);
    expect(cover.covered).toBeCloseTo(0.75, 5);
    expect(cover.perfect).toBe(false);
  });

  it('merges overlapping lines rather than counting a second twice', () => {
    // Whisper can hand back two segments that overlap. Adding their lengths would
    // report more than 100% and hide a gap somewhere else.
    const cover = coverageOf([line(0, 60), line(30, 90), line(90, 100)], 100);
    expect(cover.covered).toBeCloseTo(1, 5);
    expect(cover.maxGap).toBe(0);
  });

  it('claims nothing about the shares when the length is unknown', () => {
    // No duration means the engine did not say how long the file was. Unknown is
    // not the same as complete, so it is not called perfect.
    const cover = coverageOf([line(0, 60)], null);
    expect(cover.covered).toBe(0);
    expect(cover.perfect).toBe(false);
    expect(cover.words).toBe(10);
  });

  it('counts no words and no gap for a transcript with nothing in it', () => {
    const cover = coverageOf([], 60);
    expect(cover).toMatchObject({ covered: 0, maxGap: 0, words: 0, perfect: false });
  });
});

describe('accepted media types', () => {
  it('takes mp3, m4a, wav and mp4', () => {
    expect(mediaTypeOf('call.mp3').contentType).toBe('audio/mpeg');
    expect(mediaTypeOf('call.M4A').contentType).toBe('audio/mp4');
    expect(mediaTypeOf('call.wav').mediaType).toBe('AUDIO');
    expect(mediaTypeOf('screen.mp4').mediaType).toBe('VIDEO');
  });

  it('refuses anything else', () => {
    for (const name of ['notes.txt', 'call.ogg', 'call.aac', 'call']) {
      expect(() => mediaTypeOf(name)).toThrow(/Unsupported media file/);
    }
  });
});

describe('the size limit', () => {
  it('defaults to MEDIA_MAX_UPLOAD_MB and reads it from the environment', () => {
    expect(maxMediaBytes({})).toBe(DEFAULT_MAX_MEDIA_MB * 1024 * 1024);
    expect(maxMediaBytes({ MEDIA_MAX_UPLOAD_MB: '5' })).toBe(5 * 1024 * 1024);
    expect(() => maxMediaBytes({ MEDIA_MAX_UPLOAD_MB: 'big' })).toThrow(/MEDIA_MAX_UPLOAD_MB/);
    expect(() => maxMediaBytes({ MEDIA_MAX_UPLOAD_MB: '0' })).toThrow(/MEDIA_MAX_UPLOAD_MB/);
  });

  it('refuses an oversize and an empty file', () => {
    expect(() => assertWithinSize(2048, 1024, 'call.mp3')).toThrow(/over the/);
    expect(() => assertWithinSize(0, 1024, 'call.mp3')).toThrow(/is empty/);
    expect(() => assertWithinSize(1024, 1024, 'call.mp3')).not.toThrow();
  });
});

describe('a media file inside the repo', () => {
  it('is refused, because git would pick it up', async () => {
    const inside = path.join(REPO_ROOT, 'ops', 'test', 'not-a-real-recording.wav');
    await writeFile(inside, makeWav(1));
    try {
      expect(() => assertMediaFileOutsideRepo(inside)).toThrow(/inside the repo/);
      // A relative path resolves to the same place and is refused too.
      expect(() => assertMediaFileOutsideRepo('ops/test/not-a-real-recording.wav')).toThrow(
        /inside the repo|does not point at a file/,
      );
    } finally {
      await rm(inside, { force: true });
    }
  });

  it('accepts a file outside the repo, and rejects a missing one', async () => {
    const dir = await tempDir();
    const outside = path.join(dir, 'invented-call.wav');
    await writeFile(outside, makeWav(1));
    expect(assertMediaFileOutsideRepo(outside).toLowerCase()).toContain('invented-call.wav');
    expect(() => assertMediaFileOutsideRepo(path.join(dir, 'missing.wav'))).toThrow(
      /does not point at a file/,
    );
  });
});

describe('the store key for an ingested file', () => {
  const sha = 'a'.repeat(64);

  it('is content-addressed and safe', () => {
    expect(ingestKey('/outside/repo/Live Call (D1).mp3', sha)).toBe(
      'academy/media/Live-Call-D1-aaaaaaaa.mp3',
    );
    expect(ingestKey('/outside/repo/____.wav', sha)).toBe('academy/media/media--aaaaaaaa.wav');
    expect(ingestKey('/outside/repo/x.mp4', 'b'.repeat(64))).toBe('academy/media/x-bbbbbbbb.mp4');
  });

  it('refuses a file type we do not take', () => {
    expect(() => ingestKey('/outside/repo/call.ogg', sha)).toThrow(/Unsupported media file/);
  });
});

describe('duration probing', () => {
  it('reads a WAV from a buffer and from a file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'two-seconds.wav');
    const wav = makeWav(2);
    await writeFile(file, wav);
    expect(await probeDurationSecs(wav, 'audio/wav')).toBe(2);
    expect(await probeDurationSecs(file, 'audio/wav')).toBe(2);
  });

  it('returns null for bytes that are not the type they claim', async () => {
    expect(await probeDurationSecs(Buffer.from('this is not audio'), 'audio/wav')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The embedded-media reader. The real prototype holds six REAL client calls,
// so the fixture here is a synthetic prototype with one invented WAV.
// ---------------------------------------------------------------------------

function fakePrototype(entries: Record<string, string>): string {
  const media = Object.entries(entries)
    .map(([file, url]) => `  ${JSON.stringify(file)}: ${JSON.stringify(url)}`)
    .join(',\n');
  return [
    '<html><body>',
    '<script>',
    'const PASS_MARK = 80;',
    `const MEDIA = {\n${media}\n};`,
    'const STAGES = [];',
    'let user = null;',
    '</script>',
    '</body></html>',
  ].join('\n');
}

describe('the prototype MEDIA object', () => {
  it('returns the file name, the type and the bytes of every entry', () => {
    const wav = makeWav(1);
    const html = fakePrototype({
      'invented_one.wav': `data:audio/wav;base64,${wav.toString('base64')}`,
      'invented_two.wav': `data:audio/wav;base64,${makeWav(3).toString('base64')}`,
    });
    const media = readEmbeddedMedia(html);
    expect(media.map((m) => m.file)).toEqual(['invented_one.wav', 'invented_two.wav']);
    expect(media[0]?.contentType).toBe('audio/wav');
    expect(media[0]?.mediaType).toBe('AUDIO');
    expect(media[0]?.bytes.equals(wav)).toBe(true);
  });

  it('refuses anything that is not a base64 data URL of a media type', () => {
    expect(() =>
      readEmbeddedMedia(fakePrototype({ 'a.wav': 'https://example.com/a.wav' })),
    ).toThrow(/not a data: URL/);
    expect(() => readEmbeddedMedia(fakePrototype({ 'a.wav': 'data:audio/wav,plain' }))).toThrow(
      /not base64-encoded/,
    );
    expect(() =>
      readEmbeddedMedia(fakePrototype({ 'a.txt': 'data:text/plain;base64,aGk=' })),
    ).toThrow(/unsupported media type/);
  });
});
