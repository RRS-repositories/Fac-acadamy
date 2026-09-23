// The storage seam (S06, decision D15: media lives on the server's own disk).
//
// Two things are tested here, and both matter more than they look:
//   * assertSafeKey — the one place that decides whether a key may touch the
//     filesystem at all. Every traversal trick goes through it.
//   * createLocalMediaStore — that a file written through put() comes back out
//     byte for byte, that the write is atomic, that the checksum is the
//     checksum of what landed, and that a range read is exactly the bytes
//     asked for.
//
// Every byte in this file is invented. Nothing here comes from a real call.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MediaKeyError,
  assertSafeKey,
  contentTypeForKey,
  createLocalMediaStore,
} from '../../../src/media/store.js';
import type { MediaStore } from '../../../src/media/store.js';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('assertSafeKey', () => {
  it('accepts the shapes the seed and the upload script write', () => {
    for (const key of [
      'academy/media/fixture.mp3',
      'academy/media/CS_2_UTL.mp3', // the prototype's own naming, upper case
      'academy/media/video1437476061.mp4',
      'academy/media/sale_3_.mp3',
      'academy/media/a-b.c/d.mp4',
      'single.mp3',
    ]) {
      expect(() => assertSafeKey(key), key).not.toThrow();
    }
  });

  it('refuses every way out of the media folder', () => {
    for (const key of [
      '../etc/passwd',
      'academy/../../etc/passwd',
      'academy/media/../../../etc/passwd',
      'academy/media/..',
      '..',
      'academy/..%2f..%2fetc', // percent-encoding is not decoded here, and '%' is not allowed
    ]) {
      expect(() => assertSafeKey(key), key).toThrow(MediaKeyError);
    }
  });

  it('refuses absolute paths, drive letters and backslashes', () => {
    for (const key of [
      '/etc/passwd',
      '/academy/media/x.mp3',
      'C:/academy/media/x.mp3',
      'C:\\academy\\media\\x.mp3',
      'academy\\media\\x.mp3',
      '\\\\server\\share\\x.mp3',
    ]) {
      expect(() => assertSafeKey(key), key).toThrow(MediaKeyError);
    }
  });

  it('refuses empty, trailing-slash and empty-segment keys', () => {
    for (const key of ['', '/', 'academy/media/', 'academy//media/x.mp3', './x.mp3', 'a/./b.mp3']) {
      expect(() => assertSafeKey(key), key).toThrow(MediaKeyError);
    }
  });

  it('refuses Unicode look-alikes, control characters and whitespace', () => {
    for (const key of [
      'academy/media/\uFF0E\uFF0E/x.mp3', // full-width dots
      'academy/media/\u2024\u2024/x.mp3', // one-dot leaders
      'academy/media/x\u0000.mp3', // NUL
      'academy/media/x\n.mp3',
      'academy/media/x y.mp3',
      'academy/media/\u202Eslidemp3.exe', // right-to-left override
      'académy/media/x.mp3',
      'academy/media/x.mp3?range=0-1',
      'academy/media/x.mp3#fragment',
    ]) {
      expect(() => assertSafeKey(key), key).toThrow(MediaKeyError);
    }
  });

  it('refuses a key longer than the column allows', () => {
    expect(() => assertSafeKey(`academy/media/${'a'.repeat(600)}.mp3`)).toThrow(MediaKeyError);
  });

  it('never repeats the key in the message, so a log line stays clean', () => {
    try {
      assertSafeKey('../../etc/passwd');
      throw new Error('expected a MediaKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MediaKeyError);
      expect((err as Error).message).not.toContain('etc/passwd');
      expect((err as MediaKeyError).key).toBe('../../etc/passwd');
    }
  });
});

describe('contentTypeForKey', () => {
  it('names what it knows and refuses to guess at the rest', () => {
    expect(contentTypeForKey('academy/media/x.mp3')).toBe('audio/mpeg');
    expect(contentTypeForKey('academy/media/x.MP4')).toBe('video/mp4');
    expect(contentTypeForKey('academy/media/x.bin')).toBe('application/octet-stream');
    expect(contentTypeForKey('academy/media/x')).toBe('application/octet-stream');
  });
});

describe('createLocalMediaStore', () => {
  let root: string;
  let store: MediaStore;

  // 40 KB of invented bytes, big enough to cross several stream chunks.
  const payload = randomBytes(40 * 1024);
  const key = 'academy/media/fixture-store.mp3';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'academy-media-'));
    store = createLocalMediaStore(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes, stats and reads a file back byte for byte', async () => {
    const written = await store.put(key, payload, { contentType: 'audio/mpeg' });
    expect(written.key).toBe(key);
    expect(written.size).toBe(payload.length);
    expect(written.contentType).toBe('audio/mpeg');
    expect(written.sha256).toBe(sha256(payload));

    const info = await store.stat(key);
    expect(info?.size).toBe(payload.length);
    expect(info?.contentType).toBe('audio/mpeg'); // from the .mp3 extension
    expect(info?.mtime).toBeInstanceOf(Date);

    const back = await collect(await store.openRange(key));
    expect(back.equals(payload)).toBe(true);
    expect(await readFile(resolve(root, key))).toStrictEqual(payload);
  });

  it('takes a stream as happily as a buffer, and checksums what landed', async () => {
    const streamed = 'academy/media/fixture-stream.mp3';
    const written = await store.put(streamed, Readable.from([payload]), {
      contentType: 'audio/mpeg',
    });
    expect(written.sha256).toBe(sha256(payload));
    expect(written.size).toBe(payload.length);
    expect((await collect(await store.openRange(streamed))).equals(payload)).toBe(true);
    await store.delete(streamed);
  });

  it('leaves no .part file behind, so a reader never sees a half-written file', async () => {
    const files = await readdir(resolve(root, 'academy/media'));
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(files).toContain('fixture-store.mp3');
  });

  it('cleans up the temporary file when the source fails mid-write', async () => {
    const failing = Readable.from(
      (function* () {
        yield Buffer.from('some bytes');
        throw new Error('the source gave up');
      })(),
    );
    await expect(
      store.put('academy/media/never.mp3', failing, { contentType: 'audio/mpeg' }),
    ).rejects.toThrow('the source gave up');
    expect(await store.stat('academy/media/never.mp3')).toBeNull();
    const files = await readdir(resolve(root, 'academy/media'));
    expect(files.filter((f) => f.startsWith('never.mp3'))).toEqual([]);
  });

  it('reads an exact byte range, both ends included', async () => {
    const part = await collect(await store.openRange(key, { start: 10, end: 19 }));
    expect(part).toHaveLength(10);
    expect(part.equals(payload.subarray(10, 20))).toBe(true);

    const first = await collect(await store.openRange(key, { start: 0, end: 0 }));
    expect(first).toStrictEqual(payload.subarray(0, 1));

    const last = await collect(
      await store.openRange(key, { start: payload.length - 1, end: payload.length - 1 }),
    );
    expect(last).toStrictEqual(payload.subarray(payload.length - 1));
  });

  it('gives back only what exists when the range runs past the end', async () => {
    const overshoot = await collect(
      await store.openRange(key, { start: payload.length - 5, end: payload.length + 5_000 }),
    );
    expect(overshoot).toStrictEqual(payload.subarray(payload.length - 5));

    const beyond = await collect(
      await store.openRange(key, { start: payload.length + 10, end: payload.length + 20 }),
    );
    expect(beyond).toHaveLength(0);
  });

  it('refuses a nonsense range before it opens anything', async () => {
    await expect(store.openRange(key, { start: 20, end: 10 })).rejects.toThrow(RangeError);
    await expect(store.openRange(key, { start: -1, end: 10 })).rejects.toThrow(RangeError);
    await expect(store.openRange(key, { start: 0.5, end: 10 })).rejects.toThrow(RangeError);
  });

  it('answers null for a key with nothing behind it, and for a folder', async () => {
    expect(await store.stat('academy/media/nothing-here.mp3')).toBeNull();
    expect(await store.stat('academy/media')).toBeNull();
  });

  it('deletes, and deleting twice is not an error', async () => {
    const doomed = 'academy/media/fixture-doomed.mp3';
    await store.put(doomed, Buffer.from('bytes'), { contentType: 'audio/mpeg' });
    expect(await store.stat(doomed)).not.toBeNull();
    await store.delete(doomed);
    expect(await store.stat(doomed)).toBeNull();
    await expect(store.delete(doomed)).resolves.toBeUndefined();
  });

  it('refuses an unsafe key on every method, before touching the disk', async () => {
    // A file planted next to the media root: proof that a traversal key would
    // have found something had the check not stopped it.
    const outside = join(root, '..', `academy-media-secret-${randomBytes(3).toString('hex')}.txt`);
    await writeFile(outside, 'not for the academy');
    try {
      const escape = `../${outside.split(/[\\/]/).at(-1)!}`;
      await expect(store.stat(escape)).rejects.toThrow(MediaKeyError);
      await expect(store.openRange(escape)).rejects.toThrow(MediaKeyError);
      await expect(store.delete(escape)).rejects.toThrow(MediaKeyError);
      await expect(
        store.put(escape, Buffer.from('x'), { contentType: 'text/plain' }),
      ).rejects.toThrow(MediaKeyError);
      // Still there: nothing above reached it.
      expect(await readFile(outside, 'utf8')).toBe('not for the academy');
    } finally {
      await rm(outside, { force: true });
    }
  });
});
