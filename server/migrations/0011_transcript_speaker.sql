-- ============================================================================
-- 0011_transcript_speaker: say, in the database, that a transcript line now
-- carries WHO SAID IT.
--
-- WHY THIS IS A WHOLE FILE FOR ONE COMMENT
--
--   0010 gave call_recordings.transcript_segments its JSONB array and described
--   the shape of an element in the column's COMMENT: {"start","end","text"}.
--   Since then the pipeline learned to attribute each line to one of the two
--   people on the call, and every segment it writes may now carry a fourth key.
--   The column's own description is the first thing anybody reads when they come
--   to this table with psql and no access to the repository, so leaving it
--   describing three keys out of four would be a small lie told to exactly the
--   person least able to check it.
--
--   0010 is NOT edited to say so, although it is recent and although the change
--   is only a comment. An applied migration is never edited: the runner records
--   the sha256 of every file it applies and refuses to go on when one no longer
--   matches, which is the rule that stops two databases silently holding
--   different schemas. Editing it in place cost one broken test run to discover
--   and is the reason this file exists. Same reasoning as 0005 and 0007 fixing
--   `s3_key` forward rather than correcting 0001.
--
-- WHAT IS NOT HERE, DELIBERATELY
--
--   * No column. The speaker lives INSIDE the existing JSONB array, one key per
--     element, because it is a property of a line and not of a recording — and
--     because it is written and replaced with the rest of the line, in the same
--     UPDATE, by the same two writers.
--   * No CHECK on the new key. 0010 already declined to walk the array on every
--     write, for the same reasons: it would cost real time on a few thousand
--     elements per row and it still could not express the interesting claims.
--     The honest place for "a speaker is 'A', 'B' or absent" is the zod contract
--     the API parses through (shared/src/contracts/media.ts) and the reader in
--     server/src/media/transcriptStore.ts, which drops anything else rather than
--     put it in front of a trainee.
--   * No grant. This file creates nothing.
--
-- HOW THE SPEAKER IS WORKED OUT, since the column comment has no room for it:
-- the call recordings are true dual-channel, one person per channel, which is how
-- the telephony system records them. Measured across every audio recording held
-- on 28 Sep 2026: two channels, never identical, left/right correlation between
-- -0.0007 and +0.0013, and the two channels comparable over only 1-4% of the
-- speaking seconds. So the louder channel over a line is who said it — arithmetic
-- on energy, with no model of any kind. See ops/media/transcribe.py.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0010. Idempotent: a COMMENT
-- is a replacement, so a re-run sets the same text again.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- The shape of one element, as it now stands.
--
-- 'A' and 'B' are the LEFT and RIGHT channels, and that is the whole claim.
-- NOT 'agent' and 'client': which side the adviser sits on is a property of the
-- phone system rather than of the audio, and it is not the same on every
-- recording we hold. A transcript that confidently attributes the compliance
-- script to the client would be worse than one that declines to name anybody.
--
-- The key is ABSENT — not null — on a line nobody could attribute: the two
-- channels were comparable (both talking at once) or the line straddles the
-- handover. It is absent on EVERY line of a transcript typed in by a person, of
-- one made before any of this existed, and of one whose file turned out to be
-- mono. Missing is therefore normal and is not a fault.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN academy.call_recordings.transcript_segments IS
    'The transcript as timed lines: a JSONB array of {"start","end","text"} plus an optional "speaker" of A (the recording left channel) or B (the right), seconds from the start of the media. The speaker key is absent when nobody could tell which of the two people spoke the line, and absent on every line of a transcript that has no speakers at all. Written whole in the same UPDATE as transcript, and replaced whole by a re-transcription. NULL = no timings (a transcript typed in by hand has text and no segments, which is legal: the panel then shows the text without following along).';


-- ---------------------------------------------------------------------------
-- Nothing else changes. No column is added, no constraint is added or dropped,
-- no index is created and no privilege is granted, so there is nothing here that
-- can fail on a table with rows in it and nothing to undo.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'academy'
           AND table_name = 'call_recordings'
           AND column_name = 'transcript_segments'
    ) THEN
        RAISE EXCEPTION 'academy.call_recordings.transcript_segments does not exist: 0010_transcript_segments.sql has not been applied.';
    END IF;

    RAISE NOTICE 'transcript_segments is described as carrying an optional speaker.';
END
$$;
