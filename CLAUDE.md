# CLAUDE.md — FAC Academy (standing rules for Claude Code)

**Start every session by reading [docs/HANDOFF.md](docs/HANDOFF.md)** (where the project stands) and [docs/PROJECT-PLAN.md](docs/PROJECT-PLAN.md) (the plan, decisions, checklist).

## Standing rules that apply here too

Every `RRS-repositories` repo follows the same two rule documents. They live outside this repo; read them at the start of a session:

- `E:\RRC\CRM-Finalised\docs\GIT-WORKFLOW-RULES.md` — *how* changes reach `main` (also `E:\RRC\GIT-WORKFLOW-RULES.md`: branch naming and rebase-before-push)
- `E:\RRC\CRM-Finalised\docs\DATA-HYGIENE-RULES.md` — *what* may go into a repo

The CRM's `E:\RRC\CRM-Finalised\CLAUDE.md` also applies: the operating model (research first, fan-out, integrate, verify) and the guardrails on delegation.

## Push rule for this repo (user instruction, 22 Sep 2026)

- **Do not push anything, and do not open PRs, until the user says to push.** The work gets pushed **as a whole**, in one go.
- Committing locally on a working branch is fine when the user asks. Never commit to `main`.
- Never force-push. Never rewrite history.
- **Batch the work into a few large PRs, not many small ones** (user instruction, 22 Sep). Several sections go on one working branch as separate commits; the batch is pushed as a whole when the user says so. This overrides the "small, same-day PRs" line in the git workflow rules. Everything else in those rules still applies: start from the latest `main`, `yourname/short-description` branches, rebase on `main` before pushing, never force-push, keep both sides of a conflict.
- The `gh` CLI isn't installed. When it's time for a PR, give the GitHub compare URL.

## Where work happens

- **All academy work is in this folder** (`E:\RRC\fac-academy`). Remote: `RRS-repositories/Fac-acadamy` (spelling as created).
- The CRM repo (`E:\RRC\CRM-Finalised`) only gets **small, separate endpoint PRs** that the academy calls: `academy-verify` (before S03), and create-user + setup-token (before S08). **Never copy academy code into the CRM.** The recruitment portal did that and every change there costs two PRs.
- The academy **never reads CRM tables**. It uses the CRM API only.

## Build pack — source of truth, kept OUTSIDE the repo

`E:\RRC\Tasks Files\T-22-09\build-pack\`
- `SECTION-00…11-*.md` — build order and per-section checklists. Work **one section at a time, in order**. Each section ends with its checklist table (item → PASS/FAIL → evidence) plus 3–5 plain-English lines for Brad, who is not a developer. Then stop.
- `FAC-ACADEMY-BUILD-SPEC.md` — engineering source of truth. `FAC-ACADEMY-PROVISIONING-SPEC.md` — Mattermost account flow.
- `fac-academy-schema.sql` — becomes migration 0001 **verbatim**. It's fixed forward in 0002, never edited in place.
- `FAC-Academy-Portal-v2.5.html` — **content** source of truth: lessons, quizzes, pass marks, track rules, copy. Port verbatim; never invent or rewrite training content.
- Order of precedence: section files (newest) > build spec > the August schema/provisioning spec. On *content*, the prototype wins.

## Data hygiene specific to this project

- **Never commit the prototype HTML.** It embeds 6 real client call recordings (base64) and real staff names and emails. Scripts read it through `PROTOTYPE_PATH`.
- **Never commit media** (`.mp3`, `.mp4`, `.wav`, `.m4a`). Media goes to S3 only. The FOS video needs a PII review before upload.
- Fixtures and test accounts use invented names. The PII sweep uses hashes, never the real strings.
- Correct answers and lesson HTML must never appear in the web bundle. CI checks this.
- Secrets only in `.env`. `.env.example` holds placeholders only. A missing required variable must stop the app from starting.
- **No production details in the repo:** server paths, hostnames, credentials and runbooks stay out.

## Engineering rules

- Feature flag `ACADEMY_V2` defaults **OFF**; so does `ACADEMY_PROVISIONING`. Nothing reaches production without **Brad's written sign-off**.
- **Migrations:** we write them and **Brad applies them in production**. Subagents never run migrations or touch the production DB.
- Same Postgres DB as the CRM, but **schema `academy` only**, role `academy_app` with no rights on CRM tables, a small pool (~10) and a statement timeout.
- One `gate()` function guards every content route. The server enforces every lock and grades every quiz; the client is never trusted.
- BullMQ queue names **must not contain `:`** (BullMQ 6 throws). Use `prefix: 'academy'` with plain names.
- Stack: TypeScript (strict), Node 22, Express, React + Vite, Postgres, BullMQ/Redis, S3, SES, Mattermost bot. **No n8n.**
- Run the lint, typecheck and test gates yourself before calling anything done. A subagent reporting success is not evidence.
