-- ============================================================================
-- 0005_media: on-prem media storage (decision D15, 23 Sep 2026).
--
-- There is no S3. Production is the on-prem server and every recording and the
-- FOS video live in a folder on its own disk (MEDIA_ROOT), outside the repo and
-- outside anything nginx serves. The API streams each byte itself, after it has
-- checked the session and run gate(); there are no signed URLs and no AWS SDK.
--
-- So the column that names the file is no longer an S3 key, and this file
-- renames it (D16) and adds the facts the streaming endpoint and the upload
-- script need about the file on disk.
--
-- Fix-forward on top of 0001 (never edited), 0002, 0003 and 0004. The runner
-- applies this file in one transaction with search_path = academy, public;
-- names are schema-qualified anyway. Every step is written so a re-run is a
-- no-op (the rename is guarded by a catalogue lookup).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. s3_key -> media_key (D16). Guarded both ways: the rename runs only when
--    the old column is still there and the new one is not, so applying this
--    file twice, or to a database that already has media_key, does nothing.
--    Nothing else depends on the name: no CHECK constraint, index or view in
--    0001-0004 mentions s3_key, and a view would follow a rename anyway
--    (Postgres stores column references by number, not by name).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'academy' AND table_name = 'call_recordings'
           AND column_name = 's3_key'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'academy' AND table_name = 'call_recordings'
           AND column_name = 'media_key'
    ) THEN
        EXECUTE 'ALTER TABLE academy.call_recordings RENAME COLUMN s3_key TO media_key';
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 2. What we know about the file on disk. All nullable, because D4 says an
--    empty "coming soon" slot is a normal row: media_key, duration_secs and
--    every column below stay NULL until a file is uploaded, and the quiz gate
--    counts only rows WHERE media_key IS NOT NULL.
--
--      byte_size       size on disk, used for Content-Length and Range maths
--      content_type    the type the API serves; set at upload from the file
--                      itself, never guessed from the name at stream time
--      checksum_sha256 sha256 of the stored bytes, computed while writing;
--                      proves an upload landed intact and spots a swapped file
--      uploaded_by     already exists from 0001 (BIGINT); named here so the
--                      set of upload columns reads as one block
--      uploaded_at     when the file landed (created_at is when the slot was)
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings
    ADD COLUMN IF NOT EXISTS byte_size       BIGINT,
    ADD COLUMN IF NOT EXISTS content_type    TEXT,
    ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS uploaded_by     BIGINT,
    ADD COLUMN IF NOT EXISTS uploaded_at     TIMESTAMPTZ;


-- ---------------------------------------------------------------------------
-- 3. Shape checks. The API refuses an unsafe key in code as well (media/store.ts
--    assertSafeKey); this is the second lock, so a bad key cannot be written by
--    a script, by psql or by a future endpoint.
--
--    A key looks like 'academy/media/<file>': relative, forward slashes only,
--    no '..' anywhere, no leading or trailing slash, no backslash, no colon
--    (so no drive letter) and no whitespace. Upper case is allowed because the
--    seeded keys carry the prototype's own file names, e.g. CS_2_UTL.mp3.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_media_key_format;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_media_key_format CHECK (
        media_key IS NULL
        OR (    media_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'
            AND media_key NOT LIKE '%..%'
            AND media_key NOT LIKE '%/'
            AND length(media_key) <= 512)
    );

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_byte_size_positive;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_byte_size_positive
    CHECK (byte_size IS NULL OR byte_size > 0);

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_checksum_format;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_checksum_format
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_content_type_format;
ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_content_type_format CHECK (
        content_type IS NULL
        OR content_type ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$'
    );

-- Deliberately NOT added: a NOT NULL or "all-or-nothing" constraint tying
-- media_key to byte_size/content_type. The seed writes the key (S02) and the
-- upload script fills the file facts afterwards (S06 M3), so a row is briefly
-- half-filled on purpose. The stream endpoint reads the size from disk, so a
-- missing byte_size never serves a wrong Content-Length.


-- ---------------------------------------------------------------------------
-- 4. The gate and the stage screen both count "recordings with media" per
--    stage. A partial index keeps that a lookup rather than a scan as the
--    library grows, and it is the same predicate both queries use.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS call_recordings_with_media_idx
    ON academy.call_recordings (stage_id)
    WHERE media_key IS NOT NULL AND is_active;


-- ---------------------------------------------------------------------------
-- Grants: this file creates no table, view or sequence. The new columns, the
-- constraints and the index are covered by the table-level grants 0002 gave
-- academy_app, so there is nothing to grant.
--
-- Note for whoever takes backups: from now on the database alone does NOT hold
-- the media. The MEDIA_ROOT folder must be backed up too (D15).
-- ---------------------------------------------------------------------------
