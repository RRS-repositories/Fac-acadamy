import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

// Runs one of the repo's TypeScript ops scripts as a child process.
//
// Not through `npx`: Node 22 on Windows refuses to spawn a `.cmd` shim without
// a shell (EINVAL), and putting a shell in the way would mean quoting
// arguments by hand. So this resolves tsx's own entry point and runs it with
// the Node that is already running — no shell, no PATH lookup, no quoting.

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

export function runOpsScript(scriptRelativePath: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [TSX_CLI, scriptRelativePath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
}
