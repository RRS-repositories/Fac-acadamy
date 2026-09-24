-- ============================================================================
-- 0002_academy_v2_alignment: bring the August v1.0 schema (0001) in line with
-- the 9-track design in the build-pack section files.
--
-- 0001 is the supplied fac-academy-schema.sql, byte-for-byte, and is never
-- edited. Every correction lives here, tagged with its defect id from
-- ACADEMY-PROJECT-PLAN.md §4b (X2..X11). X1 (citext) is fixed in 0000.
--
-- The runner applies this file in one transaction with
-- search_path = academy, public. Names are schema-qualified anyway.
-- Idempotent where practical (IF NOT EXISTS / DROP ... IF EXISTS then ADD).
-- Seed rows: only the tracks and departments lookups. Training content (stages,
-- lessons, quizzes, status guide, recordings) is loaded by the S02 seed.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- X2: nine tracks instead of three.
-- 0001 declares `track TEXT ... CHECK (track IN ('CS','SALES','FULL'))` as a
-- column constraint on trainees and stages, so Postgres auto-names them
-- trainees_track_check and stages_track_check. The block below drops every
-- single-column CHECK on `track` whatever its name, so it also works if a
-- database was built with different names.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy.tracks (
    code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2,10}$'),
    label       TEXT NOT NULL,
    sort        SMALLINT NOT NULL UNIQUE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- Codes and labels mirror shared/src/constants.ts (TRACKS).
INSERT INTO academy.tracks (code, label, sort) VALUES
    ('FULL',  'Full Programme',      1),
    ('CS',    'Customer Service',    2),
    ('SALES', 'Sales',               3),
    ('ADMIN', 'Admin',               4),
    ('FOS',   'Financial Ombudsman', 5),
    ('MGMT',  'Management',          6),
    ('PAY',   'Payments',            7),
    ('IT',    'IT',                  8),
    ('DEBT',  'Debt Collections',    9)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT n.nspname, cl.relname, c.conname
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'c'
          AND c.conrelid IN ('academy.trainees'::regclass, 'academy.stages'::regclass)
          AND array_length(c.conkey, 1) = 1
          AND a.attname = 'track'
    LOOP
        EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.nspname, r.relname, r.conname);
        RAISE NOTICE 'X2: dropped CHECK % on %.%', r.conname, r.nspname, r.relname;
    END LOOP;
END
$$;

ALTER TABLE academy.trainees DROP CONSTRAINT IF EXISTS trainees_track_fkey;
ALTER TABLE academy.trainees
    ADD CONSTRAINT trainees_track_fkey FOREIGN KEY (track) REFERENCES academy.tracks (code);

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_track_fkey;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_track_fkey FOREIGN KEY (track) REFERENCES academy.tracks (code);


-- ---------------------------------------------------------------------------
-- X3: department academies, stable stage codes, level-less department stages.
-- Every department code is also a track code (a department track sees the
-- shared core plus its own two modules).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy.departments (
    code            TEXT PRIMARY KEY REFERENCES academy.tracks (code),
    label           TEXT NOT NULL,
    accomplishment  TEXT,                            -- filled by the S02 seed from the prototype
    sort            SMALLINT NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO academy.departments (code, label, sort) VALUES
    ('ADMIN', 'Admin',               1),
    ('FOS',   'Financial Ombudsman', 2),
    ('MGMT',  'Management',          3),
    ('PAY',   'Payments',            4),
    ('IT',    'IT',                  5),
    ('DEBT',  'Debt Collections',    6)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

-- `code` is the prototype's stage id (s1, cscalls, l2s1, dA1 ...), the key the
-- seed upserts on. `display_num` is the badge text ('1', 'A1', 'IT2' ...).
-- NOT NULL is safe: 0001 seeds no stages, and the S02 seed runs after this.
ALTER TABLE academy.stages
    ADD COLUMN IF NOT EXISTS code        TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS dept        TEXT,
    ADD COLUMN IF NOT EXISTS display_num TEXT;

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_code_key;
ALTER TABLE academy.stages ADD CONSTRAINT stages_code_key UNIQUE (code);

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_code_format;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_code_format CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$');

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_dept_fkey;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_dept_fkey FOREIGN KEY (dept) REFERENCES academy.departments (code);

ALTER TABLE academy.stages ALTER COLUMN level_id DROP NOT NULL;

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_level_or_dept;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_level_or_dept CHECK (level_id IS NOT NULL OR dept IS NOT NULL);

-- 0001's UNIQUE (level_id, position) does not cover department modules
-- (level_id is NULL there, and NULLs never collide).
CREATE UNIQUE INDEX IF NOT EXISTS stages_dept_position_key
    ON academy.stages (dept, position)
    WHERE level_id IS NULL;

-- X2 (continued): which stages each track sees, in unlock order. Mirrors the
-- prototype's visibleStage(); rows are written by the S02 seed.
CREATE TABLE IF NOT EXISTS academy.track_visibility (
    track_code  TEXT NOT NULL REFERENCES academy.tracks (code),
    stage_id    BIGINT NOT NULL REFERENCES academy.stages (id),
    position    SMALLINT NOT NULL CHECK (position >= 1),
    PRIMARY KEY (track_code, stage_id),
    -- Deferred so a re-seed can reorder a track inside one transaction.
    CONSTRAINT track_visibility_position_key
        UNIQUE (track_code, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS track_visibility_stage_idx
    ON academy.track_visibility (stage_id);


-- ---------------------------------------------------------------------------
-- X4: department completions (department certificates: "Certified DSAR
-- Reviewer" etc.). Same shape as level_completions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy.dept_completions (
    trainee_id          BIGINT NOT NULL REFERENCES academy.trainees (id),
    dept                TEXT NOT NULL REFERENCES academy.departments (code),
    completed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    certificate_ref     TEXT,                        -- generated PDF ref in S3
    manager_notified_at TIMESTAMPTZ,                 -- Mattermost DM on completion
    PRIMARY KEY (trainee_id, dept)
);


-- ---------------------------------------------------------------------------
-- X5: storage that S02 (status guide), S03 (roles, MFA) and S09 (certificate
-- verification) need.
-- ---------------------------------------------------------------------------

-- S02: the Status Guide lesson's searchable table. Rows come from the seed.
CREATE TABLE IF NOT EXISTS academy.status_guide (
    id          SMALLSERIAL PRIMARY KEY,
    status      TEXT NOT NULL UNIQUE,
    client_line TEXT NOT NULL,
    sort        SMALLINT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT status_guide_sort_key UNIQUE (sort) DEFERRABLE INITIALLY DEFERRED
);

-- S03: the CRM login check returns the CRM job role only. An IT-administered
-- override decides MANAGER vs STAFF; no row means the default mapping applies.
CREATE TABLE IF NOT EXISTS academy.role_overrides (
    crm_user_id BIGINT PRIMARY KEY,
    role        TEXT NOT NULL CHECK (role IN ('STAFF', 'MANAGER')),
    reason      TEXT,
    granted_by  TEXT NOT NULL,                       -- actor, same format as audit_events.actor
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S03: TOTP. The secret is stored encrypted by the app (key held in env, never
-- in the database). enrolled_at stays NULL until the first code verifies.
-- last_used_step is the 30-second TOTP step of the last accepted code: a code
-- is only accepted for a step greater than this, so a code cannot be replayed.
-- An IT reset deletes the row (and is audited).
CREATE TABLE IF NOT EXISTS academy.trainee_mfa (
    trainee_id      BIGINT PRIMARY KEY REFERENCES academy.trainees (id),
    secret_enc      BYTEA NOT NULL CHECK (octet_length(secret_enc) > 0),
    key_version     SMALLINT NOT NULL DEFAULT 1,
    enrolled_at     TIMESTAMPTZ,
    last_used_step  BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S09: every issued certificate, looked up by an unguessable public id on the
-- public verify endpoint. holder_name and track_code are frozen at issue so a
-- later rename or track change does not alter an issued certificate.
-- kind: LEVEL (level_id set), DEPT (dept set) or TRACK (whole-track award).
CREATE TABLE IF NOT EXISTS academy.certificates (
    id          BIGSERIAL PRIMARY KEY,
    public_id   TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{12,64}$'),
    trainee_id  BIGINT NOT NULL REFERENCES academy.trainees (id),
    kind        TEXT NOT NULL CHECK (kind IN ('LEVEL', 'DEPT', 'TRACK')),
    level_id    SMALLINT REFERENCES academy.levels (id),
    dept        TEXT REFERENCES academy.departments (code),
    track_code  TEXT NOT NULL REFERENCES academy.tracks (code),
    holder_name TEXT NOT NULL,
    s3_key      TEXT,                                -- PDF under academy/certs/; NULL until rendered
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    CONSTRAINT certificates_kind_target CHECK (
           (kind = 'LEVEL' AND level_id IS NOT NULL AND dept IS NULL)
        OR (kind = 'DEPT'  AND dept IS NOT NULL AND level_id IS NULL)
        OR (kind = 'TRACK' AND level_id IS NULL AND dept IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS certificates_trainee_idx ON academy.certificates (trainee_id);
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_per_level
    ON academy.certificates (trainee_id, level_id) WHERE kind = 'LEVEL';
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_per_dept
    ON academy.certificates (trainee_id, dept) WHERE kind = 'DEPT';
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_per_track
    ON academy.certificates (trainee_id, track_code) WHERE kind = 'TRACK';


-- ---------------------------------------------------------------------------
-- X6: "coming soon" recording slots (decision D4). A slot without media has
-- s3_key and duration_secs NULL; the gate counts only rows with an s3_key.
-- `code` is the seed's stable upsert key (NULL allowed for manager uploads).
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings
    ALTER COLUMN s3_key DROP NOT NULL,
    ALTER COLUMN duration_secs DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS code       TEXT,
    ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'AUDIO',
    ADD COLUMN IF NOT EXISTS position   SMALLINT;

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_code_key;
ALTER TABLE academy.call_recordings ADD CONSTRAINT call_recordings_code_key UNIQUE (code);

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_media_type_check;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_media_type_check CHECK (media_type IN ('AUDIO', 'VIDEO'));

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_duration_positive;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_duration_positive
    CHECK (duration_secs IS NULL OR duration_secs > 0);

CREATE UNIQUE INDEX IF NOT EXISTS call_recordings_stage_position_key
    ON academy.call_recordings (stage_id, position)
    WHERE stage_id IS NOT NULL AND position IS NOT NULL;


-- ---------------------------------------------------------------------------
-- X7: proof of a full listen. coverage holds the merged [from, to] second
-- intervals the server has accepted, e.g. [[0, 125.5], [130, 300]].
-- ---------------------------------------------------------------------------
ALTER TABLE academy.listen_progress
    ADD COLUMN IF NOT EXISTS coverage JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE academy.listen_progress DROP CONSTRAINT IF EXISTS listen_progress_coverage_array;
ALTER TABLE academy.listen_progress
    ADD CONSTRAINT listen_progress_coverage_array CHECK (jsonb_typeof(coverage) = 'array');


-- ---------------------------------------------------------------------------
-- X10: mirror the prototype's question order. (The other half of X10, seeding
-- prototype questions as source='HUMAN', approval_state='APPROVED', is the
-- S02 seed's job.)
-- ---------------------------------------------------------------------------
ALTER TABLE academy.quizzes ALTER COLUMN shuffle SET DEFAULT FALSE;


-- ---------------------------------------------------------------------------
-- X8 + X9: management views, rewritten per S07. The column lists change, so
-- both views are dropped (dependent one first) and created again.
--
-- X9: last_activity = the latest of quiz submissions, lesson reads, listening
-- beacons/completions and session heartbeats (NULL if none at all).
-- Aggregates come from per-trainee subqueries so joins do not multiply rows.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS academy.v_stuck_trainees;
DROP VIEW IF EXISTS academy.v_trainee_overview;

CREATE VIEW academy.v_trainee_overview AS
SELECT t.id,
       t.full_name,
       t.email,
       t.track,
       t.department,
       t.status,
       t.started_at,
       t.is_disabled,
       pa.authorised                                  AS stage1_authorised,
       COALESCE(ss.online_now, FALSE)                 AS online_now,
       ss.last_seen_at,
       COALESCE(lv.highest_level_complete, 0)         AS highest_level_complete,
       sc.stages_complete,
       dc.depts_complete,
       GREATEST(qa.last_quiz_at, lp.last_read_at, li.last_listen_at, ss.last_seen_at)
                                                      AS last_activity
FROM academy.trainees t
LEFT JOIN academy.progression_authorisations pa ON pa.trainee_id = t.id
CROSS JOIN LATERAL (
    SELECT MAX(s.last_seen_at) AS last_seen_at,
           bool_or(s.signed_out_at IS NULL AND NOT s.revoked
                   AND s.last_seen_at > now() - INTERVAL '3 minutes') AS online_now
    FROM academy.sessions s
    WHERE s.trainee_id = t.id
) ss
CROSS JOIN LATERAL (
    SELECT MAX(l.level_number) AS highest_level_complete
    FROM academy.level_completions lc
    JOIN academy.levels l ON l.id = lc.level_id
    WHERE lc.trainee_id = t.id
) lv
CROSS JOIN LATERAL (
    SELECT COUNT(*) AS stages_complete
    FROM academy.stage_completions c
    WHERE c.trainee_id = t.id
) sc
CROSS JOIN LATERAL (
    SELECT COUNT(*) AS depts_complete
    FROM academy.dept_completions d
    WHERE d.trainee_id = t.id
) dc
CROSS JOIN LATERAL (
    SELECT MAX(a.submitted_at) AS last_quiz_at
    FROM academy.quiz_attempts a
    WHERE a.trainee_id = t.id
) qa
CROSS JOIN LATERAL (
    SELECT MAX(p.read_at) AS last_read_at
    FROM academy.lesson_progress p
    WHERE p.trainee_id = t.id
) lp
CROSS JOIN LATERAL (
    SELECT GREATEST(MAX(g.last_beacon_at), MAX(g.completed_at)) AS last_listen_at
    FROM academy.listen_progress g
    WHERE g.trainee_id = t.id
) li;

-- X8: stuck = ACTIVE, not disabled, and either
--   * 3+ failed attempts on one stage they have not yet completed, or
--   * no activity for 7 days (P7: S07's 7 days, not the schema's 5). Someone
--     with no activity at all counts from started_at, so silent drop-outs
--     who never took a quiz are included.
-- stuck_stage_id is the uncompleted stage with the most fails (if any).
CREATE VIEW academy.v_stuck_trainees AS
SELECT o.id,
       o.full_name,
       o.email,
       o.track,
       o.last_activity,
       COALESCE(o.last_activity, o.started_at)                           AS inactive_since,
       f.stage_id                                                        AS stuck_stage_id,
       COALESCE(f.fails, 0)                                              AS stage_fails,
       COALESCE(f.fails, 0) >= 3                                         AS repeated_fails,
       COALESCE(o.last_activity, o.started_at) < now() - INTERVAL '7 days' AS inactive
FROM academy.v_trainee_overview o
LEFT JOIN LATERAL (
    SELECT q.stage_id, COUNT(*) AS fails
    FROM academy.quiz_attempts a
    JOIN academy.quizzes q ON q.id = a.quiz_id
    WHERE a.trainee_id = o.id
      AND NOT a.passed
      AND NOT EXISTS (
          SELECT 1 FROM academy.stage_completions c
          WHERE c.trainee_id = o.id AND c.stage_id = q.stage_id
      )
    GROUP BY q.stage_id
    ORDER BY COUNT(*) DESC, MAX(a.submitted_at) DESC
    LIMIT 1
) f ON TRUE
WHERE o.status = 'ACTIVE'
  AND NOT o.is_disabled
  AND (COALESCE(f.fails, 0) >= 3
       OR COALESCE(o.last_activity, o.started_at) < now() - INTERVAL '7 days');


-- ---------------------------------------------------------------------------
-- X11 + grants for the app's login role, academy_app.
-- academy_app gets the academy schema only (no rights on CRM tables). The
-- append-only tables (audit_events, provisioning_events) get no UPDATE or
-- DELETE, the views are read-only, and the migration ledger is read-only.
-- If the role does not exist yet, the grants are skipped with a NOTICE and
-- this migration still succeeds: create the role, then re-run this block.
-- Later migrations grant on the tables they create.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        RAISE NOTICE 'Role academy_app does not exist: grants skipped. Create the role, then re-run the grant block at the end of 0002_academy_v2_alignment.sql.';
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA academy TO academy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA academy TO academy_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA academy TO academy_app;

    -- Views: read-only.
    REVOKE INSERT, UPDATE, DELETE
        ON academy.v_trainee_overview, academy.v_stuck_trainees FROM academy_app;

    -- X11: append-only in fact, not just by comment.
    REVOKE UPDATE, DELETE, TRUNCATE
        ON academy.audit_events, academy.provisioning_events FROM academy_app;

    -- The migration ledger belongs to the migration runner.
    IF to_regclass('academy.schema_migrations') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON academy.schema_migrations FROM academy_app;
    END IF;

    RAISE NOTICE 'Grants for academy_app applied.';
END
$$;
