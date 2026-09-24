# End-to-end suite (Section 10)

Playwright, headless, against the app **running locally**. It never starts a
server of its own and it never touches production: every database change goes
through `ops/dev/e2e-prepare.ts`, which refuses any database whose name does not
look local (`dev` or `test`, never `prod`/`live`) — the same guard the rest of
`ops/dev/` uses.

## Running it

```bash
# once: the browser the suite drives
npx playwright install chromium

# two terminals, or however you normally run them
npm run dev:server        # API on http://localhost:4100
npm run dev:client        # app on http://localhost:5173 (proxies /api)

# the suite
npm run test:e2e -w @fac-academy/e2e
```

Useful variants:

```bash
npm run test:e2e -w @fac-academy/e2e -- tests/manager.spec.ts   # one file
npm run test:e2e -w @fac-academy/e2e -- -g "nine tracks"        # by name
npm run test:e2e:headed -w @fac-academy/e2e                     # watch it
E2E_WORKERS=1 npm run test:e2e -w @fac-academy/e2e              # one at a time
```

`E2E_BASE_URL` points it somewhere else (default `http://localhost:5173`).
`E2E_WORKERS` sets the worker count; **three is the maximum that is useful** —
see "Why it is not more parallel".

The security spec calls the bundle leak checker, so `client/dist` has to exist:
`npm run build -w client` if it does not.

## What it does to the database first

`ops/dev/e2e-prepare.ts` runs in the global setup (and again, with `--clean`, in
the teardown). It:

1. re-seeds the nine per-track dev accounts and the manager
   (`ops/dev/seed-test-accounts.ts`) and clears their progress;
2. resets the five sign-in accounts to day one — no progress, no certificates,
   enabled, old sessions ended — and **deletes their authenticators**, so the
   first sign-in of the run enrols a fresh TOTP secret that a test can generate
   codes from;
3. installs a **20-second fixture recording** on the first empty slot of stage
   `s4`: a generated WAV under `MEDIA_ROOT`. The teardown puts that slot back to
   "coming soon" and deletes the file, so `ops/seed/verify-seed.ts` still counts
   seven recordings with media.

If a run is killed and the teardown does not happen:

```bash
npm run e2e:clean -w @fac-academy/e2e
```

## The specs

| File | What it proves |
|---|---|
| `smoke.spec.ts` | The app answers, the flag is on, a signed-out visitor is sent to sign in and the API refuses them |
| `tracks.spec.ts` | Nine tracks: the dashboard's stage list is exactly `ops/fixtures/expected-track-visibility.json`, in unlock order, and on day one only the first stage is open |
| `locked.spec.ts` | Every locked stage and quiz is refused with the stage that must be passed first; the locked page shows the lock and none of the lesson text; another track's stage answers exactly like one that does not exist; a locked lesson cannot be marked read by id |
| `journey-cs.spec.ts` | A Customer Service trainee: lessons in the browser, a skip refused, an honest full listen, a deliberate fail with no answer revealed, a retake that passes, the next stage open, and a real 7-minute recording streamed while its own quiz stays shut |
| `journey-admin.spec.ts` | An Admin trainee: the core stages, the Level 1 banner, a certificate that downloads as a real PDF and verifies publicly with five facts and nothing else, then the department modules and a second certificate |
| `ux.spec.ts` | Choosing a quiz answer never moves the page; moving between lessons returns to the top; the next-up pulse does not animate under `prefers-reduced-motion` (with a control that proves it animates otherwise) |
| `manager.spec.ts` | The roster picks up a new attempt within one refresh, the online dot, the CSV with a row per trainee, track reassignment changing what the trainee sees, and disabling ending a session in under five seconds (timed) |
| `security.spec.ts` | A staff session gets 403 on every manager route and no management link; the quiz payload has no correct flag in any shape; the built bundle has no lesson text or answers; media is refused without a session, on a locked stage and by a crafted path; the public verify endpoint answers identically for everything that is not a certificate |
| `pii.spec.ts` | No response and no seeded row carries a real person from the prototype — by hash, never by the string — with a control test that proves the scanner works |

## Why it is not more parallel

Only the mock CRM's five invented accounts can sign in
(`server/src/integrations/crm/mockCrm.ts`, password `dev-password`); the nine
per-track accounts in `ops/dev/seed-test-accounts.ts` deliberately have no CRM
user and cannot. So:

* each worker **leases** one account for its whole life
  (`helpers/lease.ts`, an atomic `mkdir`), and tests inside a file run in order;
* the suite is metered to four sign-ins a rolling minute
  (`helpers/throttle.ts`), because the API allows five a minute from one IP
  address;
* the server refuses a TOTP step twice, so a worker signs in **once** and every
  test reuses those cookies (`helpers/test.ts`).

Four staff accounts exist, so three workers plus a spare for the re-sign-in the
manager spec needs is the practical ceiling.

## Honest by construction

* Quiz answers come out of the database (`helpers/db.ts`) because a test cannot
  pass a quiz honestly without knowing them. Nothing else about the run is read
  from the tables: every claim about behaviour is made through the app.
* The listening gate is paid in real time. The test sends beacons at the pace
  the server's wall-clock rule accepts, and first proves that one beacon
  claiming the whole recording buys only the seconds that have actually passed.
  It uses the 20-second fixture because the seeded recordings run from six to
  seventeen minutes; the rule under test is the real one, unchanged.
* The PII and bundle sweeps hold hashes only. `tools/make-pii-canaries.ts`
  rebuilds `fixtures/pii-canaries.json` from the prototype and prints labels and
  lengths, never the strings:

  ```bash
  PROTOTYPE_PATH=<build pack>/FAC-Academy-Portal-v2.5.html \
    npm run canaries:pii -w @fac-academy/e2e
  ```

* Where a test could pass for the wrong reason, it has a control: the
  reduced-motion test has a motion-allowed twin, the bundle check asserts how
  many canaries were used, and the PII sweep proves its own scanner first.
