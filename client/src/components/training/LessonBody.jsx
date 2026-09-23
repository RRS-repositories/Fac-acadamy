import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import {
  LESSON_ALLOWED_ATTR,
  LESSON_ALLOWED_TAGS,
  LESSON_ALLOWED_URI_REGEXP,
  LESSON_FORBID_ATTR,
  LESSON_URI_SAFE_ATTR,
  applyLessonAttributeRules,
  lessonBehaviourHooks,
} from '@fac-academy/shared';
import './lesson-body.css';

/*
 * The lesson body is HTML written by the API, never by this bundle. Two of the
 * ported lessons are interactive: the DSAR practice-documents lesson has
 * good/bad replica tabs, and the Status Guide lesson has a search box over a
 * list of rows. In the prototype both ran from inline handlers
 * (onclick="showDsar('good')", oninput="filterStatuses(this.value)").
 *
 * dangerouslySetInnerHTML never runs inline handlers, and we would not want it
 * to, so this module does two things:
 *   1. sanitizeLessonHtml() runs the body through DOMPurify against the
 *      allowlist in shared/src/lessonHtml.ts — while remembering, as data-*
 *      hooks, what the handler it removed was asking for.
 *   2. wireLessonBehaviour() attaches ONE delegated click and ONE delegated
 *      input listener to the rendered body and reproduces those two behaviours
 *      exactly. Markup it does not recognise renders inert but readable.
 *
 * Nothing here scrolls: opening a tab and filtering rows are in-place updates.
 *
 * Why DOMPurify and not a hand-rolled pass: the hand-rolled one compared
 * `element.tagName` against an upper-case blocklist, and inside <svg> or <math>
 * an element's tagName is LOWER case, so `<svg><style>…</style></svg>` walked
 * straight through with arbitrary CSS attached. It also tested the decoded
 * attribute value for `javascript:`, which `jav&#x09;ascript:` is not — but the
 * browser still resolves it as one. DOMPurify gets both right, is namespace
 * aware, and is maintained against the mXSS bypasses nobody here will track.
 */

const purifier = typeof window === 'undefined' ? null : DOMPurify(window);

// The two hooks below are registered once, on our own DOMPurify instance, so
// nothing else on the page is affected by them.
if (purifier !== null) {
  // Before the allowlist deletes the on* attributes, record what they did.
  purifier.addHook('beforeSanitizeAttributes', (node) => {
    if (typeof node.getAttributeNames !== 'function') return;
    for (const name of node.getAttributeNames()) {
      if (!name.toLowerCase().startsWith('on')) continue;
      const hooks = lessonBehaviourHooks(name, node.getAttribute(name) ?? '');
      if (hooks === null) continue;
      for (const [key, value] of Object.entries(hooks)) node.setAttribute(key, value);
    }
  });
  // After it has run: drop a style="" that can fetch, and tame target="_blank".
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (typeof node.getAttribute === 'function') applyLessonAttributeRules(node);
  });
}

// The allowlist deliberately holds no <svg> and no <math>: their children parse
// in a foreign namespace, which is precisely the hole the old blocklist had.
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
  RETURN_TRUSTED_TYPE: false,
};

/**
 * Strip everything executable out of server-rendered lesson HTML.
 * Defence in depth: the API sanitises the same way, with the same allowlist,
 * before it ever serves the row (server/src/modules/training/sanitize.ts) —
 * this is the browser refusing to run anything either way.
 */
export function sanitizeLessonHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return '';
  if (purifier === null) return '';
  return purifier.sanitize(html, PURIFY_CONFIG);
}

/** Every tab button in the body, grouped by data-fa-tab-group. */
function tabGroups(root) {
  const groups = new Map();
  for (const tab of root.querySelectorAll('[data-fa-tab-panel]')) {
    const name = tab.getAttribute('data-fa-tab-group') ?? '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(tab);
  }
  return groups;
}

/** The panel a tab shows, looked up inside the lesson body only. */
function panelFor(root, tab) {
  const id = tab.getAttribute('data-fa-tab-panel');
  if (!id) return null;
  for (const candidate of root.querySelectorAll('[id]')) {
    if (candidate.id === id) return candidate;
  }
  return null;
}

/**
 * Show this tab's panel and hide its siblings' — the same two lines the
 * prototype's showDsar() ran (style.display + the 'on' class on the button).
 */
function activateTab(root, tab) {
  const group = tabGroups(root).get(tab.getAttribute('data-fa-tab-group') ?? '') ?? [tab];
  for (const other of group) {
    const on = other === tab;
    other.classList.toggle('on', on);
    other.setAttribute('aria-pressed', on ? 'true' : 'false');
    const panel = panelFor(root, other);
    if (panel) panel.style.display = on ? '' : 'none';
  }
}

/** The prototype's filterStatuses(): show rows whose data-k contains the query. */
function filterRows(root, value) {
  const query = (value || '').toLowerCase();
  for (const row of root.querySelectorAll('[data-k]')) {
    const key = row.getAttribute('data-k') || '';
    row.style.display = !query || key.includes(query) ? '' : 'none';
  }
}

/**
 * Markup that lost its handlers without leaving a data-fa-* hook behind can
 * still be recognised by its structure: a .doc-tabs bar whose
 * buttons line up with the panels that follow it, and a text box sitting above
 * rows that carry data-k.
 */
function addFallbackHooks(root) {
  if (!root.querySelector('[data-fa-tab-panel]')) {
    const bars = Array.from(root.querySelectorAll('.doc-tabs'));
    bars.forEach((bar, barIndex) => {
      const tabs = Array.from(bar.querySelectorAll('button'));
      if (tabs.length === 0) return;
      const panels = [];
      for (let sib = bar.nextElementSibling; sib && panels.length < tabs.length;) {
        if (sib.id) panels.push(sib);
        sib = sib.nextElementSibling;
      }
      if (panels.length !== tabs.length) return;
      tabs.forEach((tab, i) => {
        tab.setAttribute('data-fa-tab-group', `tabs-${barIndex}`);
        tab.setAttribute('data-fa-tab-panel', panels[i].id);
      });
    });
  }

  if (!root.querySelector('[data-fa-filter]') && root.querySelector('[data-k]')) {
    const box = root.querySelector('input[type="search"], input[type="text"], input:not([type])');
    if (box) box.setAttribute('data-fa-filter', 'rows');
  }
}

/** Start each tab group on the tab the markup marked as open, else the first. */
function initTabGroups(root) {
  for (const tabs of tabGroups(root).values()) {
    if (!tabs.some((tab) => tab.classList.contains('on'))) activateTab(root, tabs[0]);
  }
}

/**
 * Attach the lesson behaviours to a rendered body. Returns a cleanup function.
 * Exported for the tests; components use <LessonBody>.
 */
export function wireLessonBehaviour(root) {
  if (!root) return () => {};
  addFallbackHooks(root);
  initTabGroups(root);

  const onClick = (event) => {
    const tab = event.target?.closest?.('[data-fa-tab-panel]');
    if (tab && root.contains(tab)) activateTab(root, tab);
  };
  const onInput = (event) => {
    const box = event.target?.closest?.('[data-fa-filter]');
    if (box && root.contains(box)) filterRows(root, box.value);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
  };
}

/** Renders one lesson's server-supplied HTML, sanitised and wired up. */
export default function LessonBody({ html }) {
  const ref = useRef(null);
  const clean = useMemo(() => sanitizeLessonHtml(html), [html]);

  useEffect(() => wireLessonBehaviour(ref.current), [clean]);

  return <div ref={ref} className="lesson-body" dangerouslySetInnerHTML={{ __html: clean }} />;
}
