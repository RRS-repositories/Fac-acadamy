# ops/

Scripts and templates that run on a developer machine or on the server. Nothing here is ever
bundled into the browser app (ESLint blocks `client/` from importing `ops/`).

## What arrives where

- `lib/prototype-path.ts` (Phase 0): resolves `PROTOTYPE_PATH` and refuses a path inside the
  repo.
- `fixtures/leak-canaries.json` (Phase 0, filled in S02): hashes of known answers and lesson
  sentences for `npm run check:bundle`.
- `seed/` (S02): reads the prototype and seeds stages, lessons, questions and the Status Guide.
  Safe to re-run.
- `media/` (S06): extracts the embedded recordings straight to S3, never to disk in the repo.
- `nginx/`, `pm2/`, `deploy.sh` (S10): deploy templates. Real hostnames, paths and credentials
  stay out of git.

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

Migrations live in `server/migrations/`. Locally and in CI they run against a throw-away
database. **In production, migrations are applied by Brad**, never by a deploy script or an
automated job.

## No production details

This folder holds templates only. Server hostnames, file paths, credentials and runbooks stay
out of the repo.
