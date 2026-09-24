import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

// HTML → PDF for a certificate, with Playwright's Chromium.
//
// Why a browser at all: the certificate has to look like the app (navy
// #16324F, orange #E8713A, Outfit and Inter), and the app's look is CSS. A PDF
// library would mean drawing that layout a second time, in a second language,
// and the two would drift apart. Chromium is already installed here for the
// screenshot script, so the certificate is the same HTML and the same tokens.
//
// Three rules hold this file together:
//
//  1. **One browser, launched lazily, closed on shutdown.** Launching Chromium
//     costs the best part of a second, so the instance is shared. It is only
//     started when a certificate is actually rendered, and
//     closeCertificateRenderer() is wired into the API's SIGTERM path.
//  2. **A render never leaves anything running.** Each render gets its own
//     browser context and closes it in a `finally`; a launch that fails clears
//     the cached promise, so the next attempt tries again rather than awaiting
//     a rejected promise for ever.
//  3. **No network.** The two fonts are embedded as base64 woff2 data URIs
//     (templates/certificate/fonts), so the PDF is identical on a laptop, in
//     CI and on a server with no route to fonts.googleapis.com. The page is
//     loaded with setContent, so it cannot fetch anything either.

/** Everything printed on a certificate. Every string comes from the database. */
export interface CertificateDocument {
  /** The holder's name, frozen into the certificate row when it was issued. */
  holderName: string;
  /** What they completed, worded as the database words it. */
  title: string;
  /** The accomplishment line, or null when the row has none. */
  accomplishment: string | null;
  /** The track's label ('Customer Service'), from the shared track list. */
  trackLabel: string;
  issuedAt: Date;
  publicId: string;
  /** `<PUBLIC_BASE_URL>/verify/<publicId>` — printed on the certificate. */
  verifyUrl: string;
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/**
 * Where templates/certificate lives, whichever way the server was started.
 *
 * Under tsx the module sits in src/certs; in the tsup build everything is
 * bundled into dist/api.js. Rather than guess a depth, walk up from this
 * module until the template is found — which lands on server/ either way.
 */
function templateDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'templates', 'certificate');
    if (existsSync(join(candidate, 'certificate.html'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'certificate template not found: expected templates/certificate/certificate.html ' +
      'beside the server build',
  );
}

const FONT_FILES = [
  { family: 'Inter', file: 'inter-latin.woff2' },
  { family: 'Outfit', file: 'outfit-latin.woff2' },
] as const;

let cached: { html: string; fontFaces: string } | null = null;

/** The template and the embedded fonts, read once per process. */
async function loadTemplate(): Promise<{ html: string; fontFaces: string }> {
  if (cached !== null) return cached;
  const dir = templateDir();
  const html = await readFile(join(dir, 'certificate.html'), 'utf8');
  const faces: string[] = [];
  for (const font of FONT_FILES) {
    const bytes = await readFile(join(dir, 'fonts', font.file));
    // Both files are the variable latin subset from Google Fonts, so one
    // @font-face covers every weight the template asks for.
    faces.push(
      `@font-face {\n` +
        `  font-family: '${font.family}';\n` +
        `  font-style: normal;\n` +
        `  font-weight: 100 900;\n` +
        `  font-display: block;\n` +
        `  src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');\n` +
        `}`,
    );
  }
  cached = { html, fontFaces: faces.join('\n') };
  return cached;
}

/** Everything that goes into the page is escaped: a name is not markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** '23 September 2026', in UTC so the same row always prints the same date. */
export function formatIssuedDate(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/** The finished HTML for one certificate. Exported so a test can read it. */
export async function certificateHtml(doc: CertificateDocument): Promise<string> {
  const { html, fontFaces } = await loadTemplate();
  const accomplishment =
    doc.accomplishment === null || doc.accomplishment.trim() === ''
      ? ''
      : `<p class="accomplishment">${escapeHtml(doc.accomplishment)}</p>`;

  const values: Record<string, string> = {
    // The fonts are ours, not user input, so they go in unescaped.
    fontFaces,
    accomplishmentBlock: accomplishment,
    holderName: escapeHtml(doc.holderName),
    title: escapeHtml(doc.title),
    trackLabel: escapeHtml(doc.trackLabel),
    issuedDate: escapeHtml(formatIssuedDate(doc.issuedAt)),
    publicId: escapeHtml(doc.publicId),
    verifyUrl: escapeHtml(doc.verifyUrl),
  };

  // A replacer function, not a string: a replacement containing '$&' must not
  // be re-interpreted by String.replace.
  return html.replace(/\{\{(\w+)\}\}/g, (whole, token: string) => values[token] ?? whole);
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function sharedBrowser(): Promise<Browser> {
  const existing = browserPromise;
  if (existing !== null) {
    const browser = await existing;
    if (browser.isConnected()) return browser;
    // Chromium died (OOM killer, a crash). Drop it and start a new one.
    browserPromise = null;
  }
  const started = chromium.launch({ args: ['--font-render-hinting=none'] });
  browserPromise = started;
  try {
    return await started;
  } catch (err) {
    // Never leave a rejected promise cached: the next certificate would fail
    // with the same stale error for the life of the process.
    if (browserPromise === started) browserPromise = null;
    throw err;
  }
}

/**
 * Close the shared Chromium. Called from the API's shutdown path and from the
 * tests' afterAll. Safe to call when nothing was ever launched.
 */
export async function closeCertificateRenderer(): Promise<void> {
  const started = browserPromise;
  browserPromise = null;
  if (started === null) return;
  try {
    const browser = await started;
    await browser.close();
  } catch {
    // A browser that never started, or already went away, needs no closing.
  }
}

/** True when a Chromium is running for certificates. Tests assert on it. */
export function rendererIsRunning(): boolean {
  return browserPromise !== null;
}

/** How long one render may take before we give up and free the context. */
export const RENDER_TIMEOUT_MS = 30_000;

/** Render one certificate to PDF bytes. A4 landscape, backgrounds printed. */
export async function renderCertificatePdf(doc: CertificateDocument): Promise<Buffer> {
  const html = await certificateHtml(doc);
  const browser = await sharedBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    // 'load' is enough and cannot hang on a network idle that never comes:
    // the page has no external references at all.
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    // The embedded fonts are font-display: block, so wait for them rather than
    // printing a page in the fallback face. Passed as a string, not a closure:
    // the code runs in the browser, and the server's TypeScript has no DOM
    // library (nor should it).
    await page.evaluate('document.fonts.ready');
    return await page.pdf({
      // The template sets @page { size: A4 landscape }, so let the CSS decide
      // and keep one source of truth for the paper size.
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    // Always, on every path: a leaked context holds a renderer process open.
    await context.close();
  }
}
