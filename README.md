# FAC Academy

Staff training portal for Fast Action Claims, served at `academy.fastactionclaims.com`.
Staff sign in with their CRM credentials plus an authenticator app, follow one of nine
training tracks, and unlock stages by reading lessons, listening to calls and passing quizzes.
The server enforces every lock and grades every quiz.

Everything sits behind the `ACADEMY_V2` flag, which is **off** by default. Nothing reaches
production without Brad's written sign-off.

## Layout

| Folder | What it is |
|---|---|
| `client/` | React + Vite + Tailwind CSS, plain JSX. Built to `client/dist`, served at `/` |
| `server/` | Node + Express in strict TypeScript. Two processes: `academy-api` (`/api/*`) and `academy-worker` (queues) |
| `shared/` | Request/response contracts (zod) used by both sides. No training content, no answers, no secrets |
| `ops/` | Seed and media scripts, deployment templates |
| `e2e/` | Playwright suite |
| `docs/` | [Project plan](docs/PROJECT-PLAN.md) and [handoff](docs/HANDOFF.md) |

ES modules everywhere; no CommonJS.

## Getting started

Requires Node 22 and, for the local services, Docker.

```bash
git config core.hooksPath .githooks   # once per clone: blocks pushes to main
npm install
cp .env.example .env                  # then fill in local values
docker compose up -d                  # Postgres, Redis, MinIO, Mailpit
npm run dev:server                    # API on http://localhost:4100
npm run dev:client                    # app on http://localhost:5173 (proxies /api)
```

## Checks

```bash
npm run check          # forbidden files, formatting, lint, typecheck, unit tests
npm run build && npm run check:bundle   # no answers or lesson text in the browser bundle
npm run test:e2e -w @fac-academy/e2e    # Playwright (needs the app running)
```

## Rules that matter here

- **Never commit the prototype HTML or any media.** The prototype holds real client call
  recordings and staff details. Scripts read it through `PROTOTYPE_PATH`, outside the repo.
- Secrets live only in `.env`. `.env.example` holds placeholders.
- Branch, then pull request. Never push to `main`, never force-push. See `CLAUDE.md`.
