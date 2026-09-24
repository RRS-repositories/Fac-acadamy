-- ============================================================================
-- 0007_certificates: what S09 (certificates and accomplishments) needs.
--
-- 0002 created academy.certificates back when the plan still had an S3 bucket,
-- so the column that names the file is called s3_key. Decision D15 (23 Sep)
-- removed S3: a certificate PDF is written to the same on-prem folder as the
-- media (MEDIA_ROOT), under the key academy/certs/<public_id>.pdf, and the API
-- streams it after checking the session. 0005 renamed the same column on
-- call_recordings; this file does the certificates half, and adds the facts
-- about the stored file that 0002 has no room for.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0006. The runner applies
-- this file in one transaction with search_path = academy, public; names are
-- schema-qualified anyway. Every step is written so a re-run is a no-op.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. s3_key -> media_key, the same rename 0005 did for call_recordings, and
--    guarded the same way: it runs only when the old column is still there and
--    the new one is not, so applying this file twice does nothing. Nothing in
--    0001-0006 refers to the column by name (no index, constraint or view).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'academy' AND table_name = 'certificates'
           AND column_name = 's3_key'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'academy' AND table_name = 'certificates'
           AND column_name = 'media_key'
    ) THEN
        EXECUTE 'ALTER TABLE academy.certificates RENAME COLUMN s3_key TO media_key';
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 2. What we know about the stored PDF, and who issued it.
--
--      byte_size        size on disk, for Content-Length and for spotting a
--                       truncated file without opening it
--      checksum_sha256  sha256 of the stored bytes, computed while writing
--      content_type     always application/pdf today; recorded rather than
--                       assumed, exactly as call_recordings does it
--      rendered_at      when the PDF was produced. media_key stays NULL until
--                       then, so a row with no file is a normal, visible state
--                       (the API re-renders on the next download)
--      issued_by        the audit actor that caused it: 'system' for the
--                       automatic issue on a completion, 'ops:<name>' or
--                       'manager:<id>' when a person did it
-- ---------------------------------------------------------------------------
ALTER TABLE academy.certificates
    ADD COLUMN IF NOT EXISTS byte_size       BIGINT,
    ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS content_type    TEXT,
    ADD COLUMN IF NOT EXISTS rendered_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS issued_by       TEXT;

UPDATE academy.certificates SET issued_by = 'system' WHERE issued_by IS NULL;
ALTER TABLE academy.certificates ALTER COLUMN issued_by SET DEFAULT 'system';


-- ---------------------------------------------------------------------------
-- 3. Shape checks, the same second lock 0005 put on the media columns. The API
--    refuses an unsafe key in code first (media/store.ts assertSafeKey); this
--    makes it impossible to write one from psql or from a future endpoint.
--
--    A certificate key looks like 'academy/certs/<public id>.pdf': relative,
--    forward slashes only, no '..', no leading or trailing slash, no
--    backslash, no whitespace.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.certificates DROP CONSTRAINT IF EXISTS certificates_media_key_format;
ALTER TABLE academy.certificates
    ADD CONSTRAINT certificates_media_key_format CHECK (
        media_key IS NULL
        OR (    media_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'
            AND media_key NOT LIKE '%..%'
            AND media_key NOT LIKE '%/'
            AND length(media_key) <= 512)
    );

ALTER TABLE academy.certificates DROP CONSTRAINT IF EXISTS certificates_byte_size_positive;
ALTER TABLE academy.certificates
    ADD CONSTRAINT certificates_byte_size_positive
    CHECK (byte_size IS NULL OR byte_size > 0);

ALTER TABLE academy.certificates DROP CONSTRAINT IF EXISTS certificates_checksum_format;
ALTER TABLE academy.certificates
    ADD CONSTRAINT certificates_checksum_format
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');


-- ---------------------------------------------------------------------------
-- 4. public_id is the only handle the outside world ever sees, and the public
--    verify endpoint looks it up on every request. 0002 declared the column
--    UNIQUE, which Postgres backs with an index named certificates_public_id_key
--    — but only on a database built from 0002 as written. The block below adds
--    that index if, for any reason, nothing unique covers the column, so the
--    lookup is always an index scan and a duplicate id is always impossible.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_class c   ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
         WHERE n.nspname = 'academy' AND c.relname = 'certificates'
           AND i.indisunique AND a.attname = 'public_id'
           AND i.indnatts = 1
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX certificates_public_id_key'
             || ' ON academy.certificates (public_id)';
    END IF;
END $$;

-- "My certificates" reads one trainee's rows newest first.
CREATE INDEX IF NOT EXISTS certificates_trainee_issued_idx
    ON academy.certificates (trainee_id, issued_at DESC);


-- ---------------------------------------------------------------------------
-- 5. The certificate email (S09 task 6).
--
--    No email provider has been chosen yet (there is no AWS account, so SES is
--    not a given). Until one is, the worker COMPOSES the email and records it
--    here instead of sending it: the subject, the plain-text body, the address
--    it would go to and the key of the PDF that would be attached. sent_at and
--    provider stay NULL until a provider exists and something really sends it,
--    so this table is also the backlog to send once that decision is made.
--
--    body_text is the message as composed. It holds the holder's name and the
--    wording of what they completed — the same facts as the certificate — and
--    nothing else, so it is no more sensitive than the certificate row itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy.certificate_emails (
    id              BIGSERIAL PRIMARY KEY,
    certificate_id  BIGINT NOT NULL REFERENCES academy.certificates (id),
    to_email        CITEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    -- The stored PDF that would be attached. NULL if it was not rendered.
    attachment_key  TEXT,
    composed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set only when a real provider accepted it. NULL = composed, not sent.
    sent_at         TIMESTAMPTZ,
    -- Which provider accepted it, once that decision is made.
    provider        TEXT,
    provider_ref    TEXT
);

-- One composed email per certificate: the job is retried and the producer
-- de-duplicates on the certificate id, but a unique index is the durable half.
CREATE UNIQUE INDEX IF NOT EXISTS certificate_emails_one_per_certificate
    ON academy.certificate_emails (certificate_id);

-- The backlog query once a provider is chosen: everything not sent yet.
CREATE INDEX IF NOT EXISTS certificate_emails_unsent_idx
    ON academy.certificate_emails (composed_at)
    WHERE sent_at IS NULL;


-- ---------------------------------------------------------------------------
-- Grants. 0002's grant block covered the tables that existed then; a new table
-- needs its own (README rule). certificate_emails is written once and updated
-- when a provider finally sends it, so it gets SELECT, INSERT and UPDATE but
-- not DELETE: a composed email is evidence that a certificate was announced.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        GRANT SELECT, INSERT, UPDATE ON academy.certificate_emails TO academy_app;
        GRANT USAGE, SELECT ON SEQUENCE academy.certificate_emails_id_seq TO academy_app;
    END IF;
END $$;
