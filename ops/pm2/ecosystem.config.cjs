// FAC Academy — pm2 process list TEMPLATE (S10).
//
// WHY THIS FILE IS CommonJS
// -------------------------
// The house rule is ES modules only, no CommonJS, no .cjs files. This is the
// one exception, and it is pm2's rule rather than ours: pm2 (checked against
// pm2 6) reads an ecosystem file with require(). Every package here declares
// "type": "module", so a file named .js in this tree is an ES module and
// require() refuses it with ERR_REQUIRE_ESM — pm2 then reports "File
// ecosystem.config.js not found" or a parse error and starts nothing. pm2 has
// accepted the .cjs extension since v5, so .cjs is the name that works while
// leaving the rest of the repo ESM. Nothing imports this file; it is data for
// pm2 and never runs inside the app.
//
// WHAT TO SUBSTITUTE
// ------------------
//   __APP_DIR__   Absolute path of the deployed checkout (the folder holding
//                 client/, server/, ops/). Both apps run from __APP_DIR__/server
//                 because that is where the build and the templates are.
//   __ENV_FILE__  Absolute path of the academy's .env on the server. Set
//                 explicitly so neither process depends on which directory pm2
//                 happened to be started from. Everything secret lives in that
//                 file; nothing secret goes in here.
//   __LOG_DIR__   Absolute path of a folder the application user can write.
//
// Install it as a file on the server (NOT in the repo checkout, so a deploy
// never overwrites the substituted copy), then:
//
//   pm2 start /path/to/ecosystem.config.cjs
//   pm2 save                 # <- see below
//   pm2 install pm2-logrotate
//
// `pm2 save` IS WHAT SURVIVES A REBOOT. pm2 restores the list it last saved,
// not the list it happens to be running. Start or rename an app and forget
// `pm2 save`, and the academy simply is not there after the next reboot —
// silently, with no error anywhere. Run it after every change to this file.
// (`pm2 startup` once, as root, is what makes pm2 itself start at boot.)
//
// pm2-logrotate IS NOT OPTIONAL. Without it these logs grow until the disk
// fills, and a full disk takes the CRM down with us — same box, same database.
//   pm2 install pm2-logrotate
//   pm2 set pm2-logrotate:max_size 50M
//   pm2 set pm2-logrotate:retain 14
//   pm2 set pm2-logrotate:compress true
//
// Migrations are NOT here and NOT in the deploy. Brad applies them (house rule).

const APP_DIR = '__APP_DIR__';
const ENV_FILE = '__ENV_FILE__';
const LOG_DIR = '__LOG_DIR__';

// Shared by both apps. NODE_ENV=production is what turns on the secure session
// cookie and refuses the mock CRM; leaving it out is the quiet way to run a
// live server in development mode.
const env = {
  NODE_ENV: 'production',
  ENV_FILE,
};

module.exports = {
  apps: [
    {
      // The HTTP API. Binds 127.0.0.1 (HOST) on PORT; nginx proxies to it.
      name: 'academy-api',
      script: 'dist/api.js',
      cwd: `${APP_DIR}/server`,

      // fork, one instance. Not cluster: sessions and rate limits are in Redis
      // so several would work, but one process keeps the logs and the "who is
      // online" numbers honest, and the load is a few dozen trainees.
      exec_mode: 'fork',
      instances: 1,

      env,

      // A restart drops any media stream in flight, so the ceiling is set well
      // above normal use: this is a safety net for a leak, not a routine event.
      // Chromium renders a certificate in this process when a trainee finishes
      // a level, which is the largest thing it ever does.
      max_memory_restart: '800M',

      autorestart: true,
      // A process that dies inside 20s is crashing, not restarting; after 10 of
      // those pm2 stops and leaves it errored rather than looping for ever.
      // That is the wanted behaviour for a bad .env: the app prints which
      // variable is missing and stays down where someone will notice.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      // SIGTERM handler closes the server, Redis, Chromium and the pool.
      kill_timeout: 15000,

      out_file: `${LOG_DIR}/academy-api.out.log`,
      error_file: `${LOG_DIR}/academy-api.err.log`,
      merge_logs: true,
      time: true,
    },
    {
      // The background worker: manager notifications, certificates, media
      // follow-ups. Listens on no port. It REQUIRES Redis and refuses to start
      // without it, on purpose — a worker that consumes nothing must not look
      // healthy.
      name: 'academy-worker',
      script: 'dist/worker.js',
      cwd: `${APP_DIR}/server`,

      exec_mode: 'fork',
      instances: 1,

      env,

      // Higher than the API: this is where most certificates are rendered, and
      // Chromium is the memory in the room.
      max_memory_restart: '1000M',

      autorestart: true,
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      // Longer than the API's: on SIGTERM the worker stops taking jobs and lets
      // the ones already running finish. A PDF render plus its database write
      // is the slowest of them.
      kill_timeout: 30000,

      out_file: `${LOG_DIR}/academy-worker.out.log`,
      error_file: `${LOG_DIR}/academy-worker.err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
