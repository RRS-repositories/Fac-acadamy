# Handoff — where the FAC Academy project stands

*Last updated: 22 Sep 2026 (second session: client/server layout, subdomain, checklist artifact). Update this file at the end of every working session.*

## State right now

| Item | State |
|---|---|
| Repo | `E:\RRC\fac-academy`, remote `RRS-repositories/Fac-acadamy`. Only the "first commit" README is on GitHub (`main`) |
| Current branch | `sukhendu/project-plan` (local only) |
| Uncommitted files | `CLAUDE.md`, `docs/PROJECT-PLAN.md`, `docs/HANDOFF.md` |
| Push | **Nothing further gets pushed until the user says so; everything goes as a whole** |
| Code | None yet. Planning is done |
| Next step | **Phase 0 scaffolding**, local only: workspaces `client`, `server`, `shared`, `ops`, `e2e`, strict TS, ESLint/Prettier, `.gitignore`, `.githooks` pre-push guard, `docker-compose.yml` (Postgres 16, Redis 7, MinIO), `.env.example`, CI skeleton. Then **Section 01** |

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
| D11 | New-starter sign-in: **approve first** (Q1). No academy-only login; provisioning is requested before day one |
| D10 | Layout: `client/` (React SPA) · `server/` (API + worker) · `shared/` (contracts only) · `ops/` · `e2e/` |

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
