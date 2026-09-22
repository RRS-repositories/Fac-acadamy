#!/usr/bin/env node
// Runs setup-local-db.sql against the LOCAL Postgres, taking the academy
// passwords from the repo-root .env. psql asks for the superuser password
// itself, so it never passes through this script. Local development only.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const envFile = resolve(root, '.env');

if (!existsSync(envFile)) {
  console.error('No .env at the repo root. Copy .env.example to .env and fill it in first.');
  process.exit(1);
}
process.loadEnvFile(envFile);

const { DB_HOST = 'localhost', DB_PORT = '5432', DB_PASSWORD, MIGRATE_DB_PASSWORD } = process.env;
const missing = [
  ['DB_PASSWORD', DB_PASSWORD],
  ['MIGRATE_DB_PASSWORD', MIGRATE_DB_PASSWORD],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Set ${missing.join(' and ')} in .env first.`);
  process.exit(1);
}
if (!['localhost', '127.0.0.1', '::1'].includes(DB_HOST)) {
  console.error(`Refusing: DB_HOST is "${DB_HOST}". This script is for a local Postgres only.`);
  process.exit(1);
}

const windowsPsql = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const psql = process.env.PSQL ?? (existsSync(windowsPsql) ? windowsPsql : 'psql');
const superuser = process.env.PG_SUPERUSER ?? 'postgres';

const result = spawnSync(
  psql,
  [
    '-h',
    DB_HOST,
    '-p',
    DB_PORT,
    '-U',
    superuser,
    '-d',
    'postgres',
    '-v',
    `owner_password=${MIGRATE_DB_PASSWORD}`,
    '-v',
    `app_password=${DB_PASSWORD}`,
    '-f',
    resolve(here, 'setup-local-db.sql'),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
