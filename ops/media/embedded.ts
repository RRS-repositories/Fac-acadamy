// Reads the audio the prototype embeds in its `const MEDIA = { ... }` object.
//
// ops/seed/prototype.ts deliberately CUTS those base64 values out before the
// prototype is evaluated, so the content seed can never touch them. S06 is the
// one place that needs the bytes themselves: it streams them into the media
// store and nowhere else. This module therefore does the same scan as
// prototype.ts's stripMedia(), but keeps each value.
//
// Data hygiene: these are six REAL client call recordings. Nothing here logs
// or returns anything but the file name, the media type and the raw bytes, and
// nothing ever writes them inside the repo. An error message names the file
// only, never any part of the data URL.

import { findDataScript } from '../seed/prototype.js';
import { MediaError } from './lib.js';
import type { MediaKind } from './lib.js';

export interface EmbeddedMedia {
  /** The MEDIA key: a technical file name, e.g. 'sales_1.mp3'. */
  file: string;
  /** The data URL's own media type, e.g. 'audio/mpeg'. */
  contentType: string;
  mediaType: MediaKind;
  bytes: Buffer;
}

/** Media types a data: URL inside the prototype may declare. */
const DATA_URL_TYPES: Readonly<Record<string, MediaKind>> = {
  'audio/mpeg': 'AUDIO',
  'audio/mp3': 'AUDIO',
  'audio/mp4': 'AUDIO',
  'audio/x-m4a': 'AUDIO',
  'audio/wav': 'AUDIO',
  'audio/x-wav': 'AUDIO',
  'audio/wave': 'AUDIO',
  'video/mp4': 'VIDEO',
};

function fail(why: string): never {
  throw new MediaError(`Prototype MEDIA object: ${why}.`);
}

/**
 * Every entry of the prototype's MEDIA object, in source order.
 * `script` is the inline <script> that declares STAGES.
 */
export function parseMediaObject(script: string): EmbeddedMedia[] {
  const start = /^const MEDIA\s*=\s*\{/m.exec(script)?.index;
  if (start === undefined) fail('could not find `const MEDIA = {`');
  let i = script.indexOf('{', start) + 1;
  const out: EmbeddedMedia[] = [];

  for (;;) {
    while (i < script.length && /[\s,]/.test(script[i]!)) i++;
    if (script[i] === '}') break;
    if (script[i] !== '"') fail('expected a quoted file name');
    const keyEnd = script.indexOf('"', i + 1);
    if (keyEnd < 0) fail('unterminated file name');
    const file = script.slice(i + 1, keyEnd);
    i = keyEnd + 1;
    while (/\s/.test(script[i] ?? '')) i++;
    if (script[i] !== ':') fail(`expected ":" after ${file}`);
    i++;
    while (/\s/.test(script[i] ?? '')) i++;
    if (script[i] !== '"') fail(`expected a quoted data URL for ${file}`);
    const valEnd = script.indexOf('"', i + 1);
    if (valEnd < 0) fail(`unterminated data URL for ${file}`);
    out.push(decodeDataUrl(file, script.slice(i + 1, valEnd)));
    i = valEnd + 1;
  }

  if (out.length === 0) fail('it is empty');
  const seen = new Set<string>();
  for (const entry of out) {
    if (seen.has(entry.file)) fail(`${entry.file} appears twice`);
    seen.add(entry.file);
  }
  return out;
}

function decodeDataUrl(file: string, url: string): EmbeddedMedia {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) fail(`${file} is not a data: URL`);
  const head = url.slice(0, comma);
  if (!/;base64$/i.test(head)) fail(`${file} is not base64-encoded`);
  const contentType = head.slice('data:'.length, head.length - ';base64'.length).toLowerCase();
  const mediaType = DATA_URL_TYPES[contentType];
  if (mediaType === undefined) fail(`${file} declares an unsupported media type`);
  const bytes = Buffer.from(url.slice(comma + 1), 'base64');
  if (bytes.byteLength === 0) fail(`${file} decodes to no bytes`);
  return { file, contentType, mediaType, bytes };
}

/** The embedded media of a whole prototype HTML file. */
export function readEmbeddedMedia(html: string): EmbeddedMedia[] {
  return parseMediaObject(findDataScript(html));
}
