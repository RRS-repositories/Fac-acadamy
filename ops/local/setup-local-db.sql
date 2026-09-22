-- One-time LOCAL setup for FAC Academy development. Never run against production.
-- Mirrors production's shape: an owner login that runs migrations (in production
-- that is Brad's admin login) and the restricted academy_app login the app uses.
--
-- Easiest: `node ops/local/setup-local-db.mjs` (reads the passwords from .env and
-- asks for the Postgres superuser password). Or directly:
--   psql -h localhost -U postgres -f ops/local/setup-local-db.sql \
--        -v owner_password=... -v app_password=...

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE academy_owner LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'academy_owner') \gexec
ALTER ROLE academy_owner PASSWORD :'owner_password';

SELECT 'CREATE ROLE academy_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'academy_app') \gexec
ALTER ROLE academy_app PASSWORD :'app_password';
-- Same as production: academy tables first, public for the citext type.
ALTER ROLE academy_app SET search_path = academy, public;

-- academy_dev: day-to-day development. academy_test: wiped by the test suite.
SELECT 'CREATE DATABASE academy_dev OWNER academy_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'academy_dev') \gexec
SELECT 'CREATE DATABASE academy_test OWNER academy_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'academy_test') \gexec

-- citext needs elevated rights, as it will in production (migration 0000 is
-- then a no-op). Installed here so the owner login doesn't need superuser.
\connect academy_dev
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
\connect academy_test
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

\echo 'FAC Academy local databases ready: academy_dev, academy_test'
