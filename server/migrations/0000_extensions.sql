-- ============================================================================
-- 0000_extensions: database extensions the academy schema needs.
--
-- Fixes X1: fac-academy-schema.sql (migration 0001) uses CITEXT for
-- trainees.email but never creates the extension, so 0001 fails on a fresh
-- database without this file.
--
-- citext goes in `public`, so every connection that compares CITEXT values
-- must keep `public` on its search_path (the app uses `academy, public`).
--
-- Privileges: needs a superuser, or a role with CREATE on the database.
-- citext is a trusted extension on PostgreSQL 13+, so a database owner can
-- install it too. In production Brad runs this with his admin login; the
-- citext extension is not installed in the CRM database today.
--
-- Idempotent: IF NOT EXISTS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
