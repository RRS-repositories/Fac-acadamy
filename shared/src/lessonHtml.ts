// The lesson-HTML allowlist, shared by both sanitising passes: the server one
// in server/src/modules/training/sanitize.ts (jsdom + DOMPurify, at read time)
// and the browser one in client/src/components/training/LessonBody.jsx
// (DOMPurify against the real DOM). One list, so the two can never drift.
//
// This file holds SHAPES only — tag, attribute and CSS-property names. It is
// safe in the browser bundle: no lesson text, no answers, no secrets.
//
// The tag and attribute sets were taken from the seeded lessons themselves:
// every element and attribute the ported content actually uses is here, plus a
// small margin of ordinary prose markup. Notably absent, and deliberately so:
//   * <svg> and <math>, whose children parse in a foreign namespace — that is
//     exactly how a <style> element used to slip past the old hand-rolled
//     blocklist (its tagName is lower-case inside those subtrees);
//   * <style>, <link> and <base>, i.e. anything that can restyle the page
//     around the lesson (a full-page overlay over a quiz) or retarget links;
//   * <script>, <iframe>, <object>, <embed>, <form> and <template>.

/** Elements a lesson body may contain. Everything else is dropped. */
export const LESSON_ALLOWED_TAGS: string[] = [
  // Block and prose
  'p',
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'hr',
  'br',
  // Inline emphasis
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'mark',
  'abbr',
  'a',
  // Lists
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  // Tables
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  // Figures and images
  'figure',
  'figcaption',
  'img',
  // The two interactive lessons (DSAR replica tabs, Status Guide search)
  'button',
  'input',
  'label',
];

/**
 * Attributes a lesson body may keep. `data-k` is the Status Guide row key, and
 * the `data-fa-*` trio is what the sanitiser writes in place of the prototype's
 * inline handlers so wireLessonBehaviour() can pick the behaviour back up.
 */
export const LESSON_ALLOWED_ATTR: string[] = [
  'class',
  'id',
  'style',
  'title',
  'lang',
  'dir',
  'href',
  'target',
  'rel',
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'type',
  'placeholder',
  'value',
  'readonly',
  'disabled',
  'colspan',
  'rowspan',
  'scope',
  'headers',
  'span',
  'start',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-pressed',
  'data-k',
  'data-fa-tab-group',
  'data-fa-tab-panel',
  'data-fa-filter',
];

/** The only allowed attributes whose value is a URL. */
export const LESSON_URL_ATTR: string[] = ['href', 'src'];

/**
 * Every other allowed attribute. DOMPurify runs its URL test over any attribute
 * it does not know to be URI-safe, which would quietly delete a `data-k` search
 * key or an `aria-label` that happens to contain a colon. Deriving the list
 * from LESSON_ALLOWED_ATTR keeps the two in step for good.
 */
export const LESSON_URI_SAFE_ATTR: string[] = LESSON_ALLOWED_ATTR.filter(
  (name) => !LESSON_URL_ATTR.includes(name),
);

/**
 * Attributes that are never kept even if some tag would otherwise allow them:
 * each one is a URL sink that has no business in a lesson.
 */
export const LESSON_FORBID_ATTR: string[] = [
  'srcset',
  'srcdoc',
  'action',
  'formaction',
  'ping',
  'background',
  'poster',
  'data',
  'xlink:href',
  'xml:base',
];

/**
 * The only URL schemes a lesson may link to or load. Anything else — including
 * `javascript:` however it is spelt, `vbscript:`, `file:` and non-image data:
 * URLs — fails the test and the attribute is dropped.
 *
 * DOMPurify strips [\t\n\r\x00-\x20] out of the value before matching, which is
 * what the old hand-rolled regex forgot: `jav&#x09;ascript:` decodes to a value
 * a browser still resolves as `javascript:`.
 */
export const LESSON_ALLOWED_URI_REGEXP =
  /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp|avif);|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

/**
 * A style="" value is dropped whole if it matches. Inline CSS is kept (the
 * lessons use colour, padding, borders and one display:none), but anything that
 * can fetch a URL, import a stylesheet or evaluate an expression is not styling.
 */
export const LESSON_UNSAFE_STYLE =
  /(?:url|image-set|-moz-binding|expression|element|attr)\s*\(|@import|javascript\s*:|<\/?\w/i;

/** True when this style="" value is safe to keep. */
export function isSafeLessonStyle(value: string): boolean {
  return !LESSON_UNSAFE_STYLE.test(value);
}

// ---------------------------------------------------------------------------
// The prototype's two inline handlers, translated into data-* hooks
// ---------------------------------------------------------------------------
//
// `showDsar('good')` → tab group "dsar", panel id "dsarGood" (exactly what the
// prototype's showDsar() toggles). Any other show*(…) handler works the same.
const TAB_HANDLER = /^\s*show([A-Za-z0-9_$]+)\s*\(\s*['"]([^'"]*)['"]\s*\)\s*;?\s*$/;
// `filterStatuses(this.value)` → a search box over the rows carrying data-k.
const FILTER_HANDLER = /^\s*filter[A-Za-z0-9_$]*\s*\(/;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What an inline handler was about to do, as data-* attributes, so the
 * behaviour survives the handler being removed. Returns null for a handler
 * neither side recognises — that element simply renders inert.
 *
 * Both sanitisers call this BEFORE dropping the on* attribute, so a lesson
 * keeps its tabs and its search box whether the server stripped the handler
 * first or the browser did.
 */
export function lessonBehaviourHooks(
  attrName: string,
  value: string,
): Record<string, string> | null {
  const name = attrName.toLowerCase();
  if (name === 'onclick') {
    const match = TAB_HANDLER.exec(value);
    if (match === null) return null;
    const group = lowerFirst(match[1] ?? '');
    return {
      'data-fa-tab-group': group,
      'data-fa-tab-panel': group + upperFirst(match[2] ?? ''),
    };
  }
  if (name === 'oninput' || name === 'onkeyup' || name === 'onchange') {
    if (FILTER_HANDLER.test(value)) return { 'data-fa-filter': 'rows' };
  }
  return null;
}

/** The slice of Element both sanitisers need. Keeps shared/ free of lib.dom. */
export interface LessonElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * The last word on an element's attributes, run after the allowlist has done
 * its work: drop a style="" that can fetch or import, and make any link that
 * opens a new tab give it no handle back on this one.
 */
export function applyLessonAttributeRules(element: LessonElement): void {
  const style = element.getAttribute('style');
  if (style !== null && !isSafeLessonStyle(style)) element.removeAttribute('style');
  if (element.getAttribute('target') !== null) {
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'noopener noreferrer');
  }
}
