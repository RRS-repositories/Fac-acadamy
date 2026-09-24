-- ============================================================================
-- 0003_seed_support: the few schema additions the S02 content seed needs.
--
-- Fix-forward on top of 0001 (never edited) and 0002. Each change says why it
-- exists. No content here: the seed (ops/seed/seed-content.ts) writes it.
--
-- The runner applies this file in one transaction with
-- search_path = academy, public. Names are schema-qualified anyway.
-- Idempotent where practical (IF NOT EXISTS / DROP ... IF EXISTS then ADD).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Department recordings need their own category (decided with the user,
--    22 Sep). 0001 declares `category ... CHECK (category IN ('SALES',
--    'CUSTOMER_SERVICE','COACHING','INDUCTION'))` as a column constraint, so
--    Postgres auto-names it call_recordings_category_check. As in 0002 (X2),
--    every single-column CHECK on `category` is dropped whatever its name,
--    then one named CHECK is added with 'DEPARTMENT' allowed.
--    Seed mapping (by the stage the recording belongs to):
--      department module                      -> DEPARTMENT
--      stage only the Customer Service side sees -> CUSTOMER_SERVICE
--      stage only the Sales side sees         -> SALES
--      every other stage (shared core, L2-L5) -> INDUCTION
-- ---------------------------------------------------------------------------
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
          AND c.conrelid = 'academy.call_recordings'::regclass
          AND array_length(c.conkey, 1) = 1
          AND a.attname = 'category'
    LOOP
        EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.nspname, r.relname, r.conname);
        RAISE NOTICE '0003: dropped CHECK % on %.%', r.conname, r.nspname, r.relname;
    END LOOP;
END
$$;

ALTER TABLE academy.call_recordings
    ADD CONSTRAINT call_recordings_category_check
    CHECK (category IN ('SALES', 'CUSTOMER_SERVICE', 'COACHING', 'INDUCTION', 'DEPARTMENT'));


-- ---------------------------------------------------------------------------
-- 2. Department academy metadata from the prototype's DEPTS. 0002 gave
--    departments a label (the track name, e.g. 'Admin') and accomplishment
--    only; the academy page also shows the academy's own name ('... Academy'),
--    its icon and a one-line description.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.departments
    ADD COLUMN IF NOT EXISTS academy_name TEXT,
    ADD COLUMN IF NOT EXISTS icon         TEXT,
    ADD COLUMN IF NOT EXISTS description  TEXT;


-- ---------------------------------------------------------------------------
-- 3. Global stage order. stages.position is the order inside a level or a
--    department; the prototype's STAGES array also has one overall order
--    (the journey rail), which nothing in 0001/0002 records. NULL allowed for
--    stages added later by hand. Deferred so a re-seed can reorder in one
--    transaction.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.stages
    ADD COLUMN IF NOT EXISTS sort SMALLINT;

ALTER TABLE academy.stages DROP CONSTRAINT IF EXISTS stages_sort_key;
ALTER TABLE academy.stages
    ADD CONSTRAINT stages_sort_key UNIQUE (sort) DEFERRABLE INITIALLY DEFERRED;


-- ---------------------------------------------------------------------------
-- 4. Idempotent question upserts. 0001 has no key on questions other than the
--    id, so a re-run of the seed could not tell "same question" from "new
--    question". The seed keys each prototype question on (quiz, position).
--    NULL positions (future AI-drafted questions) never collide.
--    Not deferrable: ON CONFLICT cannot use a deferrable constraint.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.questions DROP CONSTRAINT IF EXISTS questions_quiz_position_key;
ALTER TABLE academy.questions
    ADD CONSTRAINT questions_quiz_position_key UNIQUE (quiz_id, position);


-- ---------------------------------------------------------------------------
-- Grants: this file creates no tables, views or sequences. New columns are
-- covered by the table-level grants 0002 gave academy_app, so there is
-- nothing to grant.
-- ---------------------------------------------------------------------------
