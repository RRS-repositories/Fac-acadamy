-- ============================================================================
-- 0004_auth_support: the schema changes S03 (sign-in, MFA, sessions) needs.
--
-- Fix-forward on top of 0001 (never edited), 0002 and 0003. Each change says
-- why it exists.
--
-- The runner applies this file in one transaction with
-- search_path = academy, public. Names are schema-qualified anyway.
-- Idempotent where practical (IF NOT EXISTS / DROP ... IF EXISTS then ADD).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. D13 (decided with the user, 22 Sep): a first-time trainee is created
--    with NO track. The home page says "waiting for a manager to assign a
--    track"; the manager assigns it (S07), and until then IT can set it with
--    ops/admin/set-track.ts. 0001 declared track NOT NULL; this drops that.
--    The foreign key to academy.tracks (0002, X2) stays: a track, when set,
--    must still be one of the 9 codes. A NULL track sees no stages.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.trainees ALTER COLUMN track DROP NOT NULL;


-- ---------------------------------------------------------------------------
-- 2. Link each academy.sessions row to its Redis session, so a disable (or a
--    sign-out) can revoke the exact Redis entry, and the heartbeat can update
--    the right row. The column holds the SHA-256 (hex) of the opaque session
--    id, NEVER the raw id: someone who can read this table must not be able
--    to replay a session cookie. NULL is allowed for rows written before S03.
--    Unique: one row per session. A UNIQUE constraint allows many NULLs.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.sessions
    ADD COLUMN IF NOT EXISTS sid_hash TEXT;

ALTER TABLE academy.sessions DROP CONSTRAINT IF EXISTS sessions_sid_hash_format;
ALTER TABLE academy.sessions
    ADD CONSTRAINT sessions_sid_hash_format CHECK (sid_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE academy.sessions DROP CONSTRAINT IF EXISTS sessions_sid_hash_key;
ALTER TABLE academy.sessions
    ADD CONSTRAINT sessions_sid_hash_key UNIQUE (sid_hash);

-- The disable sweep looks up a trainee's live sessions only.
CREATE INDEX IF NOT EXISTS sessions_live_by_trainee_idx
    ON academy.sessions (trainee_id)
    WHERE signed_out_at IS NULL AND NOT revoked;


-- ---------------------------------------------------------------------------
-- Checked and not needed:
--   * audit_events (event_type, created_at): 0001 already has this index.
--   * role_overrides and trainee_mfa: created by 0002 (X5).
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Grants: this file creates no tables, views or sequences. The new column,
-- constraints and index are covered by the table-level grants 0002 gave
-- academy_app, so there is nothing to grant.
-- ---------------------------------------------------------------------------
