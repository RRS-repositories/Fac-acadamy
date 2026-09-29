-- ============================================================================
-- 0009_call_summary: the one saved AI summary of what was said on a recording.
--
-- A trainee presses "Summarise" under the player; the server asks a model to
-- summarise that recording's TRANSCRIPT and stores the answer on the recording.
-- Everybody afterwards is served the stored text. So the model is called once
-- per recording, ever — not once per trainee — which is what these three
-- columns are for.
--
-- Why it lives on call_recordings and not in a table of its own: the summary is
-- a property of the recording, exactly like duration_secs or transcript. There
-- is one per recording and it is never per trainee; a separate table would add
-- a join and a second place for "is it there yet?" to disagree.
--
-- Note on the rest of the feature, because it is not obvious from the SQL:
-- nothing here creates a summary. The transcript itself does not exist yet
-- (transcript_status is 'PENDING' on every row and the transcription queue's
-- handler is still a deliberate stub), so a recording with no transcript is the
-- normal case for now and the endpoint says so in plain words rather than
-- calling a model with nothing to summarise.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0008. The runner applies
-- this file in one transaction with search_path = academy, public; every name is
-- schema-qualified anyway and every step is a no-op on a re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The three columns.
--
--      summary        the model's answer, as plain text. NULL = not generated.
--      summary_model  which model produced it, recorded rather than assumed:
--                     the configured model can change, and a summary written by
--                     a different one is not the same artefact. It is also the
--                     only way to find and clear the summaries produced by a
--                     model somebody later decides they did not want used.
--      summary_at     when it was produced.
--
--  All three nullable: "no summary yet" is a normal, permanent-looking state
--  for every recording until somebody presses the button, and for every
--  recording that has no transcript it is the only state there will ever be.
--
--  No DEFAULT on summary_at. A default now() would stamp a time on a row that
--  has no summary, and "summary_at is set" is exactly what the API and the
--  checks below use to mean "there is one".
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings
    ADD COLUMN IF NOT EXISTS summary       TEXT,
    ADD COLUMN IF NOT EXISTS summary_model TEXT,
    ADD COLUMN IF NOT EXISTS summary_at    TIMESTAMPTZ;

COMMENT ON COLUMN academy.call_recordings.summary IS
    'One saved AI summary of what was said on this call, generated from transcript once and served to everyone afterwards. NULL = never generated. Not training content: it is a convenience on top of the recording, and the recording remains the source of truth.';
COMMENT ON COLUMN academy.call_recordings.summary_model IS
    'The model that produced summary, e.g. the configured SUMMARY_MODEL_NAME. Written with the summary, so a summary can always be traced to what wrote it.';
COMMENT ON COLUMN academy.call_recordings.summary_at IS
    'When summary was produced. Set together with summary and summary_model, and never moved: the summary is written once.';


-- ---------------------------------------------------------------------------
-- 2. The three columns are written together or not at all.
--
--    The API writes them in one UPDATE, so this can only be broken from psql or
--    by a future endpoint — which is precisely what a constraint is for. A
--    summary with no model recorded could not be traced to what produced it,
--    and a summary_at with no summary would make the API report a summary it
--    cannot serve.
--
--    Written as "all three set, or all three NULL" rather than three separate
--    NOT NULLs, because the all-NULL state is the normal one.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_summary_complete;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_summary_complete CHECK (
        (summary IS NULL AND summary_model IS NULL AND summary_at IS NULL)
        OR (    summary IS NOT NULL AND btrim(summary) <> ''
            AND summary_model IS NOT NULL AND btrim(summary_model) <> ''
            AND summary_at IS NOT NULL)
    );


-- ---------------------------------------------------------------------------
-- 3. "Which recordings have a summary, and which of the ones with a transcript
--    still do not?" — the only two questions anything asks across recordings
--    (a manager report, and whoever checks how much the model has been asked
--    for). Partial, so it costs nothing while almost every row is NULL.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS call_recordings_summarised_idx
    ON academy.call_recordings (summary_at DESC)
    WHERE summary IS NOT NULL;


-- ---------------------------------------------------------------------------
-- Grants. Nothing to grant: this file creates no table and no sequence, and a
-- new column inherits the privileges already held on the table it belongs to.
-- 0002's grant block gave academy_app SELECT, INSERT, UPDATE and DELETE on
-- every table in the schema, and call_recordings is not one of the tables it
-- then revoked anything from — that was audit_events and provisioning_events
-- (append-only), the two views (read-only) and the migration ledger.
--
-- academy_app genuinely needs UPDATE here, which is new for this table: until
-- now the app only ever read call_recordings, and the rows were written by the
-- manager upload endpoint and the ops ingest script. The block below CHECKS the
-- three privileges rather than assuming them, and says so out loud, because a
-- summary column the app cannot write is the failure mode this migration would
-- otherwise ship: the button would call the model, spend the time, and then
-- fail on the save — every single press.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        RAISE NOTICE 'Role academy_app does not exist: nothing to check.';
        RETURN;
    END IF;

    SELECT string_agg(p, ', ' ORDER BY p) INTO missing
      FROM unnest(ARRAY['SELECT', 'UPDATE']) AS p
     WHERE NOT has_table_privilege('academy_app', 'academy.call_recordings', p);

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'academy_app lacks % on academy.call_recordings: re-run the grant block at the end of 0002_academy_v2_alignment.sql.', missing;
    END IF;

    RAISE NOTICE 'academy_app can read and update academy.call_recordings, including the summary columns.';
END
$$;
