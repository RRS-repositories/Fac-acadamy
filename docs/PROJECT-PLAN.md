# FAC Academy — Project Plan

*Version 2 · 22 Sep 2026 · Repo: `RRS-repositories/Fac-acadamy` · Status: planning, no code yet*

*v2 changes: client/server/shared folder separation (§7), subdomain `academy.fastactionclaims.com` as the working assumption (D9, §7.2), and one push for the whole build (§8).*

Inputs: the build pack. That is the build spec, the provisioning spec, the schema, section files 00–11 and the approved prototype `FAC-Academy-Portal-v2.5.html`. The build pack **stays outside this repo**: the prototype contains real client call recordings and real staff details (see [§4](#4-data-hygiene-rules-specific-to-this-project)).

---

## 1. What we are building

A staff training portal on its own subdomain, **`academy.fastactionclaims.com`** (working assumption, D9).

- Staff sign in with their **CRM email + password** plus an **authenticator app** (TOTP).
- Each person follows one of **9 tracks**: Full Programme, Customer Service, Sales, Admin, Financial Ombudsman, Management, Payments, IT, Debt Collections.
- Everyone does the shared Foundation core first. After that, each track sees only its own stages.
- Each stage goes **lessons → call recordings → quiz**. Passing the quiz unlocks the next stage. The server enforces every lock and grades every quiz.
- **Managers** see a live roster, disable or re-enable accounts, reassign tracks and export CSV.
- **Mattermost** handles new-starter approval and manager alerts. **SES** sends the emails.
- Finishing a level or department earns a **PDF certificate** that anyone can verify.
- Everything sits behind the `ACADEMY_V2` flag (default **OFF**). Nothing goes live without **Brad's written sign-off**.

### Content in the prototype (measured)

| Item | Count |
|---|---|
| Stages | 28: 16 level stages (L1 = 8, L2–L5 = 2 each) + 12 department modules (6 academies × 2) |
| Lessons | 66 |
| Quiz questions | 231, each with 4 options and 1 correct answer |
| Pass marks | 80 default · Level 3/4 = 85 · Level 5 = 90 · departments = 80 |
| Status Guide | 34 entries |
| Recording slots | 48: **7 with real media** (6 call MP3s + the FOS walkthrough video, 19:29) and **41 "to be recorded"** |

### Stages each track sees (unlock order)

| Track | Stages | Questions | Stage ids |
|---|---|---|---|
| Full Programme | 16 | 124 | s1 s2 s3 s4 cscalls s5 s6calls s6 l2s1 l2s2 l3s1 l3s2 l4s1 l4s2 l5s1 l5s2 |
| Customer Service | 14 | 112 | s1 s2 s3 s4 cscalls s6 l2s1 l2s2 l3s1 l3s2 l4s1 l4s2 l5s1 l5s2 |
| Sales | 14 | 106 | s1 s2 s3 s5 s6calls s6 l2s1 l2s2 l3s1 l3s2 l4s1 l4s2 l5s1 l5s2 |
| Admin | 6 | 53 | s1 s2 s3 s6 dA1 dA2 |
| Financial Ombudsman | 6 | 44 | s1 s2 s3 s6 dF1 dF2 |
| Management | 6 | 40 | s1 s2 s3 s6 dM1 dM2 |
| Payments | 6 | 40 | s1 s2 s3 s6 dP1 dP2 |
| IT | 6 | 40 | s1 s2 s3 s6 dIT1 dIT2 |
| Debt Collections | 6 | 46 | s1 s2 s3 s6 dD1 dD2 |

This table is the baseline fixture for the Section 02, 04 and 10 tests.

---

## 2. Decisions made

| # | Decision |
|---|---|
| D1 | **CRM login check:** a new CRM endpoint `POST /api/auth/academy-verify`, called server-to-server with a shared key (the normal CRM login needs a captcha). The academy adds TOTP and its own sessions. |
| D2 | **Hosting:** the same production server as the CRM, but as **separate apps**: `academy-api` + `academy-worker` (pm2), an nginx site, and its own `.env` and deploy script. A CRM deploy never restarts the academy. |
| D3 | **Quiz feedback:** after a *failed* attempt, show only right/wrong per question. Reveal the correct answers only after a pass. This differs from the prototype on purpose, to stop "fail once, copy, pass". |
| D4 | **Empty recording slots:** show them greyed out as "coming soon" and never block the quiz. Only recordings with real media count toward the gate. |
| D5 | **CRM MFA** is not part of this project. |
| D6 | **Environments:** local + production only (no staging server). |
| D7 | **Database:** the **same Postgres database as the CRM**, with every table in its own `academy` schema and a restricted `academy_app` login (details in §5.3). |
| D8 | **Repo:** this repo, `Fac-acadamy`, is fully separate from the CRM. The CRM repo only gets small endpoint PRs; no academy code is copied into it. |
| D9 | **Domain (working assumption, 22 Sep):** `academy.fastactionclaims.com`, next to `crm.fastactionclaims.com`. The browser app and the API share one origin (`/` and `/api/*`), so there's no CORS and the session cookie stays host-only. Who manages DNS is still to be confirmed (Q2). |
| D11 | **New-starter sign-in (Q1, decided 22 Sep): approve first.** IT approves the starter in Mattermost before day one, the CRM account is created, and the starter signs in to the academy with CRM credentials + TOTP. There's no academy-only login. The provisioning flow (S08) is triggered by a request raised before the starter arrives, not by their first academy sign-in. |
| D10 | **Code layout:** `client/` (React SPA), `server/` (API + worker), `shared/` (API contracts only), plus `ops/` and `e2e/`. See §7. |
| D13 | **First-time trainees start with no track (22 Sep).** The trainee row is created at first sign-in with no track, and the home page says "waiting for a manager to assign a track". The manager assigns it (S07 screen; the API endpoint exists from S03). Until then IT can set it with `ops/admin/set-track.ts` (audited). Migration 0004 makes `trainees.track` optional. |
| D15 | **No S3 — media lives on the on-prem server (23 Sep).** Production is the on-prem box, so recordings and the video are stored in a folder named by `MEDIA_ROOT`, outside the repo and outside anything nginx serves. The API streams every byte after checking the session and the stage lock (Range-aware), so there are no signed URLs and no AWS SDK. The S3 checklist items ("objects private", "signed link expires at 61 s") are replaced by: the folder is not web-reachable, the API refuses without a session or on a locked stage, and path-escape attempts are rejected. Certificates (S09) store the same way. **Backups must include the media folder** — the database alone no longer holds the media. |
| D16 | **Column rename (23 Sep):** `call_recordings.s3_key` becomes `media_key` in migration 0005, since it is no longer an S3 key (this supersedes the "keep s3_key" half of D12). |
| D17 | **Durations without ffmpeg (23 Sep):** read with the pure-JavaScript `music-metadata` reader, so neither a developer machine nor the server needs ffmpeg installed. |
| D18 | **Mattermost dropped (23 Sep, user).** The approval bot is not built: with approve-first (D11) the CRM account already exists, so there is nothing to approve in chat. Alerts go by email instead, and CRM change #2 (create user + setup token) is no longer needed. |
| D19 | **No AWS, so no SES (23 Sep).** The email provider is undecided; the CRM already sends through Microsoft 365 (Graph) and SMTP. Until it is chosen, every notification and the certificate email are **composed, recorded and logged but never sent** (`ACADEMY_NOTIFY_MODE=shadow`), with one named send point to fill in. |
| D20 | **Certificates are stored like media (23 Sep):** PDFs under `MEDIA_ROOT` at `academy/certs/`, streamed by the API; migration 0007 renames `certificates.s3_key` to `media_key`. Chromium renders them, so the server needs `npx playwright install chromium`. |
| D14 | **Roles (22 Sep):** only the CRM role `Management` becomes MANAGER; everyone else is STAFF. An IT-set `role_overrides` row wins either way (`ops/admin/set-role-override.ts`). IT resets a lost authenticator with an audited ops command (`ops/admin/reset-mfa.ts`), not through an in-app IT role. |

---

## 3. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | ~~New-starter sign-in~~ **Decided: approve first (D11).** |  |
| Q2 | Domain: **working assumption `academy.fastactionclaims.com`** (D9). Still to confirm: who manages DNS for `fastactionclaims.com`, and who issues the TLS certificate | S10 |
| Q3 | SES sender, `irl@` or `contact@rowanrose.co.uk`, and who owns the AWS account? *(deferred)* | S08 |
| Q4 | Which CRM role does a newly provisioned trainee get? | S08 |
| Q5 | Without a staging server, is a **private test copy on the production server** OK? It would have its own `academy_test` schema, made-up accounts only and no public link. | S03 |
| Q6 | Mattermost approvers, and who counts as each trainee's "manager" for alerts. *(deferred)* | S08 |
| Q7 | Recording slots not in the S11 manifest (s1–s6 examples, Levels 2–5): keep as "coming soon", drop, or add to the manifest? | S11 |
| Q8 | Office hours for provisioning time-outs; target go-live date. | S08 / S10 |
| Q9 | ~~EC2 or on-prem?~~ **Answered from the CRM repo docs: on-prem.** The CRM, its Postgres 17 and its workers run on one on-prem server, published through a Cloudflare tunnel (AWS RDS is decommissioned). So the academy's DNS/TLS goes through the same tunnel set-up. Confirm with Brad | S10 |
| Q10 | The repo name is spelled `Fac-acadamy`. Rename it to `fac-academy` now, while it's empty? | now |

---

## 4. Data hygiene rules specific to this project

These add to the standing `GIT-WORKFLOW-RULES` and `DATA-HYGIENE-RULES`, which apply here too.

1. **Never commit the prototype HTML.** It embeds 6 real client call recordings as base64 and has real staff names and emails in its demo roster. The seed script reads it from a path in the `PROTOTYPE_PATH` env var, **outside the repo**.
2. **Media never touches the repo.** An ops script extracts the MP3s straight into S3. The FOS video (a real portal screen recording) needs a **PII review before upload**.
3. **Fixtures are synthetic.** Test accounts use invented names, and the PII sweep in the E2E suite uses hashes, not the real strings.
4. **Answers never reach the browser before submission.** CI greps the built bundle for a known answer and a known lesson sentence.
5. **Secrets only in `.env`.** `.env.example` holds placeholders, and the app refuses to start if a required variable is missing.
6. **No production details in the repo:** server addresses, paths, credentials and runbooks stay out of git.

### 4.1 The skipped-test ledger (`test-skips.json`)

Rule 1 has a cost: the suites that need the training content — the quiz API, the manager roster, the training read side, the status guide, the certificates — cannot run in CI, because CI has no prototype to seed from. They skip, and a skipped test used to be invisible behind a green tick. `test-skips.json` makes each one a declared, counted fact: for every test file it records how many tests may skip, why they cannot run, and what is therefore unproven, in plain English. `npm run check:skips -- --strict` (the CI test step) runs the suites and fails if a file skips tests it has not declared, skips more than its ceiling, or keeps an entry that no longer skips anything; it also prints the list of tests that did not run into the GitHub job summary.

To update it honestly: run the suites against a **migrated but unseeded** database, the way CI has one, then `npm run check:skips -- --update` to re-record the counts, then write a real reason and a real "unproven" line for every entry by hand. Raising a `max` is a decision, visible in the diff — never a way to quiet the check. The right fix, where one exists, is to make the test run without the content.

---

## 5. Architecture

```
            academy.fastactionclaims.com  (nginx site, TLS)
            ├── /        → client/dist (React app, static files)
            └── /api/*   → academy-api (Express, pm2)
                               │
   ┌───────────────┬───────────┼─────────────┬──────────────┬─────────────┐
   Postgres        Redis        S3 (private)  CRM API        Mattermost    SES
   same DB as CRM  sessions +   academy/media  academy-verify bot + #it-    setup +
   schema academy  BullMQ jobs  academy/certs  (+ user-create  department    certificate
   role academy_app prefix       (streamed via  for S08)       channel       emails
                   "academy"     the API)
                               │
            academy-worker (pm2): manager-notify · signin-events · provisioning
                                  · emails · certificates · transcription* · question-gen*
                                  (* stubs until after launch)
```

### 5.1 Technology

| Layer | Choice |
|---|---|
| Language/runtime | Node 22 LTS, npm workspaces, **ES modules only (no CommonJS)**. **Server + shared: strict TypeScript. Client: plain JavaScript (`.jsx`)** (user instruction, 22 Sep) |
| API | Express, `zod` for validation, `pg`. Migrations are plain SQL files applied by our own small runner (dry run by default, `--commit` to write), the same pattern as the CRM's `scripts/apply-*-migrations.mjs` |
| Auth | `otplib` + `qrcode` (TOTP), `express-session` + `connect-redis`, a per-user session index so disabling someone deletes their sessions at once, `rate-limiter-flexible` |
| Jobs | BullMQ with `prefix: 'academy'`. Queue names **must not contain `:`**, because BullMQ 6 throws on them, so the spec's `academy:signin-events` becomes `signin-events` under the prefix |
| Media | Files on the on-prem server's disk under `MEDIA_ROOT` (D15), streamed by the API with Range support so long audio and video play and resume; durations read with `music-metadata` (D17). No S3, no signed URLs |
| Email | `@aws-sdk/client-sesv2` |
| PDF | Server-side HTML → PDF (Playwright/Chromium) so certificates match the app's look |
| Web | React 18 + Vite in **plain JSX**, **Tailwind CSS v4** (`@tailwindcss/vite`), React Router, TanStack Query. The prototype's design tokens (navy `#16324F`, orange `#E8713A`, Outfit/Inter) become Tailwind `@theme` tokens |
| Tests | Vitest (unit), Supertest (API), Playwright (E2E) |
| CI | GitHub Actions: lint → typecheck → apply migrations to a throw-away Postgres → tests → bundle-leak grep |

### 5.2 How it connects to the CRM

- The academy **never reads CRM tables**. It only calls CRM endpoints:
  1. `POST /api/auth/academy-verify`: checks email + password and returns `{id, email, fullName, role, isApproved, locked}`. This is a separate CRM PR and must merge before S03.
  2. Create-user + password-setup-token endpoints, for provisioning. A separate CRM PR, needed before S08.
- CRM role `Management` maps to academy MANAGER; `academy.role_overrides` covers exceptions. The track comes from the academy, because the CRM has no track field.

### 5.3 Database (same DB as the CRM)

- Every table lives in the `academy` schema, so there are no name clashes. The CRM already uses a separate `mail` schema the same way.
- Login role `academy_app`: rights on `academy` only, **no rights on CRM tables**, `search_path=academy`, and a `statement_timeout`.
- The connection pool is capped at about 10; the CRM backend already uses up to 20.
- The academy's migration history lives in `academy.schema_migrations` (same columns as the CRM's ledger: `filename`, `applied_at`, `applied_by`, `note`), not in the CRM's `public.schema_migrations`.
- **Matches the CRM's database setup (checked 22 Sep):** production is PostgreSQL **17** on the same on-prem server as the CRM; the CRM connects with `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` over SSL with `statement_timeout` 10 s. The academy uses the same variable names, sets `DB_NAME` explicitly (the `PG*` variables on that server belong to a different app's database), and every migration starts with a wrong-database guard like the CRM's.
- `citext` is **not** installed in the CRM database today. Migration 0000 needs a superuser (Brad) to run `CREATE EXTENSION citext`.
- **Brad applies production migrations** (house rule). The first one needs admin rights for `CREATE EXTENSION citext`.
- `REVOKE UPDATE, DELETE` on the append-only tables (`audit_events`, `provisioning_events`).
- CRM backups cover the academy automatically. The restore drill uses `pg_dump -n academy`.

### 5.4 Schema: kept as-is, then corrected

The supplied `fac-academy-schema.sql` (v1.0, August) predates the 9-track design. It goes in **unchanged as migration 0001**, and a later migration corrects it:

| Migration | Contents |
|---|---|
| `0000_extensions.sql` | `CREATE EXTENSION IF NOT EXISTS citext`. The schema uses `CITEXT` but never creates it, so on its own it fails on a fresh database |
| `0001_academy_schema.sql` | The supplied schema, byte-for-byte |
| `0002_academy_v2_alignment.sql` | • 9 tracks: a `tracks` table + `track_visibility`, replacing the 3-value CHECKs<br>• `departments` table; `stages.code`, `stages.dept`, `stages.display_num`; `level_id` nullable for department modules<br>• `dept_completions` for department certificates<br>• `status_guide`, `role_overrides`, `trainee_mfa`, `certificates(public_id)`<br>• `call_recordings.s3_key` / `duration_secs` nullable (for "coming soon" slots) + `code`, `media_type`, `position`<br>• `listen_progress.coverage` (merged listened intervals)<br>• `v_stuck_trainees` rewritten to match S07 (7 days, 3+ fails, includes people with no attempts)<br>• `v_trainee_overview.last_activity` includes lesson reads, listens and heartbeats<br>• Grants for `academy_app` |

| `0005_media.sql` | S06, on-prem media (D15/D16): renames `call_recordings.s3_key` to `media_key` (guarded, so a re-run is safe) and adds the facts about the file on disk — `byte_size`, `content_type`, `checksum_sha256`, `uploaded_at` (`uploaded_by` already existed). `media_key` stays nullable for "coming soon" slots (D4), and a CHECK enforces the same key rule the API's `assertSafeKey` does: relative, no `..`, no backslash, no leading or trailing slash |

`s3_key` still appears in 0001 and 0002 because applied migrations are never edited — 0005 fixes it forward. `certificates.s3_key` is untouched and is S09's to rename.

Seed data: prototype questions go in as `source='HUMAN', approval_state='APPROVED'`, with `shuffle=false` so the order matches the prototype.

---

## 6. Environments

| Env | Where | Data | `ACADEMY_V2` |
|---|---|---|---|
| **local** | Docker Compose: Postgres 17 (matches production), Redis 7, MinIO (stands in for S3), MailHog-style inbox, the Mattermost API mocked | synthetic | on |
| **CI** | GitHub Actions service containers | throw-away | on |
| **test copy** *(if Q5 = yes)* | production server, schema `academy_test`, private URL | synthetic accounts only | on |
| **production** | production server, schema `academy` | real staff | **off until sign-off** |

**Environment variables** (the app refuses to start if a required one is missing):
`NODE_ENV, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL, REDIS_URL, MFA_ENCRYPTION_KEY, ACADEMY_V2, ACADEMY_PROVISIONING, STAGE1_AUTH_REQUIRED, CRM_AUTH_MODE, CRM_AUTH_URL, CRM_AUTH_KEY, MEDIA_ROOT, MEDIA_MAX_UPLOAD_MB, ACADEMY_NOTIFY_MODE, PUBLIC_BASE_URL`. See `.env.example` for what each one is and which are optional.

The S3, SES and Mattermost variables are **gone** (D15, D18, D19), as are `SESSION_SECRET`, `AUTH_STRICT`, `CRM_PUBLIC_URL` and `PROVISIONING_RESPONDERS`, which nothing ever read: a required setting that means nothing teaches people to put anything in it. `NODE_ENV` is the one to get right — left unset, a live server runs in development mode. `PROTOTYPE_PATH` and the four `BACKUP_*`/`PG_BIN` settings are used by the ops scripts only.

---

## 7. Folder structure (client / server / shared)

The browser code and the server code live in separate workspaces and never import each other. The only code both sides use is `shared/`, which holds **types and request/response contracts only**: no training content, no correct answers, no secrets. CI fails if `client/` imports anything from `server/`.

```
fac-academy/
├── client/                      React 18 + Vite + Tailwind SPA, plain JSX. Built to client/dist, served by nginx at /
│   ├── index.html
│   ├── vite.config.js           dev proxy: /api → http://localhost:4100 (same origin, as in production)
│   ├── src/
│   │   ├── main.jsx · App.jsx   App.jsx holds the routes (no separate routes.jsx)
│   │   ├── api/                 fetch client + TanStack Query hooks (validates with shared/ zod contracts)
│   │   ├── auth/                session context, <RequireAuth>, <RequireManager>
│   │   ├── styles/              index.css: Tailwind + @theme tokens ported from the prototype :root
│   │   ├── components/          AppShell, AuthStatusScreen, ErrorBanner, ScrollToTopOnNavigate,
│   │   │                        auth/ · training/ (StageCard, LockedCard, NoSeekPlayer, LessonBody …) · manager/
│   │   ├── pages/
│   │   │   ├── auth/            Login, MfaEnrol, MfaChallenge
│   │   │   ├── training/        Dashboard, Stage, Lesson, Quiz
│   │   │   ├── reference/       StatusGuide
│   │   │   ├── certs/           MyCertificates, VerifyCertificate (public page)
│   │   │   ├── manager/         Roster, Stuck, TraineeDetail, PreviewAsTrack, MediaUpload
│   │   │   └── NotFound.jsx · WaitingForTrack.jsx   (D13: no track assigned yet)
│   │   └── lib/                 scroll.js (navigation → top; in-place → never), format.js
│   └── test/                    Vitest + Testing Library
│
├── server/                      Express API + BullMQ worker: two processes from one codebase
│   ├── src/
│   │   ├── entry/
│   │   │   ├── api.ts           → pm2 app "academy-api"    (listens on 127.0.0.1:4100)
│   │   │   └── worker.ts        → pm2 app "academy-worker" (consumes the queues)
│   │   ├── app.ts               builds the Express app (no listen, so Supertest can use it)
│   │   ├── config/              env.ts (zod-validated; exits naming any missing variable), dotenv.ts
│   │   ├── db/                  pool.ts (max ~10, statement_timeout, search_path=academy),
│   │   │                        connection.ts, migrate.ts (the runner)
│   │   ├── middleware/          auth.ts (requireAuth / requireRole), flag.ts (503 when off)
│   │   ├── modules/             one folder per feature: routes.ts → service.ts → repo.ts
│   │   │   ├── health/
│   │   │   ├── auth/            crmClient use, totp, sessions (per-user index + revoke), limits
│   │   │   ├── training/        gate.ts ← the ONE gate · track, stages, lessons, quiz, grading, completions
│   │   │   ├── manager/         roster, accounts, export, previewAsTrack
│   │   │   ├── notifications/   rules + recipients + the shadow-mode notifier (D19)
│   │   │   └── audit/           the one place that writes audit_events
│   │   ├── media/               routes.ts (Range streaming), store.ts, root.ts, coverage.ts, upload.ts
│   │   ├── certs/               render.ts (Chromium → PDF), issue, verify, routes, email (shadow)
│   │   ├── integrations/        crm/ (the only code that talks to the CRM), redis.ts
│   │   ├── queues/              bull.ts, names.ts (prefix "academy", no colons), producers.ts,
│   │   │                        runtime.ts, deadLetter.ts
│   │   └── jobs/                handlers.ts, managerNotify, mediaJobs, certificateJobs
│   ├── migrations/              0000_extensions … 0007_certificates (eight files; see its README)
│   ├── templates/               certificate/ (HTML + two embedded woff2 fonts). Copied beside the
│   │                            build by ops/deploy.sh — tsup emits only dist/api.js and dist/worker.js
│   └── test/                    unit/ + api/ (Supertest, synthetic fixtures only)
│
├── shared/                      imported by client AND server: contracts only
│   └── src/
│       ├── contracts/           zod schemas + TS types per endpoint (auth, training, manager,
│       │                        media, certs, statusGuide, health)
│       ├── constants.ts         track codes, roles, pass-mark rule (no answers, no content)
│       └── lessonHtml.ts        the allow-list a lesson body is sanitised against
│
├── ops/                         runs on a developer machine or the server, never in the browser
│   ├── seed/                    seed-content.ts reads $PROTOTYPE_PATH (outside the repo), idempotent
│   ├── media/                   ingest-media.ts / extract-media.ts → MEDIA_ROOT, never into the repo
│   ├── admin/                   audited IT commands: reset-mfa, set-track, set-role-override,
│   │                            authorise-stage1 (the STAGE1_AUTH_REQUIRED gate)
│   ├── dev/                     developer-machine helpers (test accounts, e2e prep, screenshots)
│   ├── backup/                  backup.ts + restore-drill.ts (database AND the media folder)
│   ├── load/                    load-test.ts (50 concurrent trainees)
│   ├── local/                   setup-local-db.mjs
│   ├── nginx/academy.conf.template
│   ├── pm2/ecosystem.config.cjs (CommonJS: pm2 requires it — the one exception to ESM-only)
│   └── deploy.sh                pull → install → build → templates → pm2 reload (migrations are Brad's)
│
├── e2e/                         Playwright suite (S10)
├── docs/                        this plan, HANDOFF, RUNBOOK-BACKUP
├── scripts/                     check-forbidden-files.mjs, check-bundle-leaks.mjs (CI gates)
├── .github/workflows/ci.yml
├── .githooks/pre-push           blocks pushes to main
├── docker-compose.yml           local Postgres 17, Redis 7, Mailpit
├── .env.example                 placeholders only
├── .gitignore                   .env, node_modules, dist, *.mp3 *.mp4 *.wav *.m4a, the prototype HTML
├── tsconfig.base.json           strict; each workspace extends it
├── CLAUDE.md
└── package.json                 workspaces: client, server, shared, ops, e2e
```

**Rules that keep the separation real**

| Rule | How it's enforced |
|---|---|
| The client never imports server code | ESLint `no-restricted-imports` + a CI check |
| `shared/` has no content, answers or secrets | Code review + the CI bundle-leak grep on `client/dist` |
| The client has no secrets | Only `VITE_*` variables reach the bundle, and none of them is a secret |
| Content reaches the browser only through the API | The bundle grep for a known answer and a known lesson sentence (S02, S05) |
| Every content route goes through `gate()` | An API test lists every router and checks each content route |

### 7.1 How a request flows

```
Browser ── https://<academy host> ──► Cloudflare tunnel (TLS ends here)
                                      ──► nginx (HSTS, CSP, gzip; ops/nginx/academy.conf.template)
                                          ├─ /            → client/dist (SPA fallback; long cache on hashed assets)
                                          ├─ /verify/:id  → client/dist (public certificate page — needs the SPA fallback)
                                          └─ /api/*       → 127.0.0.1:4100 academy-api
                                                              ├─ Postgres (schema academy)
                                                              ├─ Redis (sessions + BullMQ prefix academy)
                                                              ├─ MEDIA_ROOT on local disk, streamed by
                                                              │  /api/media/:id/stream (D15: no S3)
                                                              └─ CRM API (academy-verify)
academy-worker ── Redis queues ──► manager alerts · certificate PDFs (Chromium) → MEDIA_ROOT
                                   every message composed, audited and logged, never sent (D19)
```

### 7.2 What the subdomain decides

| Topic | Choice |
|---|---|
| Origin | App and API on **one origin**, so there's no CORS configuration and no preflight requests |
| Session cookie | `HttpOnly; Secure; SameSite=Lax`, **host-only** (no `Domain=` attribute), so it's never sent to `crm.fastactionclaims.com` and the CRM cookie is never sent to the academy |
| DNS | One record `academy` in the `fastactionclaims.com` zone, pointing at the tunnel. The owner of the zone adds it (Q2, Q9) |
| TLS | Terminated by the **Cloudflare tunnel**, as the CRM's own hosts are. The nginx site therefore has no `ssl_certificate` and nothing for certbot to renew; a request that did not come through the tunnel is bounced to https, because the session cookie is secure-only in production |
| Links in emails | Certificate email + verify → `<PUBLIC_BASE_URL>/verify/<id>`, never hard-coded, and `PUBLIC_BASE_URL` must be `https://` in production. There is no setup email: D18 dropped provisioning, so `CRM_PUBLIC_URL` is gone with it |
| Test copy (Q5) | If approved: a separate private host name with the same layout, pointing at schema `academy_test` |
| Local development | Vite on `localhost:5173` proxies `/api` to `localhost:4100`, so it behaves the same as production |

## 8. Delivery plan

We work **one section at a time, in order**. Each section ends with its checklist table (PASS/FAIL + evidence) and a short plain-English note for Brad. Then we stop for review. Each section is committed **locally** on the working branch. Per the push rule of 22 Sep, nothing is pushed and no PR is opened until the user says so, and then **the whole build is pushed in one go** (the `gh` CLI isn't installed, so we hand over a compare URL). The only exceptions are the two small CRM endpoint PRs, which go through the CRM repo on their own timeline.

| Phase | Section | What it delivers | Depends on | Rough size |
|---|---|---|---|---|
| 0 | Setup | Repo scaffolding, `CLAUDE.md`, hooks, CI, local Docker stack | — | 0.5 d |
| 1 | **S01 Foundation** | Env loader, migrations 0000–0002, health endpoint, feature flag, CI green | — | 1 d |
| 2 | **S02 Content seed** | All 28 stages / 66 lessons / 231 questions / 34 status rows in the DB, verified | S01 | 1.5 d |
| 3 | **S03 Auth** | CRM login + TOTP + sessions + disable + lockout + audit | CRM PR #1 | 2–3 d |
| 4 | **S04 API & gating** | `gate()`, track list, lessons, server-side grading, completions | S02, S03 | 2 d |
| 5 | **S05 Front-end** | React port matching the prototype; scroll rules; accessibility | S04 | 3–4 d |
| 6 | **S06 Media** | S3 upload, streaming, full-listen tracking, manager upload + job stubs | S05, video PII review | 2–3 d |
| 7 | **S07 Manager** | Roster, stuck list, disable, reassign, CSV, preview-as-track | S06 | 1.5 d |
| 8 | **S08 Provisioning & comms** | Mattermost approval flow (shadow mode first), SES emails, manager DMs | CRM PR #2, Q3/Q4/Q6 | 2–3 d |
| 9 | **S09 Certificates** | PDF certificates, email, download, public verify | S08 | 1 d |
| 10 | **S10 E2E & go-live** | Playwright suite, backup + restore drill, load test, DNS/TLS, sign-off | all, Q2/Q9 | 2–3 d |
| 11 | **S11 Media collection** | Fill recording slots one at a time from Brad, no deploys | S06 (can run after go-live) | ongoing |

Estimated total **≈ 19–24 dev-days**, before review cycles.

---

## 9. Development checklist

### Phase 0: setup
- [x] Local folder `E:\RRC\fac-academy`, git initialised, `main` pushed to GitHub (22 Sep)
- [ ] Decide on the repo name spelling (Q10)
- [ ] `git config core.hooksPath .githooks`, with a pre-push hook blocking `main`
- [ ] `CLAUDE.md` pointing at the standing workflow + data-hygiene rules
- [ ] `.gitignore` covers `.env`, `node_modules`, `dist`, `*.mp3`, `*.mp4`, the prototype HTML
- [ ] npm workspaces `client`, `server`, `shared`, `ops`, `e2e`; strict `tsconfig.base.json`; ESLint + Prettier; client→server import ban
- [x] `docker-compose.yml` (Postgres 17, Redis 7, MinIO, Mailpit); `.env.example`
- [ ] GitHub Actions CI skeleton
- [ ] Build pack available locally outside the repo; `PROTOTYPE_PATH` documented

### S01: foundation
- [ ] `npm run lint && npm run typecheck` pass in `server`, `client` and `shared`
- [ ] Fresh DB → migrations 0000–0002 apply; `\dt academy.*` matches the expected table list
- [ ] Missing env var → process exits, naming the variable
- [ ] `/api/health` → `{ok, db:true, redis:true, flag}`
- [ ] `ACADEMY_V2=false` → every other route returns 503 `{flag:"off"}`
- [ ] CI green on `main`

### S02: content seed
- [ ] Seed reads the prototype via a sandbox (no hand-copying), and upserts so re-runs are safe
- [ ] Counts: 28 stages · 66 lessons · 231 questions · 34 status rows · pass marks as §1
- [ ] `track_visibility` for all 9 tracks equals the §1 table (zero diff)
- [ ] 48 recording rows: 7 with media, 41 "coming soon"
- [ ] Re-run → counts unchanged
- [ ] No answer strings in any client-served file
- [ ] 3 lessons HTML-diffed against the prototype (a script lesson, the Status Guide, the DSAR replica)

### S03: auth
- [ ] CRM PR #1 (`academy-verify`) merged and deployed
- [ ] CRM credentials + TOTP → session; role shows in `/api/me`
- [ ] Bad password and bad TOTP both rejected and audited
- [ ] Staff calling manager endpoints → 403
- [ ] Disable during an active session → next request refused within 5 s (timed script)
- [ ] Disabled account can't sign in; re-enable restores access
- [ ] 11 rapid failures → lockout
- [ ] The old demo passcode appears nowhere; audit rows for every auth event

### S04: API & gating
- [ ] Every content route goes through `gate()` (enforced by a test)
- [ ] `/api/track` equals the §1 table for all 9 tracks
- [ ] Every locked stage returns 403 on all 9 test accounts
- [ ] Quiz JSON has no `correct` field
- [ ] Pass-mark boundary tests for each quiz size (5, 6, 7, 8, 10, 11, 12, 20)
- [ ] Retakes, best score kept, answer reveal only after a pass (D3)
- [ ] Two simultaneous submits → two attempts, consistent state
- [ ] Level 1 complete → manager-notify job queued

### S05: front-end
- [ ] 8 screenshot pairs (prototype vs app) for Brad
- [ ] Answer clicks never scroll; navigation scrolls to top (automated check)
- [ ] Locked stages show the generic locked state, including on a direct URL
- [ ] Reduced-motion turns off the pulse; quiz and pills work by keyboard
- [ ] Bundle contains no answers and no lesson text

### S06: media
- [ ] Video reviewed for client data before upload
- [ ] 7 media files in private S3, durations probed
- [ ] Links expire; locked-stage media refused; streaming supports range requests
- [ ] Full playback → marked listened; a crafted 20 s gap → not marked
- [ ] Quiz blocked until the real recordings are done ("coming soon" slots don't block)
- [ ] Manager upload → S3 + DB row + 2 queued jobs; audit rows

### S07: manager
- [ ] Roster, online-now (3 min), stuck list
- [ ] Disable from the dashboard kills the session in < 5 s
- [ ] Track reassignment changes visible stages
- [ ] CSV export matches the DB; audited
- [ ] Preview-as-track is manager-only and read-only
- [ ] Staff can't see or call any of it

### S08: provisioning & comms
- [ ] CRM PR #2 (create user + setup token) merged
- [ ] Shadow mode first (`ACADEMY_PROVISIONING` logs only), then live
- [ ] Request → channel post → authorised reply → accounts created → email received
- [ ] Unauthorised reply ignored and logged; replies accept all 9 tracks + Decline
- [ ] Worker killed mid-job → completes exactly once
- [ ] Level 1 DM; 3 fails on a stage → exactly one DM; dead-letter queue empty

### S09: certificates
- [ ] Banners, PDF in S3, email with attachment, in-app download
- [ ] Verify endpoint: real id valid, tampered id invalid, 30/min limit

### S10: E2E & go-live

Rewritten 23 Sep to match what was actually built: there is no S3 (D15), no Mattermost
(D18) and no provisioning flow, so the items about them are gone rather than left
ticking along unread.

**Before the flag goes on**
- [ ] Full Playwright suite green in CI
- [ ] Backup + one restore drill evidenced — **including the media folder** (`MEDIA_ROOT`): since D15 the database on its own restores an academy whose every recording, video and certificate is missing
- [ ] 50 concurrent trainees: p95 < 500 ms, no errors
- [ ] Security recheck: no passcodes in the bundle, no preview toggle for staff, every secret in `.env` only, `NODE_ENV=production` set (or the session cookie is not secure), media not reachable except through the API
- [ ] **Prove the app login cannot read a CRM table**: as `academy_app`, `SELECT` from a CRM table and get "permission denied". A grant block that silently skipped (see `server/migrations/README.md`) is the way this goes wrong
- [ ] Car-finance lesson flagged for review on FCA updates
- [ ] Brad's 5 content rulings applied or deferred in writing

**Server set-up** (each one is a template in `ops/`, substituted on the server)
- [ ] Migrations 0000–0007 applied by Brad, in order, with the `academy_app` login already created
- [ ] `.env` complete on the server; the app refuses to start if anything required is missing
- [ ] Chromium installed for the certificate PDFs: `npx playwright install chromium` (plus its system libraries). Without it, certificates fail at the moment a trainee finishes a level
- [ ] pm2: `academy-api` + `academy-worker` from the substituted `ops/pm2/ecosystem.config.cjs`, then **`pm2 save`** (nothing survives a reboot without it) and **`pm2 install pm2-logrotate`** (a full disk takes the CRM down too)
- [ ] nginx: the substituted `ops/nginx/academy.conf.template` installed, `nginx -t` clean, reloaded. Check the SPA fallback by opening a `/verify/<id>` link cold — every certificate carries one
- [ ] `ops/deploy.sh` run once end to end on the server, and re-run to prove it is repeatable
- [ ] DNS + the Cloudflare tunnel route live, and https reaches the site

**Go-live**
- [ ] **Brad's written sign-off** → `ACADEMY_V2=true` → 9-track smoke test → tell the staff (there is no Mattermost announcement: D18)

### S11: media collection
- [ ] Manifest worked one item at a time; every row INGESTED or DEFERRED
- [ ] AI draft questions stay DRAFT until a human approves them
- [ ] PII-review list reported to Brad

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Prototype or media committed by accident (client voices, staff details) | `.gitignore` rules + a CI check that fails on `.mp3`/`.mp4`/the prototype filename |
| A 60 s signed link expires during a 19-minute video | Stream through the API with range support |
| Network jitter wrongly fails a "full listen" | Merge covered intervals with a small tolerance, and check wall-clock time |
| Academy load slows the CRM database | Separate role, small pool, statement timeout |
| CRM PRs not merged in time | Raise CRM PR #1 during S01/S02, so it's ready for S03 |
| No staging server | A private test copy (Q5) plus the full local Docker stack |
| Supplied schema doesn't fit the 9-track design | Keep it as migration 0001; fix it forward in 0002 |
