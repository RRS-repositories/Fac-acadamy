import { useEffect, useMemo, useRef } from 'react';
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
 *   1. sanitizeLessonHtml() strips <script>, every on* attribute and every
 *      javascript: URL — while remembering, as data-* hooks, what the handler
 *      it removed was asking for.
 *   2. wireLessonBehaviour() attaches ONE delegated click and ONE delegated
 *      input listener to the rendered body and reproduces those two behaviours
 *      exactly. Markup it does not recognise renders inert but readable.
 *
 * Nothing here scrolls: opening a tab and filtering rows are in-place updates.
 */

// Elements that are dropped outright: none of them belong in a lesson body.
const BLOCKED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'APPLET',
  'LINK',
  'META',
  'BASE',
  'TEMPLATE',
]);

// Attributes that can carry a URL, and therefore a javascript: payload.
const URL_ATTRS = new Set([
  'href',
  'src',
  'srcset',
  'srcdoc',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'xlink:href',
  'ping',
]);

const DANGEROUS_URL = /^\s*(?:javascript|vbscript|file)\s*:/i;
// data: URLs are blocked except for images, which are inert.
const DATA_URL = /^\s*data\s*:/i;
const SAFE_DATA_URL = /^\s*data:image\/(?:png|jpe?g|gif|webp|avif);/i;

// `showDsar('good')` → tab group "dsar", panel id "dsarGood" (exactly what the
// prototype's showDsar() toggles). Any other show*(…) handler works the same.
const TAB_HANDLER = /^\s*show([A-Za-z0-9_$]+)\s*\(\s*['"]([^'"]*)['"]\s*\)\s*;?\s*$/;
// `filterStatuses(this.value)` → a search box over the rows carrying data-k.
const FILTER_HANDLER = /^\s*filter[A-Za-z0-9_$]*\s*\(/;

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isDangerousUrl(value) {
  if (DANGEROUS_URL.test(value)) return true;
  return DATA_URL.test(value) && !SAFE_DATA_URL.test(value);
}

/**
 * Record what an inline handler was about to do, as data-* attributes, before
 * the handler itself is removed. Unrecognised handlers leave no trace, so the
 * element simply does nothing once rendered.
 */
function rememberBehaviour(element, attrName, value) {
  if (attrName === 'onclick') {
    const match = TAB_HANDLER.exec(value);
    if (!match) return;
    const group = lowerFirst(match[1]);
    element.setAttribute('data-fa-tab-group', group);
    element.setAttribute('data-fa-tab-panel', group + upperFirst(match[2]));
    return;
  }
  if (attrName === 'oninput' || attrName === 'onkeyup' || attrName === 'onchange') {
    if (FILTER_HANDLER.test(value)) element.setAttribute('data-fa-filter', 'rows');
  }
}

/**
 * Strip everything executable out of server-rendered lesson HTML.
 * Defence in depth: the API sanitises too, and the server is the source of
 * truth — this is the browser refusing to run anything either way.
 */
export function sanitizeLessonHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return '';
  if (typeof DOMParser === 'undefined') return '';

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;
  if (!body) return '';

  for (const element of Array.from(body.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        rememberBehaviour(element, name, attr.value);
        element.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return body.innerHTML;
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
 * Markup that lost its handlers (or never had them, because the API sanitised
 * them away) can still be recognised by its structure: a .doc-tabs bar whose
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
