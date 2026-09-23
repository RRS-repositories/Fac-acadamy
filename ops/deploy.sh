#!/usr/bin/env bash
# FAC Academy — deploy (S10).
#
# Pull, install, build, put the certificate templates next to the build, reload
# the two pm2 apps. Nothing else. It is safe to run twice in a row, and it stops
# rather than guesses whenever something is not as it expects.
#
# WHAT THIS SCRIPT DOES NOT DO
# ----------------------------
# It does NOT run migrations. Brad applies them, by hand, with the wrong-database
# guard, before or after the deploy as the change requires (house rule; see
# server/migrations/README.md). A deploy that migrated on its own would be one
# unattended command away from writing to the CRM's own database.
# It does not touch .env, nginx, DNS, the feature flag or MEDIA_ROOT either.
#
# SETTINGS (environment only — no host names or paths live in this repo)
# ---------------------------------------------------------------------
#   ACADEMY_APP_DIR     Absolute path of the deployed checkout. Defaults to the
#                       repository this script sits in, which is the normal case.
#   ACADEMY_BRANCH      Branch to deploy. Default: main.
#   ACADEMY_REMOTE      Git remote. Default: origin.
#   ACADEMY_PM2         The pm2 command. Default: pm2.
#   ACADEMY_PM2_CONFIG  Optional: absolute path of the substituted pm2 ecosystem
#                       file on the server (see ops/pm2/ecosystem.config.cjs). If
#                       set, the apps are started-or-reloaded from it, so a first
#                       deploy works too. If not set, the two apps must already
#                       exist and are simply reloaded.
#   ACADEMY_SKIP_PULL=1 Build and reload what is already checked out (for a
#                       re-run after fixing something by hand).
#
# Usage:  ACADEMY_PM2_CONFIG=/path/to/ecosystem.config.cjs bash ops/deploy.sh

set -euo pipefail

BRANCH="${ACADEMY_BRANCH:-main}"
REMOTE="${ACADEMY_REMOTE:-origin}"
PM2="${ACADEMY_PM2:-pm2}"
PM2_CONFIG="${ACADEMY_PM2_CONFIG:-}"
SKIP_PULL="${ACADEMY_SKIP_PULL:-0}"

API_APP="academy-api"
WORKER_APP="academy-worker"

step() { printf '\n== %s\n' "$1"; }
info() { printf '   %s\n' "$1"; }
fail() { printf '\ndeploy: %s\n' "$1" >&2; exit 1; }

# --- Where we are ----------------------------------------------------------

if [ -n "${ACADEMY_APP_DIR:-}" ]; then
  APP_DIR="$ACADEMY_APP_DIR"
else
  # The repository root, found from this script's own location, so the script
  # works whatever directory it is called from.
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
[ -d "$APP_DIR" ] || fail "ACADEMY_APP_DIR \"$APP_DIR\" is not a directory."
cd "$APP_DIR"
[ -f package.json ] || fail "No package.json in \"$APP_DIR\": that is not the academy checkout."

command -v git >/dev/null 2>&1 || fail "git is not on the PATH."
# Not `[ -d .git ]`: a worktree's .git is a file, not a directory.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "\"$APP_DIR\" is not a git checkout."
command -v npm >/dev/null 2>&1 || fail "npm is not on the PATH."
command -v "$PM2" >/dev/null 2>&1 || fail "pm2 command \"$PM2\" is not on the PATH."

step "Deploying the academy"
info "checkout : $APP_DIR"
info "node     : $(node --version 2>/dev/null || echo 'not found')"
info "npm      : $(npm --version)"

BEFORE="$(git rev-parse HEAD)"

# --- Refuse a dirty tree ---------------------------------------------------
# A file edited on the server is either an emergency fix nobody has committed or
# a build artefact in the wrong place. Either way, `git pull` would either lose
# it or stop halfway. Stop here, with the list, while a person can still choose.

step "Checking the working tree"
DIRTY="$(git status --porcelain --untracked-files=normal)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >&2
  fail "The working tree has local changes (listed above). Commit, stash or remove them, then re-run."
fi
info "clean"

# --- Pull ------------------------------------------------------------------

if [ "$SKIP_PULL" = "1" ]; then
  step "Skipping the pull (ACADEMY_SKIP_PULL=1)"
  info "staying on $(git rev-parse --abbrev-ref HEAD) at ${BEFORE:0:12}"
else
  step "Pulling $REMOTE/$BRANCH"
  git fetch --prune "$REMOTE" "$BRANCH"
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    fail "On branch \"$CURRENT_BRANCH\" but asked to deploy \"$BRANCH\". Check out $BRANCH first, or set ACADEMY_BRANCH."
  fi
  # --ff-only: never create a merge commit on a server, and stop loudly if the
  # branch has diverged.
  git merge --ff-only "$REMOTE/$BRANCH"
fi

AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  info "already at $(git log -1 --pretty='%h %s' "$AFTER")  (nothing new; building anyway)"
else
  info "$(git log -1 --pretty='%h %s' "$BEFORE")"
  info "   ->  $(git log -1 --pretty='%h %s' "$AFTER")"
fi

# --- Dependencies ----------------------------------------------------------
# `npm ci` and not `npm install`: the lockfile decides, and a stale node_modules
# is wiped rather than patched, so a re-run lands in the same place every time.
#
# Why not --omit=dev: the build happens here, on the server, and vite, tsup and
# typescript are devDependencies. Omitting them means nothing builds. What ships
# to the browser is client/dist, which contains no dependency at all, and the
# server's dist/ is bundled by tsup; the dev tools simply sit unused on disk.

step "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund
info "done"

# --- Build -----------------------------------------------------------------

step "Building"
npm run build --workspaces --if-present
[ -f client/dist/index.html ] || fail "client/dist/index.html is missing after the build."
[ -f server/dist/api.js ] || fail "server/dist/api.js is missing after the build."
[ -f server/dist/worker.js ] || fail "server/dist/worker.js is missing after the build."
info "client/dist and server/dist are in place"

# --- Certificate templates -------------------------------------------------
# tsup emits dist/api.js and dist/worker.js and NOTHING else: it bundles code,
# and the certificate is HTML plus two embedded woff2 fonts, which are files.
# The renderer walks up from the running module looking for
# templates/certificate/certificate.html; copying the folder into dist/ makes the
# build self-contained, so the first certificate after a deploy renders instead
# of throwing "certificate template not found" — which would be discovered by a
# trainee finishing a level, not by us.

step "Copying the certificate templates beside the build"
[ -f server/templates/certificate/certificate.html ] \
  || fail "server/templates/certificate/certificate.html is missing from the checkout."
rm -rf server/dist/templates
mkdir -p server/dist/templates
cp -R server/templates/. server/dist/templates/
[ -f server/dist/templates/certificate/certificate.html ] \
  || fail "The certificate template did not land in server/dist/templates."
info "server/dist/templates/certificate ($(find server/dist/templates -type f | wc -l | tr -d ' ') files)"

# Chromium renders those templates. It is installed once per machine, not per
# deploy (npx playwright install chromium), so this is a warning, not a failure.
if ! npx --no-install playwright --version >/dev/null 2>&1; then
  info "NOTE: playwright is not runnable here; certificates need it plus its Chromium."
fi

# --- Reload ----------------------------------------------------------------
# reload, not restart: pm2 stops the old process only once the new one is up, so
# an API request in flight is not dropped. The worker finishes the job it is on
# (kill_timeout in the ecosystem file).

step "Reloading pm2"
if [ -n "$PM2_CONFIG" ]; then
  [ -f "$PM2_CONFIG" ] || fail "ACADEMY_PM2_CONFIG \"$PM2_CONFIG\" does not exist."
  info "from $PM2_CONFIG"
  # startOrReload starts an app that is not running yet and reloads one that is,
  # which is what makes the first deploy and the hundredth the same command.
  "$PM2" startOrReload "$PM2_CONFIG" --update-env
else
  info "no ACADEMY_PM2_CONFIG set: reloading the two apps by name"
  "$PM2" reload "$API_APP" --update-env
  "$PM2" reload "$WORKER_APP" --update-env
fi

"$PM2" list || true

# --- What just happened ----------------------------------------------------

step "Deployed"
info "checkout : $APP_DIR"
info "commit   : $(git log -1 --pretty='%h %s' "$AFTER")"
info "apps     : $API_APP, $WORKER_APP (reloaded)"
info "templates: server/dist/templates/certificate"
printf '\n'
printf '   Migrations were NOT run. If this release adds one, Brad applies it:\n'
printf '     npm run migrate -w @fac-academy/server                      (dry run)\n'
printf '     npm run migrate -w @fac-academy/server -- --commit --expect-db <database>\n'
printf '\n'
printf '   If the pm2 app list changed, run `pm2 save` or it will not survive a reboot.\n'
printf '\n'
