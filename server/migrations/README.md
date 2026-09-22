# Migrations

Plain SQL files, applied in name order by `server/src/db/migrate.ts`.

| File | What it does |
|---|---|
| `0000_extensions.sql` | `CREATE EXTENSION IF NOT EXISTS citext` (fixes X1). Needs a superuser or a role with CREATE on the database. |
| `0001_academy_schema.sql` | The supplied `fac-academy-schema.sql`, **byte-for-byte**. Never edited, ever. |
| `0002_academy_v2_alignment.sql` | Fixes forward on top of 0001 (defects X2–X11 in the project plan §4b): 9 tracks, departments, stage codes, new tables, rewritten views, grants for `academy_app`. |

## Rules

- **Brad applies production migrations.** Nobody else runs them against production. We write them; he runs them.
- **Never edit a migration once it has been applied anywhere.** Fix forward in a new file with the next number. The runner stores each file's sha256 in the ledger and refuses to run if an applied file has changed. A unit test also pins 0001's hash.
- Files are named `NNNN_short_name.sql` (four digits, lowercase). Two files with the same number are an error. A new file must sort after every applied one.
- No seed content in migrations, apart from small lookup tables (tracks, departments). Training content comes from the S02 seed.
- A migration that creates a table also grants `academy_app` what it needs on it (see the grant block at the end of 0002). Append-only tables never get UPDATE or DELETE.

## Running

Migrations run as an owner/admin login, not as `academy_app`. Set `MIGRATE_DB_USER` and `MIGRATE_DB_PASSWORD`; they override `DB_USER` / `DB_PASSWORD` for the runner only. The other settings come from `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SSL` (in `.env` or the environment).

Dry run (the default; writes nothing, not even the ledger):

```sh
npm run migrate -w @fac-academy/server
```

It prints the database name, the login, the server version, how many files are applied and which are pending.

Apply:

```sh
npm run migrate -w @fac-academy/server -- --commit --expect-db <database name> [--note "why"]
```

`--commit` refuses to run without `--expect-db`, and stops before touching anything if the name does not match `current_database()`. This is the wrong-database guard (the CRM ran a migration against the wrong database on 14 Sep 2026).

Each pending file runs in its own transaction with `search_path = academy, public`, then gets a ledger row. On an error the file is rolled back, the runner prints the file, the Postgres error and its line, lists the files it did not run, and exits 1. Migrations run with no statement timeout. An advisory lock stops two runs overlapping.

## The ledger

`academy.schema_migrations` (created by the first `--commit` run):

| Column | Meaning |
|---|---|
| `filename` | primary key |
| `sha256` | hash of the file as applied (CRLF normalised to LF) |
| `applied_at` | when |
| `applied_by` | `current_user` of the migration login |
| `note` | the `--note` text, if any |

`academy_app` can read the ledger but not change it.

## Tests

- `server/test/db/migrate-helpers.test.ts`: argument parsing, file ordering, hashes. No database.
- `server/test/db/migrations.test.ts`: runs only when `MIGRATION_TEST_DB_NAME` is set. It **drops the `academy` schema in that database** and migrates it from scratch, so point it only at a throw-away database (`academy_ci` in CI, `academy_test` locally).
