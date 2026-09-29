-- ============================================================================
-- 0010_transcript_segments: the timed lines of a transcript, so the panel under
-- the player can highlight the line that is being spoken.
--
-- 0001 already gave call_recordings a `transcript` (TEXT) and a
-- `transcript_status` ('PENDING' | 'DONE' | 'FAILED' | 'NOT_REQUIRED'), and
-- every recording ever ingested queued a transcription job against them. What
-- was missing is TIME: a wall of text cannot be followed along to audio.
--
-- faster-whisper answers with segments — a start second, an end second and the
-- words said between them. This migration is where those land.
--
-- WHY ONE JSONB COLUMN, AND NOT A TABLE OF SEGMENTS
--
--   The segments are not entities. Nothing joins to one, nothing points at one,
--   nobody updates one, and there is no query anywhere that wants some of them:
--   the panel reads every segment of one recording at once, in order, and that
--   is the only read there will ever be. A transcript_segments table would add a
--   join, a second place for "is it transcribed yet?" to disagree, and a few
--   thousand rows per recording, in exchange for nothing anybody asked for.
--
--   They are also written and replaced as ONE unit. A re-transcription (a better
--   model, a repaired file) replaces the whole list; there is no such thing as
--   editing segment 14. A single value that is written whole is exactly what a
--   JSONB column is, and it is written in the same UPDATE as `transcript`, so
--   the text and its timings can never be half-replaced.
--
--   JSONB rather than JSON: it is the type Postgres can actually look inside, so
--   the CHECK below can insist on an array, and a later "find the call where
--   somebody explains a loan chain" has something to work with. The ordering and
--   whitespace JSON would preserve are of no value here.
--
-- WHY NOT REUSE `transcript` WITH A STRUCTURED SHAPE (the plan's other option)
--
--   Because the summary feature already reads `transcript` as plain text and
--   sends it to a model, and because `transcript IS NOT NULL AND btrim(...) <> ''`
--   is what three places already use to mean "there is something to work with".
--   Turning that column into JSON would silently change all of it: the model
--   would be handed a wall of JSON to summarise, and the check would pass on a
--   literal '[]'. Plain text stays plain text; the timings go beside it.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0009. The runner applies
-- this file in one transaction with search_path = academy, public; every name is
-- schema-qualified anyway and every step is a no-op on a re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The three columns.
--
--      transcript_segments  the timed lines, as a JSONB array:
--                             [{"start": 0.0, "end": 4.32, "text": "…"}, …]
--                           `start` and `end` are seconds from the start of the
--                           media, as fractions — the same unit and the same
--                           origin as listen_progress.coverage and as the
--                           player's own currentTime, so no arithmetic is needed
--                           anywhere to line the two up.
--      transcript_engine    what produced the transcript, recorded rather than
--                           assumed. Which Whisper model ships is still being
--                           decided (small, base or medium — the plan says to
--                           judge it from a real transcript), so the day will
--                           come when somebody needs to find and redo every
--                           transcript made by the one they settled against.
--                           Without this column that question has no answer.
--                           This is the same reasoning as 0009's summary_model.
--      transcript_at        when it was produced.
--
--  All three nullable. "Not transcribed yet" is the normal state of every row
--  today, and for a recording nobody ever transcribes it is the only state there
--  will be. No DEFAULT on transcript_at: a default now() would stamp a time on a
--  row that has no transcript, and the point of the column is to say when the
--  text arrived.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings
    ADD COLUMN IF NOT EXISTS transcript_segments JSONB,
    ADD COLUMN IF NOT EXISTS transcript_engine   TEXT,
    ADD COLUMN IF NOT EXISTS transcript_at       TIMESTAMPTZ;

COMMENT ON COLUMN academy.call_recordings.transcript_segments IS
    'The transcript as timed lines: a JSONB array of {"start","end","text"}, seconds from the start of the media. Written whole in the same UPDATE as transcript, and replaced whole by a re-transcription. NULL = no timings (a transcript typed in by hand has text and no segments, which is legal: the panel then shows the text without following along).';
COMMENT ON COLUMN academy.call_recordings.transcript_engine IS
    'What produced the transcript, e.g. the configured faster-whisper model name. Written with the transcript so any transcript can be traced to what wrote it, and so the ones made by a model we later reject can be found.';
COMMENT ON COLUMN academy.call_recordings.transcript_at IS
    'When the transcript was produced. Set together with transcript and transcript_segments.';


-- ---------------------------------------------------------------------------
-- 2. Segments are an array, and never timings with no words.
--
--    Two separate claims, both of them things the API relies on and neither of
--    them enforceable in the application alone (a backfill from psql, or a
--    second pipeline written next year, would not go through it):
--
--      * jsonb_typeof = 'array' — the client iterates it. An object or a bare
--        string stored here would be a client-side crash under the player,
--        which is the last place in this app that may ever break.
--      * there is text to go with them. Timings without a transcript are
--        meaningless, and every reader in the codebase asks "is there a
--        transcript?" by looking at the TEXT. Segments that outlived their text
--        would be a panel with lines in it and nothing to say.
--
--    Deliberately NOT enforced here: the shape of each element. A CHECK that
--    walked the array on every write would cost real time on a few thousand
--    elements, it cannot express "start <= end" without a subquery anyway, and
--    the honest place for that claim is the zod contract the API parses through
--    plus the tests. The two claims above are the ones a broken write could not
--    recover from.
--
--    The reverse — text with NO segments — is legal on purpose. Recording 50 in
--    the development database has a hand-written transcript and no timings, and
--    a transcript pasted in by a human always will; the panel says plainly that
--    it cannot follow along rather than inventing times to highlight.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_transcript_segments_shape;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_transcript_segments_shape CHECK (
        transcript_segments IS NULL
        OR (    jsonb_typeof(transcript_segments) = 'array'
            AND transcript IS NOT NULL
            AND btrim(transcript) <> '')
    );


-- ---------------------------------------------------------------------------
-- 3. No index, on purpose.
--
--    The one query that reads across recordings is the backlog script's
--    "transcript_status = 'PENDING' AND media_type = 'AUDIO'". That runs a
--    handful of times ever, on a table that holds 20 rows today and will hold a
--    few hundred after years of a manifest being worked through one file at a
--    time. Postgres will sequentially scan a table that size whatever we build,
--    and an index on it would be a line in a migration that exists to look
--    thorough. 0009's index earns its keep because it is partial on a column
--    that is NULL on almost every row and is read by a report; this is not that.
--
--    Nothing else queries the new columns across rows: the panel and the summary
--    both fetch one recording by primary key.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Grants. Nothing to grant: this file creates no table and no sequence, and a
-- new column inherits the privileges already held on the table it belongs to.
-- 0002's grant block gave academy_app SELECT, INSERT, UPDATE and DELETE on every
-- table in the schema, and call_recordings is not one of the tables it then
-- revoked anything from — that was audit_events and provisioning_events
-- (append-only), the two views (read-only) and the migration ledger.
--
-- academy_app needs SELECT to serve the panel and UPDATE to write a transcript,
-- because unlike the backlog script (which connects as an owner/admin login from
-- a developer's machine) the queue handler in the worker runs as academy_app.
-- The block below CHECKS those two rather than assuming them, exactly as 0009
-- does, and says so out loud: a transcript column the worker cannot write is the
-- failure mode this migration would otherwise ship — half an hour of CPU spent
-- on a recording and then a permission error on the save, on every job, for ever.
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

    RAISE NOTICE 'academy_app can read and update academy.call_recordings, including the transcript columns.';
END
$$;
