#!/usr/bin/env node
// Fails if any tracked, staged or new (not ignored) file breaks the data-hygiene
// rules: media, the prototype, .env files, data exports, huge files, or anything
// in client/public that is not an image, font, favicon or robots.txt.
// Usage: npm run check:files   (no dependencies; runs in CI and locally)

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 5 * MB;
const MAX_HTML_BYTES = 1 * MB;

const MEDIA_EXT = new Set(['.mp3', '.mp4', '.wav', '.m4a', '.mov', '.webm']);
const EXPORT_EXT = new Set(['.xlsx', '.xls', '.csv', '.dump']);
const PUBLIC_ALLOWED_EXT = new Set([
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.ico',
  // fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * MB });
}

function listFiles(root) {
  // -z keeps unusual file names intact. --cached = tracked + staged;
  // --others --exclude-standard = new files git would pick up on `git add .`.
  const out = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  return [...new Set(out.split('\0').filter(Boolean))];
}

function sizeOf(root, file) {
  try {
    return statSync(path.join(root, file)).size;
  } catch {
    return null; // tracked but deleted in the working tree: nothing on disk to check
  }
}

function problemsFor(root, file) {
  const problems = [];
  const base = path.posix.basename(file);
  const lowerBase = base.toLowerCase();
  const ext = path.posix.extname(lowerBase);
  const size = sizeOf(root, file);

  if (MEDIA_EXT.has(ext)) {
    problems.push('media file: media goes to S3 only, never into the repo');
  }
  if (base.includes('FAC-Academy-Portal')) {
    problems.push('looks like the prototype: it embeds real client recordings and staff details');
  } else if (ext === '.html' && size !== null && size > MAX_HTML_BYTES) {
    problems.push(`HTML file over 1 MB (${(size / MB).toFixed(1)} MB): possibly the prototype`);
  }
  if ((lowerBase === '.env' || lowerBase.startsWith('.env.')) && lowerBase !== '.env.example') {
    problems.push('.env file: secrets live only in an untracked .env (commit .env.example only)');
  }
  if (EXPORT_EXT.has(ext)) {
    problems.push('spreadsheet or data export: these must not be committed');
  }
  if (size !== null && size > MAX_FILE_BYTES) {
    problems.push(`file over 5 MB (${(size / MB).toFixed(1)} MB)`);
  }
  if (file.startsWith('client/public/')) {
    const allowed =
      PUBLIC_ALLOWED_EXT.has(ext) || lowerBase.startsWith('favicon') || lowerBase === 'robots.txt';
    if (!allowed) {
      problems.push('client/public holds images, fonts, favicon and robots.txt only');
    }
  }
  return problems;
}

function main() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  } catch {
    console.error('check-forbidden-files: not inside a git repository.');
    process.exit(1);
  }

  const files = listFiles(root);
  let failures = 0;
  for (const file of files) {
    for (const problem of problemsFor(root, file)) {
      console.error(`FORBIDDEN  ${file}  ->  ${problem}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(
      `\ncheck-forbidden-files: ${failures} problem(s). Remove these files from git ` +
        '(git rm --cached <file>) and see docs/PROJECT-PLAN.md section 4.',
    );
    process.exit(1);
  }
  console.log(`check-forbidden-files: OK (${files.length} files checked)`);
}

main();
