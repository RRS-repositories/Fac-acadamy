-- ============================================================================
-- FAC ACADEMY — TRAINING DATABASE SCHEMA (PostgreSQL)
-- Version 1.0 · August 2026 · Owner: Brad Forbes
-- Pattern rules honoured: append-only event log, full audit, feature-flagged,
-- BullMQ job payloads reference these tables (no n8n).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS academy;

-- ---------- People & provisioning ----------
CREATE TABLE academy.trainees (
    id              BIGSERIAL PRIMARY KEY,
    crm_user_id     BIGINT UNIQUE,                  -- NULL until provisioned
    full_name       TEXT NOT NULL,
    email           CITEXT NOT NULL UNIQUE,
    track           TEXT NOT NULL CHECK (track IN ('CS','SALES','FULL')),
    department      TEXT,                            -- set at authorisation
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','PAUSED','LEFT','COMPLETED')),
    is_disabled     BOOLEAN NOT NULL DEFAULT FALSE,   -- manager shut-off: blocks sign-in, kills sessions
    disabled_by     BIGINT,
    disabled_at     TIMESTAMPTZ,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manager gate: new starters cannot progress past Stage 1 without authorisation
CREATE TABLE academy.progression_authorisations (
    trainee_id      BIGINT PRIMARY KEY REFERENCES academy.trainees(id),
    stage1_passed_at TIMESTAMPTZ,
    authorised      BOOLEAN NOT NULL DEFAULT FALSE,
    authorised_by   BIGINT,                          -- manager CRM user id (Jerusha/CS manager/Brad)
    authorised_at   TIMESTAMPTZ
);

-- Live sessions for the management dashboard "online now" view
CREATE TABLE academy.sessions (
    id              BIGSERIAL PRIMARY KEY,
    trainee_id      BIGINT NOT NULL REFERENCES academy.trainees(id),
    signed_in_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- heartbeat every 60s
    signed_out_at   TIMESTAMPTZ,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE       -- set TRUE when manager disables account
);
CREATE INDEX ON academy.sessions (trainee_id, last_seen_at);

CREATE TABLE academy.provisioning_requests (
    id                  BIGSERIAL PRIMARY KEY,
    trainee_id          BIGINT NOT NULL REFERENCES academy.trainees(id),
    state               TEXT NOT NULL DEFAULT 'AWAITING_AUTH'
                        CHECK (state IN ('AWAITING_AUTH','PROVISIONED','DECLINED','EXPIRED')),
    mattermost_post_id  TEXT,
    department          TEXT,
    authorised_by       TEXT,                        -- Mattermost user id of approver
    crm_user_id         BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at          TIMESTAMPTZ
);

-- Append-only. No UPDATE/DELETE grants in production.
CREATE TABLE academy.provisioning_events (
    id          BIGSERIAL PRIMARY KEY,
    request_id  BIGINT NOT NULL REFERENCES academy.provisioning_requests(id),
    event_type  TEXT NOT NULL,                       -- SIGNIN|POSTED|REPLY|APPROVED|DECLINED|EMAIL_SENT|...
    payload     JSONB NOT NULL DEFAULT '{}',
    actor       TEXT NOT NULL,                       -- system|mattermost:<id>|user:<id>
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Curriculum: levels → stages → lessons ----------
CREATE TABLE academy.levels (
    id              SMALLSERIAL PRIMARY KEY,
    level_number    SMALLINT NOT NULL UNIQUE,        -- 1..5 (extensible)
    name            TEXT NOT NULL,                   -- Foundation, Working Claims, ...
    weeks_label     TEXT,                            -- 'Week 1', 'Weeks 2–3'
    accomplishment  TEXT NOT NULL,                   -- 'You are ready to start work', ...
    description     TEXT,
    default_pass_mark SMALLINT NOT NULL DEFAULT 80 CHECK (default_pass_mark BETWEEN 1 AND 100),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE academy.stages (
    id              BIGSERIAL PRIMARY KEY,
    level_id        SMALLINT NOT NULL REFERENCES academy.levels(id),
    position        SMALLINT NOT NULL,               -- order within level
    title           TEXT NOT NULL,
    blurb           TEXT,
    track           TEXT NOT NULL DEFAULT 'FULL' CHECK (track IN ('CS','SALES','FULL')),
    pass_mark       SMALLINT,                        -- NULL → level default
    is_exam         BOOLEAN NOT NULL DEFAULT FALSE,  -- mastery/level exams
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (level_id, position)
);

CREATE TABLE academy.lessons (
    id          BIGSERIAL PRIMARY KEY,
    stage_id    BIGINT NOT NULL REFERENCES academy.stages(id),
    position    SMALLINT NOT NULL,
    title       TEXT NOT NULL,
    body_html   TEXT NOT NULL,                       -- sanitised on write
    version     INT NOT NULL DEFAULT 1,
    updated_by  BIGINT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (stage_id, position)
);

-- ---------- Call library ----------
CREATE TABLE academy.call_recordings (
    id              BIGSERIAL PRIMARY KEY,
    stage_id        BIGINT REFERENCES academy.stages(id),   -- NULL = unassigned library item
    category        TEXT NOT NULL CHECK (category IN ('SALES','CUSTOMER_SERVICE','COACHING','INDUCTION')),
    title           TEXT NOT NULL,
    description     TEXT,
    s3_key          TEXT NOT NULL,                   -- streamed via short-lived signed URLs
    duration_secs   INT NOT NULL,
    transcript      TEXT,                            -- from QA transcription pipeline
    transcript_status TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (transcript_status IN ('PENDING','DONE','FAILED','NOT_REQUIRED')),
    uploaded_by     BIGINT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side proof of full listening (client beacons; gaps invalidate)
CREATE TABLE academy.listen_progress (
    trainee_id      BIGINT NOT NULL REFERENCES academy.trainees(id),
    recording_id    BIGINT NOT NULL REFERENCES academy.call_recordings(id),
    seconds_heard   INT NOT NULL DEFAULT 0,
    completed_at    TIMESTAMPTZ,
    last_beacon_at  TIMESTAMPTZ,
    PRIMARY KEY (trainee_id, recording_id)
);

-- ---------- Quizzes & question bank ----------
CREATE TABLE academy.quizzes (
    id          BIGSERIAL PRIMARY KEY,
    stage_id    BIGINT NOT NULL UNIQUE REFERENCES academy.stages(id),
    pass_mark   SMALLINT,                            -- NULL → stage/level default
    question_count SMALLINT,                         -- if set, draw N at random from pool
    shuffle     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE academy.questions (
    id              BIGSERIAL PRIMARY KEY,
    quiz_id         BIGINT NOT NULL REFERENCES academy.quizzes(id),
    recording_id    BIGINT REFERENCES academy.call_recordings(id), -- call-specific questions
    position        SMALLINT,
    prompt          TEXT NOT NULL,
    difficulty      SMALLINT NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
    source          TEXT NOT NULL DEFAULT 'HUMAN'
                    CHECK (source IN ('HUMAN','AI_GENERATED')),
    approval_state  TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (approval_state IN ('DRAFT','APPROVED','RETIRED')),
    approved_by     BIGINT,                          -- Jerusha (sales) / CS manager — required before live
    approved_at     TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_questions_need_approval
        CHECK (source = 'HUMAN' OR approval_state <> 'DRAFT' OR is_active = FALSE)
);

CREATE TABLE academy.question_options (
    id          BIGSERIAL PRIMARY KEY,
    question_id BIGINT NOT NULL REFERENCES academy.questions(id),
    position    SMALLINT NOT NULL,
    body        TEXT NOT NULL,
    is_correct  BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (question_id, position)
);

-- ---------- Progress & attempts ----------
CREATE TABLE academy.lesson_progress (
    trainee_id  BIGINT NOT NULL REFERENCES academy.trainees(id),
    lesson_id   BIGINT NOT NULL REFERENCES academy.lessons(id),
    read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (trainee_id, lesson_id)
);

CREATE TABLE academy.quiz_attempts (
    id              BIGSERIAL PRIMARY KEY,
    trainee_id      BIGINT NOT NULL REFERENCES academy.trainees(id),
    quiz_id         BIGINT NOT NULL REFERENCES academy.quizzes(id),
    attempt_number  INT NOT NULL,
    score_pct       NUMERIC(5,2) NOT NULL,
    passed          BOOLEAN NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (trainee_id, quiz_id, attempt_number)
);

CREATE TABLE academy.attempt_answers (
    attempt_id  BIGINT NOT NULL REFERENCES academy.quiz_attempts(id),
    question_id BIGINT NOT NULL REFERENCES academy.questions(id),
    option_id   BIGINT NOT NULL REFERENCES academy.question_options(id),
    is_correct  BOOLEAN NOT NULL,
    PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE academy.stage_completions (
    trainee_id  BIGINT NOT NULL REFERENCES academy.trainees(id),
    stage_id    BIGINT NOT NULL REFERENCES academy.stages(id),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    best_score  NUMERIC(5,2),
    PRIMARY KEY (trainee_id, stage_id)
);

CREATE TABLE academy.level_completions (
    trainee_id      BIGINT NOT NULL REFERENCES academy.trainees(id),
    level_id        SMALLINT NOT NULL REFERENCES academy.levels(id),
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    certificate_ref TEXT,                            -- generated PDF ref in S3
    manager_notified_at TIMESTAMPTZ,                 -- Mattermost DM on completion
    PRIMARY KEY (trainee_id, level_id)
);

-- ---------- Audit (append-only) ----------
CREATE TABLE academy.audit_events (
    id          BIGSERIAL PRIMARY KEY,
    trainee_id  BIGINT REFERENCES academy.trainees(id),
    event_type  TEXT NOT NULL,      -- LOGIN|LESSON_READ|LISTEN_COMPLETE|QUIZ_SUBMIT|STAGE_PASS|LEVEL_PASS|CERT_ISSUED|CONTENT_EDIT|...
    payload     JSONB NOT NULL DEFAULT '{}',
    actor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON academy.audit_events (trainee_id, created_at);
CREATE INDEX ON academy.audit_events (event_type, created_at);

-- ---------- Management reporting views ----------
CREATE VIEW academy.v_trainee_overview AS
SELECT t.id, t.full_name, t.email, t.track, t.department, t.status, t.started_at, t.is_disabled,
       (SELECT authorised FROM academy.progression_authorisations pa WHERE pa.trainee_id=t.id) AS stage1_authorised,
       EXISTS (SELECT 1 FROM academy.sessions ss WHERE ss.trainee_id=t.id
               AND ss.signed_out_at IS NULL AND NOT ss.revoked
               AND ss.last_seen_at > now() - INTERVAL '3 minutes') AS online_now,
       COALESCE(MAX(l.level_number) FILTER (WHERE lc.trainee_id IS NOT NULL), 0) AS highest_level_complete,
       COUNT(DISTINCT sc.stage_id) AS stages_complete,
       MAX(qa.submitted_at) AS last_activity
FROM academy.trainees t
LEFT JOIN academy.level_completions lc ON lc.trainee_id = t.id
LEFT JOIN academy.levels l ON l.id = lc.level_id
LEFT JOIN academy.stage_completions sc ON sc.trainee_id = t.id
LEFT JOIN academy.quiz_attempts qa ON qa.trainee_id = t.id
GROUP BY t.id;

CREATE VIEW academy.v_stuck_trainees AS      -- for the weekly management hopper
SELECT t.id, t.full_name, t.track, MAX(qa.submitted_at) AS last_quiz_activity,
       COUNT(*) FILTER (WHERE qa.passed = FALSE) AS recent_fails
FROM academy.trainees t
JOIN academy.quiz_attempts qa ON qa.trainee_id = t.id
WHERE t.status = 'ACTIVE'
GROUP BY t.id
HAVING MAX(qa.submitted_at) < now() - INTERVAL '5 days'
    OR COUNT(*) FILTER (WHERE qa.passed = FALSE AND qa.submitted_at > now() - INTERVAL '7 days') >= 3;

-- ---------- Seed: levels 1–5 ----------
INSERT INTO academy.levels (level_number, name, weeks_label, accomplishment, description, default_pass_mark) VALUES
 (1,'Foundation','Week 1','You are ready to start work','Induction, IRL knowledge, the claim journey, CS and sales basics, live calls and compliance.',80),
 (2,'Working Claims','Weeks 2–3','Claims Handler — you can work a case end to end','DSAR analysis, evidence building, FRLs, offers and FOS referrals.',80),
 (3,'Product Mastery','Weeks 3–4','Product Specialist — every claim type mastered','Car finance & the FCA redress scheme, overdrafts, cards and catalogue.',85),
 (4,'Gambling Harm & FOS Advocacy','Week 5','Advocate — gambling harm and FOS expert','Expert gambling harm casework and FOS advocacy.',85),
 (5,'Specialist Certification','Week 6','FAC Certified Claims Specialist','Complex estates, coaching, and the mastery exam.',90);

-- ============================================================================
-- Operational notes (BullMQ jobs reading/writing this schema):
--   academy:signin-events      → provisioning_requests/events (see provisioning spec)
--   academy:transcription      → call_recordings.transcript via QA pipeline
--   academy:question-gen       → questions (source=AI_GENERATED, DRAFT) awaiting approval
--   academy:certificates       → level_completions.certificate_ref (PDF to S3)
--   academy:manager-notify     → Mattermost DM on LEVEL_PASS / v_stuck_trainees weekly
-- Stage-gate enforcement is SERVER-SIDE: stage content beyond Stage 1 is only served
-- where progression_authorisations.authorised = TRUE. Disable is immediate: sessions
-- revoked, sign-in blocked, STAGE access 403s. Actions writing audit_events:
-- STAGE1_AUTHORISED, ACCOUNT_DISABLED, ACCOUNT_REENABLED (actor = manager id).
-- All writes mirrored to audit_events. Feature flag: ACADEMY_V2, default OFF.
-- ============================================================================
