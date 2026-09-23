# ops/

Scripts and templates that run on a developer machine or on the server. Nothing here is ever
bundled into the browser app (ESLint blocks `client/` from importing `ops/`).

Everything in here is TypeScript run with `tsx`, ES modules like the rest of the repo, with one
named exception: `pm2/ecosystem.config.cjs`, which pm2 insists on reading with `require()`.

## What is in here

| Folder | What it is |
|---|---|
| `seed/` | S02 content seed. `seed-content.ts` reads the prototype through `$PROTOTYPE_PATH` (outside the repo) in a jsdom sandbox and writes stages, lessons, questions and the Status Guide; it is safe to re-run. `verify-seed.ts` counts what landed, `lesson-diff.ts` shows what a re-run would change. |
| `media/` | S06/S11 media. `ingest-media.ts` puts a file into `MEDIA_ROOT` and registers the row (`--replace` to swap one); `extract-media.ts` pulls the recordings embedded in the prototype straight out to disk, never into the repo. This is also how a file bigger than the tunnel's ~100 MB body limit gets in. |
| `admin/` | The audited IT commands. `reset-mfa.ts` (lost authenticator), `set-track.ts` (D13), `set-role-override.ts` (D14), `authorise-stage1.ts` (the `STAGE1_AUTH_REQUIRED` gate). Each one takes `--expect-db`, supports `--dry-run`, writes an `audit_events` row in the same transaction, and prints ids and emails only. |
| `dev/` | Developer-machine helpers, never for production: `seed-test-accounts.ts` (invented accounts), `e2e-prepare.ts`, `track-sweep.ts`, `screenshots.ts`. |
| `backup/` | S10 backup and restore drill: `backup.ts` (database **and** the media folder — since D15 the database alone is not the whole system), `restore-drill.ts`, plus the manifest and checksum helpers. Plain-English instructions are in `docs/RUNBOOK-BACKUP.md`. |
| `load/` | `load-test.ts`: the "50 concurrent trainees, p95 under 500 ms" check from the go-live list. |
| `nginx/` | `academy.conf.template` — the academy's nginx site. A template: every `__PLACEHOLDER__` is substituted on the server. |
| `pm2/` | `ecosystem.config.cjs` — the `academy-api` and `academy-worker` process definitions. Also a template, and also unvalidated until it is substituted. |
| `deploy.sh` | Pull, install, build, copy the certificate templates beside the build, reload the two pm2 apps. It refuses to run on a dirty tree and it does **not** run migrations. |
| `local/` | `setup-local-db.mjs` — creates the local roles and databases from your `.env`. Local only. |
| `lib/`, `fixtures/`, `test/` | Shared helpers (`prototype-path.ts`), the leak canaries and the expected track visibility, and the ops test suite. |

## Deploying (what lives where)

`nginx/`, `pm2/` and `deploy.sh` are **templates and a script, not a configuration**. The
substituted nginx site and the substituted pm2 ecosystem file live on the server, outside the
checkout, so a deploy can never overwrite them and no real host name, path, port or log
location is ever committed here. Each file's header block lists exactly what to substitute.

`deploy.sh` reads everything it needs from the environment (`ACADEMY_APP_DIR`,
`ACADEMY_PM2_CONFIG`, …) for the same reason.

## The `PROTOTYPE_PATH` rule

The approved prototype embeds real client call recordings and real staff names and emails. It
is **never** copied into this repo. Set `PROTOTYPE_PATH` in your `.env` to its location in the
build pack, **outside** the repo. `resolvePrototypePath()` throws if the variable is unset, if
the file does not exist, or if the path (or its symlink target) is inside the repo.
`npm run check:files` also fails if the prototype, any media file or any HTML file over 1 MB is
tracked.

## Leak canaries

The fixture holds `{ label, length, sha256 }` only, never the text itself. To add one:

```sh
node scripts/check-bundle-leaks.mjs --hash "the sentence to guard" --label s1-q1-answer
```

Paste the printed entry into `fixtures/leak-canaries.json`.

## Migrations

Migrations live in `server/migrations/` (see its README for the order and the rights they
need). Locally and in CI they run against a throw-away database. **In production, migrations
are applied by Brad**, never by a deploy script or an automated job.

## No production details

This folder holds templates only. Server hostnames, file paths, credentials and runbooks stay
out of the repo.
