import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import {
  LESSON_ALLOWED_ATTR,
  LESSON_ALLOWED_TAGS,
  LESSON_ALLOWED_URI_REGEXP,
  LESSON_FORBID_ATTR,
  LESSON_URI_SAFE_ATTR,
  applyLessonAttributeRules,
  lessonBehaviourHooks,
} from '@fac-academy/shared';

/*
 * Lesson HTML leaves the server through exactly one function — loadLessons()
 * in repo.ts — and it goes through here first.
 *
 * WHY READ TIME AND NOT SEED TIME. The contract (shared/src/contracts/
 * training.ts) promises the browser "sanitised lesson HTML". Sanitising in the
 * seed would only make that true for rows the seed happens to write: rows
 * already in the database stay dirty until someone re-seeds, and any later
 * writer — a manager-facing lesson editor, a hotfix UPDATE Brad runs by hand —
 * is a new hole. Doing it where the HTML is read makes the promise true of
 * every row however it got there, which is what a security boundary has to be.
 * The cost is one parse per lesson served; the cache below removes even that
 * for the repeat reads, because lesson bodies are static content.
 *
 * The browser sanitises again with the same allowlist (LessonBody.jsx). That is
 * deliberate: neither side trusts the other, and the shared allowlist in
 * shared/src/lessonHtml.ts means they cannot drift apart.
 */

const { window } = new JSDOM('');
const purifier = createDOMPurify(window as unknown as Window & typeof globalThis);

// Before the allowlist deletes the on* attributes, record what they did, so the
// DSAR tabs and the Status Guide search still work in the browser.
purifier.addHook('beforeSanitizeAttributes', (node) => {
  const element = node as Partial<Element>;
  if (typeof element.getAttributeNames !== 'function') return;
  for (const name of element.getAttributeNames()) {
    if (!name.toLowerCase().startsWith('on')) continue;
    const hooks = lessonBehaviourHooks(name, element.getAttribute?.(name) ?? '');
    if (hooks === null) continue;
    for (const [key, value] of Object.entries(hooks)) element.setAttribute?.(key, value);
  }
});

// After it has run: drop a style="" that can fetch, and tame target="_blank".
purifier.addHook('afterSanitizeAttributes', (node) => {
  const element = node as Partial<Element>;
  if (typeof element.getAttribute === 'function') applyLessonAttributeRules(element as Element);
});

// No <svg> and no <math> in the allowlist: their children parse in a foreign
// namespace, where an element's tagName is lower case — which is how a
// <style> element used to walk past a case-sensitive blocklist.
const PURIFY_CONFIG = {
  ALLOWED_TAGS: LESSON_ALLOWED_TAGS,
  ALLOWED_ATTR: LESSON_ALLOWED_ATTR,
  ADD_URI_SAFE_ATTR: LESSON_URI_SAFE_ATTR,
  FORBID_ATTR: LESSON_FORBID_ATTR,
  ALLOWED_URI_REGEXP: LESSON_ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
} as const;

// Lesson bodies are static and there are fewer than a hundred of them, so the
// same handful of strings is sanitised over and over. Bounded, so a surprise
// (a lesson editor, a fuzzer) cannot grow it without limit.
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

/** Sanitise one lesson body. Same allowlist, same result, as the browser's. */
export function sanitizeLessonHtml(html: string): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  const hit = cache.get(html);
  if (hit !== undefined) return hit;

  const clean = purifier.sanitize(html, PURIFY_CONFIG);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(html, clean);
  return clean;
}

/** Test-only: prove the cache is not what makes a case pass. */
export function clearLessonHtmlCache(): void {
  cache.clear();
}
