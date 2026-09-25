# Handoff — where the FAC Academy project stands

*Last updated: 25 Sep 2026 (listening-budget fix, branch `sukhendu/listen-coverage-fix`; not committed). Update this file at the end of every working session.*

## State right now

| Item | State |
|---|---|
| Repo | `E:\RRCac-academy`, remote `RRS-repositories/Fac-acadamy`. **`main` now holds the whole build** — PR #1 merged 24 Sep, 29 commits |
| Current branch | `main`, clean and in sync with origin |
| CRM change | **Merged.** `POST /api/auth/academy-verify` is on CRM `main` (PR #500). It returns 404 until `ACADEMY_VERIFY_KEY` is set, so it is inert until Brad turns it on. This was the only CRM change still needed — dropping Mattermost (D18) removed the other |
| Built and verified locally | S01-S10. 624 unit tests plus 41 browser tests. Content seeded byte-identical from the prototype; the restricted DB login proven unable to read CRM tables; sped-up listen claims earn nothing; disable kills a session in 93 ms; backup + restore drill 9/9 including media; public certificate verify leaks only 5 facts |
| Deployment target | **Settled 24 Sep: the on-prem Ubuntu VM `crm-prod`, not AWS.** The August "standby" note is stale; the cutover was 17-20 Aug. D7 and D15 stand unchanged. Full runbook lives OUTSIDE the repo at `E:\RRC\Tasks Files\T-22-09\FAC-ACADEMY-DEPLOYMENT-RUNBOOK.md` (it names hosts and paths, which this repo may not) |
| Next step | Brad deploys the CRM so the verify endpoint is live, then sets `ACADEMY_VERIFY_KEY`. In parallel: the web address decision (below), a fair load re-measurement, Playwright in CI, and synthetic content so CI stops skipping 62 tests |

## Blocked on a decision

| # | Question | Why it blocks |
|---|---|---|
| 1 | **The web address**: `academy.rowanroseclaims.co.uk` or `academy.fastactionclaims.com`? | It is printed into every certificate's verification link, so it cannot change afterwards without invalidating certificates already issued. Everything on the server today is published under `rowanroseclaims.co.uk`, but `recruitment.fastactionclaims.com` also exists there |
| 2 | Email route and mailbox | Nothing is sent; every message is composed and stored, ready (D19) |
| 3 | Who receives manager alerts | Default is all managers |
| 4 | Track set automatically from CRM role? | Parked. Managers assign tracks today |
| 5 | Synthetic training content in the repo? | Would let CI actually run the 62 tests it currently skips, including every test of the quiz grader |

## Known gaps, honestly

- **62 tests do not run in CI** and cannot, without content. They are now declared in `test-skips.json` and the job summary prints what is therefore unproven. The blind spot is bounded and visible, not closed.
- **The load test fails its target**: 1.5s at 50 users against a 500ms goal — but measured against the dev server with 50 users sharing 5 accounts. Needs a fair re-run against the built server before it means anything.
- **Playwright is not wired into CI.**
- **Test accounts still exist** (`track.*`, `shot.*`, `manager.test`, `trainee.one/two`). They must not reach production.
- **`/opt/crm` has 28 uncommitted files on the server**, so its `git pull --ff-only` deploy will fail until a human clears them. This blocks the CRM deploy that the academy's sign-in depends on.

## Phase 0 gate results (22 Sep, run locally)

| Check | Result |
|---|---|
| `check:files` | OK, 57 files |
| Prettier | clean (`*.md` excluded via `.prettierignore`: hand-formatted tables) |
| ESLint | 0 errors, 0 warnings |
| Typecheck (shared, server, ops, e2e) | pass |
| Unit tests | shared 14, server 3, client 2: all pass |
| Builds | server (tsup) and client (vite, no source maps) succeed; compiled API answers `/api/health` |
| Bundle leak check | passes; no canaries until S02 |
| pre-push hook | blocks `main`, allows branches |

One client test run crashed natively (`ERR_IPC_CHANNEL_CLOSED`) right after the 5-minute install on the slow E: drive. It didn't reproduce in 12 later runs. If it comes back, capture it with `npx vitest run > out.txt 2>&1`.

## Local development

- Local Postgres 18 service on port 5432 (production is 17; CI tests on 17). Set up once with `node ops/local/setup-local-db.mjs`: logins `academy_owner` (migrations) and `academy_app` (the app), databases `academy_dev` and `academy_test`. Passwords are in the gitignored `.env`.
- Apply migrations: `npm run migrate -w @fac-academy/server -- --commit --expect-db academy_dev`. DB tests: `MIGRATION_TEST_DB_NAME=academy_test npx vitest run test/db` in `server/`.
- No local Redis yet (S03).

## Content seed (S02)

- `PROTOTYPE_PATH=<path outside repo> npx tsx ops/seed/seed-content.ts --expect-db academy_dev` (add `--dry-run` to roll back). Verify: `npx tsx ops/seed/verify-seed.ts --expect-db academy_dev`.
- Migration 0003 adds the DEPARTMENT recording category, department metadata, `stages.sort` and the question upsert key.
- Leak canaries in `ops/fixtures/leak-canaries.json` are hashes only.

## Listening budget fix (25 Sep, branch `sukhendu/listen-coverage-fix`)

- **The bug.** A trainee heard `s1-rec1` (1052 s) and `s1-rec2` (809 s) right through without skipping; the server credited 567 s and 413 s, in ~51 and ~45 fragments, and left both stage quizzes locked. The gaps were multiples of the five-second beacon interval.
- **Why.** The wall-clock budget was charged one beacon at a time with no slack, so any timing wobble made a beacon's media advance exceed the gap it was measured against; the excess was trimmed off the end, the client never learned it had been trimmed (it restarted from what it SENT), and the shortfalls added up past the two-second jitter tolerance. A third fault made it much worse: `delta > budget` compared unrounded float sums, so once the stored total was a value like 44.76 every exactly-fitting beacon afterwards was refused outright.
- **The fix.** The budget is now cumulative — total credited never exceeds the wall clock since the listen's first beacon, plus the first-beacon allowance — so wobble in either direction cancels out. The response carries `acceptedTo`, and the player re-sends whatever was not counted. Comparisons are rounded to the millisecond.
- **Migration 0008** adds `listen_progress.first_beacon_at` (nullable, backfilled from `last_beacon_at`). It creates no table, so it needs no new grant; it checks 0002's instead. **Brad applies it in production.**
- Proved against the running local app: the same honest 75-second listen on the real recording 49 credited 64.9 s in 3 fragments before the fix and 75 s in 1 fragment after it, and a real browser listen of the 20-second fixture ends up credited in full.

## Media (S06)

- **No S3** (decision D15, 23 Sep). Every recording lives on the server's own disk under `MEDIA_ROOT` and is streamed by the API. Locally `MEDIA_ROOT=E:/RRC/fac-academy/.media` (gitignored); **the folder must be backed up like the database — the database alone no longer holds the media**.
- Load the six call MP3s the prototype embeds: `PROTOTYPE_PATH=<outside repo> npx tsx ops/media/extract-media.ts --expect-db academy_dev` (`--dry-run` rolls back). It is idempotent: a second run reports all six `unchanged`. Run on 23 Sep — sales_1 8:42, sales_2 7:45, sale_3_ 6:12, CUSTOMER_SERVICE_1_INBOUND_UPDATE_CALL 7:01, CS_2_UTL 6:30, CS_3_CB_FOR_UPDATE 17:32; 6.4 MB in total, and every probed length matched the prototype's own.
- **The FOS video (`video1437476061.mp4`) is NOT loaded.** It is a real portal screen recording and waits for Brad's PII review. The extractor reports it as "not embedded, not ingested" every run.
- One new file at a time (the S11 pipeline): `npx tsx ops/media/ingest-media.ts --file "<path OUTSIDE the repo>" --stage <stageCode> --title "..." [--description "..."] [--recording-code <code>] --expect-db academy_dev`. It fills the stage's first "coming soon" slot, or adds a row; it refuses a file inside the repo and anything that is not mp3/m4a/wav/mp4.
- Managers upload through `POST /api/manager/recordings` (raw body = the file, `stageCode`/`title`/`description` as query parameters or `x-academy-*` headers). Over `MEDIA_MAX_UPLOAD_MB` → 413, wrong type → 415, audited as `MEDIA_UPLOADED`, and it queues `transcription/transcribe` + `question-gen/draft-questions` with the new recording id.
- Durations are probed with **music-metadata** (pure JavaScript; ffmpeg is not installed here and may not be on the server). Added to `ops/` and `server/`.
- The two media queues produce only: the consumers arrive in S08 with BullMQ. `call_recordings.transcript_status = 'PENDING'` is the durable marker of work outstanding, and AI-drafted questions stay DRAFT until a human approves them.

## Local test databases

- `academy_dev` (development), `academy_test` (DB-backed tests, holds the seeded content), `academy_migrations_test` (migration suite only — it drops the academy schema, so it must stay separate).
- Run the tests with `MIGRATION_TEST_DB_NAME=academy_test`, `MIGRATIONS_TEST_DB_NAME=academy_migrations_test` and a real `PROTOTYPE_PATH` (all three are in the local `.env`).
- Per-track dev accounts: `npx tsx ops/dev/seed-test-accounts.ts --expect-db academy_dev` (9 tracks + a manager, invented @example.com). Evidence sweep: `npx tsx ops/dev/track-sweep.ts --expect-db academy_dev`.

## Screenshots for Brad

- `npx tsx ops/dev/screenshots.ts` captures 8 app/prototype pairs into `E:\RRC\Tasks Files\T-22-09\screenshots\` — **outside the repo**, because the prototype screens show real staff names.
- It needs both dev servers running and `npx playwright install chromium` once.

## Documents

- [PROJECT-PLAN.md](PROJECT-PLAN.md) (v2): requirements, decisions, architecture, **client/server/shared folder layout (§7)**, subdomain routing (§7.2), delivery phases, per-section checklist, risks.
- **Shared build checklist (artifact, private until shared):** https://claude.ai/artifact/Er7iUFQ7w82Ba9boPoq1Ar. Every Phase 0–S11 item with an owner (Dev / Brad / CRM PR / Infra); ticks save for everyone who can edit it.
- `E:\RRC\Tasks Files\T-22-09\ACADEMY-PROJECT-PLAN.md` — the first, longer analysis (outside the repo). It has the full gap table (G1–G12), schema defects (X1–X11) and document conflicts (P1–P11).
- `E:\RRC\Tasks Files\T-22-09\build-pack\` — the build pack (section files, specs, schema, prototype, FOS video).

## Decisions made (with the user)

| # | Decision |
|---|---|
| D1 | CRM login check through a new CRM endpoint `POST /api/auth/academy-verify` (server-to-server, shared key). The academy adds TOTP + its own sessions |
| D2 | Same production server as the CRM, but separate apps (`academy-api`, `academy-worker`), with their own `.env`, deploy script and nginx site |
| D3 | After a failed quiz, show right/wrong only; reveal the answers only after a pass (deliberately differs from the prototype) |
| D4 | Recording slots with no media show as "coming soon" and never block the quiz |
| D5 | CRM MFA is out of scope |
| D6 | Local + production only; no staging server |
| D7 | Same Postgres DB as the CRM, schema `academy`, restricted role `academy_app` |
| D8 | Separate repo (this one); the CRM gets only small endpoint PRs |
| D9 | Domain working assumption `academy.fastactionclaims.com`; app + API on one origin, host-only session cookie (DNS owner still to confirm) |
| D12 | (22 Sep) S02 widens `call_recordings.category` for department recordings. **Superseded in part on 23 Sep (D15/D16): there is no S3 — media lives on the on-prem server under `MEDIA_ROOT`, and migration 0005 renamed `s3_key` to `media_key`.** |
| D11 | New-starter sign-in: **approve first** (Q1). No academy-only login; provisioning is requested before day one |
| D10 | Layout: `client/` (React SPA) · `server/` (API + worker) · `shared/` (contracts only) · `ops/` · `e2e/` |
| D13 | (22 Sep) A first-time trainee starts with no track ("waiting for a manager to assign a track"); the manager assigns it (S07), or IT meanwhile with `ops/admin/set-track.ts` |
| D14 | (22 Sep) Only CRM role `Management` = MANAGER (IT `role_overrides` can override either way); IT resets authenticators with the audited `ops/admin/reset-mfa.ts`, not an in-app role |

## Open questions (see plan §3)

- **Q1 decided (22 Sep): approve first** (D11). IT approves in Mattermost before day one, the CRM account is created, and then the starter signs in with CRM credentials + TOTP.
- Q5: OK to run a private test copy (`academy_test` schema) on the production server in place of staging?
- Q10: rename the repo `Fac-acadamy` → `fac-academy`?
- **Deferred by the user:** Q2 DNS owner (domain now assumed `.com`, D9), Q3 SES sender / AWS owner, Q6 Mattermost approvers + manager mapping.
- Also open: Q4 CRM role for new trainees, Q7 placeholder slots not in the S11 manifest, Q8 office hours + go-live date, Q9 EC2 vs on-prem server.

## Key findings to remember

**Prototype content (measured):** 28 stages (16 level + 12 department), 66 lessons, 231 questions (4 options each, no explanation text), 34 Status Guide rows, 48 recording slots of which only 7 have media. The stages each track sees are listed in plan §1. Scoring is `Math.round(correct/total*100) >= passMark`; mirror it exactly.

**Supplied schema problems (fixed in migration 0002, never by editing 0001):**
- Uses `CITEXT` without `CREATE EXTENSION`, so it fails on a fresh DB. Add `0000_extensions.sql`.
- Tracks are limited to CS/SALES/FULL, so the 6 department tracks can't be stored.
- No department column or stable stage code; `level_id NOT NULL` blocks department modules. No department completions.
- No `status_guide`, `role_overrides`, MFA or certificate-verify tables.
- `call_recordings.s3_key`/`duration_secs` are NOT NULL, which blocks "coming soon" rows. `listen_progress` has no coverage map.
- `v_stuck_trainees` uses 5 days (S07 says 7) and misses trainees with no attempts. `last_activity` counts quizzes only.
- Seeded questions would default to DRAFT (must be APPROVED); `shuffle` defaults TRUE (the prototype has a fixed order).

**Conflicts between documents:**
- Provisioning spec (training starts before CRM approval) vs S03 (sign in with CRM credentials) → Q1.
- Provisioning reply options cover only CS/Sales/Full; accept all 9 tracks.
- Provisioning needs CRM create-user + setup-token endpoints (the CRM has no trainee role). CRM MFA is out of scope (D5).
- Queue names like `academy:signin-events` throw in BullMQ 6.2.2; use a prefix.
- SES sender: `irl@` (build spec) vs `contact@rowanrose.co.uk` (provisioning spec).
- The build spec adds a manager-only "preview as track" tool; put it in S07.

**Engineering traps already spotted:**
- A 60 s signed media URL breaks long playback, because browsers re-request byte ranges. Stream through an authenticated API proxy.
- "Gaps > 5 s invalidate" with 5 s beacons fails on jitter. Merge covered intervals with a small tolerance and check wall-clock time.
- The prototype reveals answers after a fail (handled by D3).

**CRM facts (for the CRM PRs):**
- `POST /api/auth/login` requires a Cloudflare Turnstile token, checks bcrypt, `is_approved` and `account_locks`, and issues a JWT (`aud: rrs-crm-session`). No MFA, no track or department field.
- Roles come from the `user_role` enum; `Management` and `IT` are the manager-type roles.
- The CRM pool is `max: 20`. The CRM already uses a separate `mail` schema, the same pattern as ours.
- Recruitment migrations already needed `citext`.

**Video:** `video1437476061.mp4` is 30 MB, 19:29, with its index at the front (streams well). **Not yet reviewed for client data**; ffmpeg isn't installed on this machine.

**Content rulings Brad still owes** (ship the current wording until he rules): bank-statement window (2 vs 3 months), complaint timescale (8 vs 12 weeks), the "disposable income over 50%" line, "Anthony" named as case handler, "more than £500" strictness.
