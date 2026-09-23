import { describe, expect, it } from 'vitest';
import {
  clearLessonHtmlCache,
  sanitizeLessonHtml,
} from '../../../src/modules/training/sanitize.js';

/*
 * The server sanitises lesson HTML at read time (repo.ts loadLessons), so the
 * contract's "sanitised lesson HTML" is true of every row whatever put it in
 * the table. Every body below is invented for this test: none of it is ported
 * training content.
 */

describe('sanitizeLessonHtml (server)', () => {
  it('drops a <script>, an on* handler and a javascript: URL', () => {
    clearLessonHtmlCache();
    const clean = sanitizeLessonHtml(
      '<p>Kept text.</p><script>window.pwned = 1;</script>' +
        '<button onclick="alert(1)">Press</button>' +
        '<a href="javascript:alert(2)">Link</a>',
    );
    expect(clean).toContain('Kept text.');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('window.pwned');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('Press');
    expect(clean).toContain('Link');
  });

  // Inside <svg> and <math> an element's tagName is LOWER case, which is how a
  // <style> used to walk past a case-sensitive upper-case blocklist. Arbitrary
  // CSS in the page is an exfiltration channel and a quiz overlay.
  it('drops a <style> smuggled inside <svg> or <math>', () => {
    clearLessonHtmlCache();
    const svg = sanitizeLessonHtml(
      '<p>Kept.</p><svg><style>*{background:url(https://evil.example/x)}</style></svg>',
    );
    const math = sanitizeLessonHtml(
      '<p>Kept.</p><math><style>@import url(https://evil.example/x)</style></math>',
    );
    for (const clean of [svg, math]) {
      expect(clean).toContain('Kept.');
      expect(clean.toLowerCase()).not.toContain('<style');
      expect(clean).not.toContain('evil.example');
    }
    expect(svg.toLowerCase()).not.toContain('<svg');
    expect(math.toLowerCase()).not.toContain('<math');
  });

  // A tab, newline, carriage return or \x01 inside the scheme defeats a naive
  // regex over the decoded value; browsers still resolve all four.
  it.each([
    ['tab', 'jav&#x09;ascript:alert(1)'],
    ['newline', 'jav&#x0A;ascript:alert(1)'],
    ['carriage return', 'jav&#13;ascript:alert(1)'],
    ['leading control character', '&#01;javascript:alert(1)'],
  ])('drops an entity-encoded javascript: URL (%s)', (_name, href) => {
    clearLessonHtmlCache();
    const clean = sanitizeLessonHtml(`<a href="${href}">Link</a>`);
    expect(clean).toContain('Link');
    expect(clean).not.toContain('href=');
    // eslint-disable-next-line no-control-regex
    expect(clean.toLowerCase().replace(/[\s\u0000-\u001f]/g, '')).not.toContain('javascript:');
  });

  it('keeps the shape of a lesson body and records the inline handlers', () => {
    clearLessonHtmlCache();
    const clean = sanitizeLessonHtml(
      '<div class="callout warn"><b>Heads up</b> An invented warning.</div>' +
        '<div class="doc-tabs">' +
        '<button class="on" onclick="showDemo(\'good\')">Replica A</button>' +
        '<button onclick="showDemo(\'bad\')">Replica B</button>' +
        '</div>' +
        '<div id="demoGood"><p>Panel one.</p></div>' +
        '<div id="demoBad" style="display:none"><p>Panel two.</p></div>' +
        '<input type="text" placeholder="Type to search" oninput="filterDemo(this.value)">' +
        '<table><tbody><tr><th scope="row">Row</th>' +
        '<td class="sg-item" data-k="alpha: one">Alpha</td></tr></tbody></table>',
    );

    expect(clean).toContain('class="callout warn"');
    expect(clean).toContain('<table>');
    expect(clean).toContain('scope="row"');
    expect(clean).toContain('data-k="alpha: one"');
    expect(clean).toContain('style="display:none"');
    expect(clean).toContain('placeholder="Type to search"');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('oninput');
    expect(clean).toContain('data-fa-tab-group="demo"');
    expect(clean).toContain('data-fa-tab-panel="demoGood"');
    expect(clean).toContain('data-fa-tab-panel="demoBad"');
    expect(clean).toContain('data-fa-filter="rows"');
  });

  it('drops a style="" that can fetch a URL and keeps one that cannot', () => {
    clearLessonHtmlCache();
    const clean = sanitizeLessonHtml(
      '<div style="background:url(https://evil.example/x)">A</div>' +
        '<div style="color:#b00020;padding:12px">B</div>',
    );
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('style="color:#b00020;padding:12px"');
  });

  it('returns an empty string for a missing or blank body', () => {
    clearLessonHtmlCache();
    expect(sanitizeLessonHtml('')).toBe('');
    expect(sanitizeLessonHtml('   ')).toBe('');
  });
});
