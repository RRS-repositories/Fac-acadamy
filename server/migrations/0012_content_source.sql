-- ---------------------------------------------------------------------------
-- 0012: where a row's training content came from.
--
-- Until now the prototype was the only source of training content, so nothing
-- needed to say so. It is not any more: ops/seed/seed-pack-content.ts loads a
-- content pack — a module written outside the prototype, held outside this
-- repository like the prototype is, and read through its own environment
-- variable. Two sources writing into one set of tables, and no column saying
-- which row belongs to which, means the next person to read `academy.stages`
-- has no way to tell.
--
-- The seeders do NOT depend on this column. Each one already knows its own rows
-- by key (the prototype by its stage codes and positions, the pack by its own),
-- and both scope every count that way, so a database that has not had this
-- migration applied still seeds and still verifies. This column records the
-- same fact where a human — or a future tool — can see it.
--
-- WHY `content_source` AND NOT `source`
-- ------------------------------------
-- `academy.questions.source` already exists and already means something else:
-- HUMAN or AI, i.e. who WROTE the question. This column is a different axis —
-- which body of content the row belongs to — and the two are independent. A
-- pack's questions are HUMAN-written and PACK-sourced.
--
-- ADD COLUMN ... DEFAULT is rewrite-free on modern Postgres, so the backfill
-- costs nothing and every row that exists today is correctly labelled
-- PROTOTYPE, which is what it is.
--
-- We write this file. Brad applies it in production.
-- ---------------------------------------------------------------------------

ALTER TABLE academy.stages
    ADD COLUMN IF NOT EXISTS content_source TEXT NOT NULL DEFAULT 'PROTOTYPE';
ALTER TABLE academy.lessons
    ADD COLUMN IF NOT EXISTS content_source TEXT NOT NULL DEFAULT 'PROTOTYPE';
ALTER TABLE academy.questions
    ADD COLUMN IF NOT EXISTS content_source TEXT NOT NULL DEFAULT 'PROTOTYPE';

-- PROTOTYPE  ported from the prototype HTML by ops/seed/seed-content.ts
-- PACK       loaded from a content pack by ops/seed/seed-pack-content.ts
-- GENERATED  reserved for S08's drafted questions, which are identified today
--            by source = 'AI' and position IS NULL. Nothing writes it yet; it
--            is listed so those rows have somewhere truthful to go, instead of
--            being labelled PROTOTYPE by the default above.
ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_content_source_check;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_content_source_check
        CHECK (content_source IN ('PROTOTYPE', 'PACK', 'GENERATED'));

ALTER TABLE academy.lessons DROP CONSTRAINT IF EXISTS lessons_content_source_check;
ALTER TABLE academy.lessons
    ADD CONSTRAINT lessons_content_source_check
        CHECK (content_source IN ('PROTOTYPE', 'PACK', 'GENERATED'));

ALTER TABLE academy.questions DROP CONSTRAINT IF EXISTS questions_content_source_check;
ALTER TABLE academy.questions
    ADD CONSTRAINT questions_content_source_check
        CHECK (content_source IN ('PROTOTYPE', 'PACK', 'GENERATED'));

COMMENT ON COLUMN academy.stages.content_source IS
    'Which body of content this row belongs to: PROTOTYPE (the ported prototype), '
    'PACK (a content pack, held outside the repository and read through an '
    'environment variable), GENERATED (reserved for drafted questions). It records '
    'ownership; it is not a permission and nothing in the application reads it.';
COMMENT ON COLUMN academy.lessons.content_source IS
    'Which body of content this lesson belongs to. See academy.stages.content_source.';
COMMENT ON COLUMN academy.questions.content_source IS
    'Which body of content this question belongs to. Independent of questions.source, '
    'which says who wrote it (HUMAN or AI). See academy.stages.content_source.';


-- ---------------------------------------------------------------------------
-- Grants. Nothing to grant: this file creates no table, view or sequence, and a
-- new column inherits the privileges already held on the table it belongs to.
-- 0002's grant block gave academy_app SELECT, INSERT, UPDATE and DELETE on the
-- content tables. The block below only CHECKS that, and says so out loud,
-- because a column the seeders cannot write is the failure mode this migration
-- would otherwise ship — and it would ship it silently, since 0002's grant
-- block is written to skip rather than fail when the role is missing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        RAISE NOTICE 'Role academy_app does not exist: nothing to check.';
        RETURN;
    END IF;

    SELECT string_agg(t || ' ' || p, ', ' ORDER BY t || ' ' || p) INTO missing
      FROM unnest(ARRAY['academy.stages', 'academy.lessons', 'academy.questions']) AS t
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
     WHERE NOT has_table_privilege('academy_app', t, p);

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'academy_app lacks % : re-run the grant block at the end of 0002_academy_v2_alignment.sql.', missing;
    END IF;

    RAISE NOTICE 'academy_app can read and write stages, lessons and questions, content_source included.';
END
$$;
