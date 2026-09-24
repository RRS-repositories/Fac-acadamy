# Migrations

Plain SQL files, applied in name order by `server/src/db/migrate.ts`.

## The eight files, in the order they run

| # | File | What it does |
|---|---|---|
| 0000 | `0000_extensions.sql` | `CREATE EXTENSION IF NOT EXISTS citext` (fixes X1). **Needs elevated rights** — see below. |
| 0001 | `0001_academy_schema.sql` | The supplied `fac-academy-schema.sql`, **byte-for-byte**. Never edited, ever. |
| 0002 | `0002_academy_v2_alignment.sql` | Fixes forward on top of 0001 (defects X2–X11, project plan §4b): 9 tracks, departments, stage codes, new tables, rewritten views — and the **grant block** that gives `academy_app` its rights. |
| 0003 | `0003_seed_support.sql` | What the S02 content seed needs: a DEPARTMENT recording category, department metadata, `stages.sort`, and the upsert key that makes re-seeding questions safe. |
| 0004 | `0004_auth_support.sql` | What S03 sign-in needs: `trainees.track` becomes optional (D13 — a new starter has no track yet) and `sessions.sid_hash`, so a stolen database row cannot be replayed as a session. |
| 0005 | `0005_media.sql` | On-prem media (D15/D16): renames `call_recordings.s3_key` to `media_key` and adds the facts about the file on disk (`byte_size`, `content_type`, `checksum_sha256`, `uploaded_at`). `media_key` stays nullable for "coming soon" slots (D4). |
| 0006 | `0006_notifications.sql` | `notifications_sent`, with the UNIQUE key that makes "3 fails → ONE message" survive a restart, a retry and two workers racing. |
| 0007 | `0007_certificates.sql` | The certificates half of D15/D20: `certificates.s3_key` becomes `media_key` (PDFs live under `MEDIA_ROOT` at `academy/certs/`), plus `public_id`, the stored-file facts and the accomplishment text. |

`s3_key` still appears in 0001 and 0002 because an applied migration is never
edited; 0005 and 0007 fix it forward.

## Who runs them, and with what rights

Run them **in order, in one go**, with one login. The runner does that by
itself — it applies every pending file in number order — so there is normally
nothing to decide. What matters is the login and the two things that must
already exist:

1. **The `academy_app` login must exist BEFORE the migrations run.** 0002 ends
   with the grant block that gives it its rights, and that block is written so
   that a missing role does not fail the migration: it prints
   `NOTICE: Role academy_app does not exist: grants skipped` and carries on.
   A NOTICE scrolls past in a wall of output and nothing else ever mentions it
   again — the migration is recorded as applied, and the application then fails
   at its first query with "permission denied for schema academy". If that has
   happened: create the role, then re-run the grant block at the end of
   0002 by hand (it is idempotent). Nothing else needs re-running.
2. **0000 needs elevated rights.** `CREATE EXTENSION citext` is not something
   `academy_app` may do, and `citext` is not installed in the CRM's database
   today. It needs a superuser, or a role with CREATE on the database and rights
   to install the extension. In production that is Brad's own admin login.
3. **0001–0007 run as an owner/admin login too**, not as `academy_app`: they
   create and alter tables and grant rights. Set `MIGRATE_DB_USER` and
   `MIGRATE_DB_PASSWORD`; they override `DB_USER` / `DB_PASSWORD` for the runner
   only. Everything else comes from `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SSL`.
4. **`academy_app` itself never runs a migration.** It has no rights to, and
   that is the point.

In short, on a fresh database:

```
create the academy_app login  ->  0000 (elevated)  ->  0001 … 0007 (owner/admin)
```

## Rules

- **Brad applies production migrations.** Nobody else runs them against production. We write them; he runs them. No deploy script runs them (`ops/deploy.sh` says so out loud).
- **Never edit a migration once it has been applied anywhere.** Fix forward in a new file with the next number. The runner stores each file's sha256 in the ledger and refuses to run if an applied file has changed. A unit test also pins 0001's hash.
- Files are named `NNNN_short_name.sql` (four digits, lowercase). Two files with the same number are an error. A new file must sort after every applied one.
- No seed content in migrations, apart from small lookup tables (tracks, departments). Training content comes from the S02 seed.
- A migration that creates a table also grants `academy_app` what it needs on it (see the grant block at the end of 0002). Append-only tables never get UPDATE or DELETE.

## Running

Dry run (the default; writes nothing, not even the ledger):

```sh
npm run migrate -w @fac-academy/server
```

It prints the database name, the login, the server version, how many files are applied and which are pending.

Apply:

```sh
npm run migrate -w @fac-academy/server -- --commit --expect-db <database name> [--note "why"]
```

`--commit` refuses to run without `--expect-db`, and stops before touching anything if the name does not match `current_database()`. This is the wrong-database guard (the CRM ran a migration against the wrong database on 14 Sep 2026). It matters more here than anywhere else: the academy shares the CRM's database server, and its schema sits beside the CRM's own tables.

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
- `server/test/db/migrations.test.ts`: runs against `MIGRATIONS_TEST_DB_NAME` if it is set, otherwise `MIGRATION_TEST_DB_NAME`. It **drops the `academy` schema in that database** and migrates it from scratch, which is why it wants a database of its own: sharing one with the other DB-backed tests wipes their seeded content mid-run. Never point either variable at production.
