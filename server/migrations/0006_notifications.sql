-- ============================================================================
-- 0006_notifications: the durable marker that makes "3 fails → ONE message"
-- true across restarts (Section 08, checklist "3 consecutive fails on one
-- stage → one manager DM (not three)").
--
-- BullMQ is at-least-once: a worker killed mid-job, a retried job, or a third
-- and a fourth failed attempt landing at the same moment would all compose the
-- same message again. An in-memory guard would forget everything on restart,
-- and a jobId only de-duplicates one job, not "this notification, ever".
--
-- So the rule is decided by a UNIQUE key in the database: the handler tries to
-- INSERT (kind, trainee_id, ref) and only composes a message when the insert
-- actually happened. Two handlers racing produce one row and one message.
--
-- Fix-forward on top of 0001-0005. Applied in one transaction with
-- search_path = academy, public; every name is schema-qualified anyway and
-- every step is a no-op on a re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. notifications_sent.
--
--    kind       what the message was:
--                 'LEVEL_COMPLETE'  "<name> is ready to start work — <track>"
--                 'DEPT_COMPLETE'   department academy finished
--                 'STAGE_FAIL_STREAK' three fails on one stage
--                 'ACCOUNT_DISABLED' / 'ACCOUNT_ENABLED'  the IT-facing note
--    trainee_id who it was about (NOT who it went to: recipients can change,
--               and the marker must stay stable if they do).
--    ref        which one of that kind: the level number, the department code,
--               the stage id, or the account-change event id. Text, because it
--               is only ever compared for equality.
--    sent_at    when the marker was claimed, which is when the message was
--               composed.
--    mode       which delivery mode was in force ('shadow' until an email
--               provider is chosen), so a later audit can tell a recorded
--               message from a delivered one.
--
--    No message body and no recipient address is stored here: the body is
--    composed from the database each time, and audit_events already holds the
--    record of what was composed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy.notifications_sent (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT   NOT NULL,
    trainee_id  BIGINT NOT NULL REFERENCES academy.trainees(id),
    ref         TEXT   NOT NULL,
    mode        TEXT   NOT NULL DEFAULT 'shadow',
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, trainee_id, ref)
);

COMMENT ON TABLE academy.notifications_sent IS
    'One row per notification that has been composed. The UNIQUE key is the exactly-once guard: the handler inserts first and only sends when the insert wrote a row.';

-- "Everything we have told this manager about this trainee", the query the
-- roster and any future digest want.
CREATE INDEX IF NOT EXISTS notifications_sent_trainee_idx
    ON academy.notifications_sent (trainee_id, sent_at DESC);


-- ---------------------------------------------------------------------------
-- 2. Grants. academy_app inserts and reads its own markers. UPDATE is refused:
--    a marker is a fact about the past. DELETE is allowed on purpose — the one
--    legitimate operation is "let this notification be composed again", which
--    is deleting the marker.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        RAISE NOTICE 'Role academy_app does not exist: grants skipped.';
        RETURN;
    END IF;

    GRANT SELECT, INSERT, DELETE ON academy.notifications_sent TO academy_app;
    REVOKE UPDATE ON academy.notifications_sent FROM academy_app;
    GRANT USAGE, SELECT ON SEQUENCE academy.notifications_sent_id_seq TO academy_app;

    RAISE NOTICE 'Grants for academy.notifications_sent applied.';
END
$$;
