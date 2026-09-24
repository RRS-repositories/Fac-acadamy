// Compares two lesson HTML bodies for the S02 spot-check (CHECKLIST 02: "render HTML identical
// to prototype, allow attribute-order noise only"). Returns a verdict and, on a difference, the
// first differing offset. It never returns or prints the content itself.

export type HtmlVerdict = 'IDENTICAL' | 'IDENTICAL_NORMALISED' | 'DIFF';

export interface HtmlComparison {
  verdict: HtmlVerdict;
  /** Byte lengths (UTF-16 code units) of the raw inputs. */
  lengths: [number, number];
  /** First offset where the raw strings differ, or null if they are equal. */
  rawOffset: number | null;
  /** First offset where the normalised strings differ, or null if they are equal. */
  normalisedOffset: number | null;
}

const TAG =
  /<([A-Za-z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function normaliseAttrs(raw: string): string {
  const attrs: string[] = [];
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? '').toLowerCase();
    let value = m[2];
    if (value === undefined) {
      attrs.push(name);
      continue;
    }
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    attrs.push(`${name}="${value.replace(/\s+/g, ' ').trim()}"`);
  }
  attrs.sort();
  return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
}

/**
 * Normalises HTML so that only meaningful differences remain: tag names lower-cased, attributes
 * sorted and double-quoted, whitespace runs collapsed, whitespace between tags removed.
 */
export function normaliseHtml(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(
      TAG,
      (_m, name: string, attrs: string, selfClose: string) =>
        `<${name.toLowerCase()}${normaliseAttrs(attrs)}${selfClose ? ' /' : ''}>`,
    )
    .replace(/<\/([A-Za-z][\w:-]*)\s*>/g, (_m, name: string) => `</${name.toLowerCase()}>`)
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

/** First index where a and b differ, or null when they are equal. */
export function firstDiffOffset(a: string, b: string): number | null {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return n;
}

/** Exact comparison first; falls back to the normalised comparison only if that fails. */
export function compareLessonHtml(dbHtml: string, protoHtml: string): HtmlComparison {
  const rawOffset = firstDiffOffset(dbHtml, protoHtml);
  const lengths: [number, number] = [dbHtml.length, protoHtml.length];
  if (rawOffset === null) {
    return { verdict: 'IDENTICAL', lengths, rawOffset, normalisedOffset: null };
  }
  const normalisedOffset = firstDiffOffset(normaliseHtml(dbHtml), normaliseHtml(protoHtml));
  return {
    verdict: normalisedOffset === null ? 'IDENTICAL_NORMALISED' : 'DIFF',
    lengths,
    rawOffset,
    normalisedOffset,
  };
}
