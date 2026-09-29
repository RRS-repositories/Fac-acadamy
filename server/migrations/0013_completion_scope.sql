-- ============================================================================
-- 0013_completion_scope: what a completion COVERED, so an academy that grows
-- does not quietly un-finish the people who already finished it.
--
-- The defect (29 Sep 2026). A department academy gained a module: Admin went
-- from two modules to three, the new one inserted in the middle. Thirteen
-- people had already completed the Admin academy and hold certificates for it.
-- Nothing deletes their academy.dept_completions row — but the dashboard
-- recomputes live, so they see "2 of 3 done" and a module waiting; and if they
-- go and do it, completeDeptIfDone runs
--     INSERT INTO academy.dept_completions ... ON CONFLICT DO NOTHING
-- against a row that already exists, writes nothing, returns null, and no
-- certificate is issued. Thirteen people told they are no longer finished,
-- asked to do the work again, and given nothing for it.
--
-- The fix the user chose: when somebody completes an academy that has GROWN
-- since they finished it, they earn a NEW, current certificate. The old one
-- stays valid — it is a true record of what they did at the time.
--
-- That needs three facts the schema does not hold today:
--
--   1. how much a completion covered           -> dept_completions.modules_covered
--                                                 level_completions.stages_covered
--   2. when a completion was last brought up
--      to date, without moving completed_at    -> *.recompleted_at
--   3. how much a certificate covers, so a
--      second one can exist beside the first   -> certificates.scope_size
--
-- and the two "one certificate per trainee per level / per department" unique
-- indexes from 0002 have to become "one per trainee per level / per department
-- PER SCOPE". Nothing is deleted, nothing is revoked, and no issued
-- certificate is re-rendered: the 33 certificates already in the wild keep
-- their row, their public id, their stored PDF and their verify answer.
--
-- ORDER OF DEPLOYMENT: apply this file BEFORE the new module becomes visible
-- in academy.track_visibility. Between the module appearing and this file
-- being applied, somebody could pass it and fall into exactly the hole above,
-- and no migration can honestly mint a certificate for a completion it never
-- observed. Step 6 below counts any row in that state and says so out loud.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0012. The runner applies
-- this file in one transaction with search_path = academy, public; every name
-- is schema-qualified anyway and every step is a no-op on a re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The scope columns.
--
--    modules_covered / stages_covered
--      How many modules (a department academy) or stages (a level) the
--      completion covered. Counted over the stages the trainee's TRACK could
--      see, because that is the basis the completion rule itself uses
--      (completions.ts reads academy.track_visibility, not academy.stages):
--      a Customer Service trainee never sees s5, so their Level 1 never
--      covered it.
--
--      NULLABLE, and NULL means UNKNOWN, not zero. Rows written before this
--      column existed have no record of it; step 4 infers what it can and
--      leaves the rest NULL, and the application treats NULL as "cannot tell
--      whether this academy has grown" and does nothing. See step 4.
--
--    recompleted_at
--      When the completion was last brought up to date after the academy grew.
--      completed_at is NOT moved: it is when they first finished, and
--      rewriting it would erase the very history this migration exists to
--      keep. NULL means "never had to be".
-- ---------------------------------------------------------------------------
ALTER TABLE academy.dept_completions
    ADD COLUMN IF NOT EXISTS modules_covered SMALLINT,
    ADD COLUMN IF NOT EXISTS recompleted_at  TIMESTAMPTZ;

ALTER TABLE academy.level_completions
    ADD COLUMN IF NOT EXISTS stages_covered SMALLINT,
    ADD COLUMN IF NOT EXISTS recompleted_at TIMESTAMPTZ;

COMMENT ON COLUMN academy.dept_completions.modules_covered IS
    'How many modules of this department academy the completion covered, counted over the stages the trainee''s track could see. NULL means unknown (a row written before migration 0013 whose scope could not be inferred): the application will not re-issue on a row it cannot compare.';
COMMENT ON COLUMN academy.dept_completions.recompleted_at IS
    'When this completion was last brought up to date after the academy grew. completed_at stays at the FIRST completion and is never moved.';
COMMENT ON COLUMN academy.level_completions.stages_covered IS
    'How many stages of this level the completion covered, counted over the stages the trainee''s track could see (a track that never sees s5 never covered it). NULL means unknown — see dept_completions.modules_covered.';
COMMENT ON COLUMN academy.level_completions.recompleted_at IS
    'When this completion was last brought up to date after the level gained a stage. completed_at stays at the FIRST completion.';


-- ---------------------------------------------------------------------------
-- 2. certificates.scope_size: how much THIS certificate covers.
--
--    It is the scope of the completion it was issued for — modules for a DEPT
--    certificate, stages for a LEVEL one — copied at issue and then frozen,
--    exactly as holder_name and track_code are. It is metadata only: no
--    wording on the PDF and nothing on the public verify answer depends on it,
--    so an already-issued certificate keeps saying precisely what it said.
--
--    NULL means the same as it does on a completion row: unknown. A TRACK
--    certificate has no scope at all and keeps NULL for good.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.certificates
    ADD COLUMN IF NOT EXISTS scope_size SMALLINT;

COMMENT ON COLUMN academy.certificates.scope_size IS
    'How many modules (DEPT) or stages (LEVEL) this certificate covers, frozen at issue. It is what lets a trainee hold a certificate for the two-module academy AND one for the three-module academy at the same time, both valid. NULL = unknown, or a TRACK certificate.';


-- ---------------------------------------------------------------------------
-- 3. Shape checks. A scope is a count of things that exist, so it is either
--    unknown or at least one. Zero is never right: the completion rule refuses
--    to complete an academy with no modules in it, so a zero here would be a
--    bug wearing a plausible number.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.dept_completions DROP CONSTRAINT IF EXISTS dept_completions_modules_covered_positive;
ALTER TABLE academy.dept_completions
    ADD CONSTRAINT dept_completions_modules_covered_positive
    CHECK (modules_covered IS NULL OR modules_covered > 0);

ALTER TABLE academy.level_completions DROP CONSTRAINT IF EXISTS level_completions_stages_covered_positive;
ALTER TABLE academy.level_completions
    ADD CONSTRAINT level_completions_stages_covered_positive
    CHECK (stages_covered IS NULL OR stages_covered > 0);

ALTER TABLE academy.certificates DROP CONSTRAINT IF EXISTS certificates_scope_size_positive;
ALTER TABLE academy.certificates
    ADD CONSTRAINT certificates_scope_size_positive
    CHECK (scope_size IS NULL OR scope_size > 0);


-- ---------------------------------------------------------------------------
-- 4. Backfill — what can honestly be inferred, and what cannot.
--
--    An existing completion row holds no record of how big the academy was.
--    Guessing "it must have been however many modules there are today" would
--    be wrong for exactly the thirteen people this migration is for, and would
--    freeze their loss in place. So nothing is guessed. What IS known is this:
--
--      * a completion row is only ever written by completions.ts, and only at
--        the moment the trainee had passed EVERY module their track could see;
--      * stage_completions holds one row per module they passed, with the time
--        they passed it, and it is never rewritten on a retake (the upsert
--        keeps the original completed_at and only raises best_score);
--      * a completion and the pass that triggered it are written in the same
--        transaction, so they share now() exactly.
--
--    Therefore: the number of modules of that department the trainee had
--    passed AT OR BEFORE the completion's own timestamp IS the number of
--    modules the academy had when they finished it. That is a derivation from
--    rows we hold, not an assumption about the past. A module added later has
--    a later pass (or no pass) and is correctly excluded.
--
--    Counted over academy.stages.dept / .level_id rather than over
--    track_visibility on purpose: it asks what THIS trainee passed, so it
--    stays right if the track lists have been edited since, or if the trainee
--    has since changed track, or has no track at all today (D13).
--
--    What cannot be inferred: a completion row with no qualifying stage pass
--    behind it — a row inserted by hand, or imported. There is nothing
--    truthful to put in the column, so it stays NULL and step 6 counts it.
-- ---------------------------------------------------------------------------
UPDATE academy.dept_completions dc
   SET modules_covered = covered.n
  FROM (
      SELECT d.trainee_id, d.dept, count(*)::int AS n
        FROM academy.dept_completions d
        JOIN academy.stage_completions sc ON sc.trainee_id = d.trainee_id
        JOIN academy.stages s             ON s.id = sc.stage_id AND s.dept = d.dept
       WHERE sc.completed_at <= d.completed_at
       GROUP BY d.trainee_id, d.dept
  ) AS covered
 WHERE dc.trainee_id = covered.trainee_id
   AND dc.dept       = covered.dept
   AND dc.modules_covered IS NULL;

UPDATE academy.level_completions lc
   SET stages_covered = covered.n
  FROM (
      SELECT l.trainee_id, l.level_id, count(*)::int AS n
        FROM academy.level_completions l
        JOIN academy.stage_completions sc ON sc.trainee_id = l.trainee_id
        JOIN academy.stages s             ON s.id = sc.stage_id AND s.level_id = l.level_id
       WHERE sc.completed_at <= l.completed_at
       GROUP BY l.trainee_id, l.level_id
  ) AS covered
 WHERE lc.trainee_id = covered.trainee_id
   AND lc.level_id   = covered.level_id
   AND lc.stages_covered IS NULL;


-- ---------------------------------------------------------------------------
-- 5. Backfill the certificates from their completion rows.
--
--    This has to happen, and it has to happen here, because the application
--    looks a certificate up by (trainee, target, scope). A DEPT certificate
--    left at NULL beside a completion row that says 2 would not be found, and
--    the next issue would mint a DUPLICATE certificate for work already
--    certified. Copying the completion's scope onto the certificate is what
--    keeps the existing ones addressable.
--
--    It writes one metadata column and nothing else: no public id, no
--    issued_at, no holder name, no media key, no revocation. Every existing
--    certificate keeps its stored PDF byte-for-byte and keeps answering the
--    public verify endpoint exactly as it did before this file ran.
--
--    A certificate with no completion row behind it (issued by hand) has
--    nothing to copy and stays NULL, which is still addressable: the
--    application looks up NULL scope with IS NOT DISTINCT FROM, and the unique
--    indexes in step 7 treat NULLs as equal for the same reason.
-- ---------------------------------------------------------------------------
UPDATE academy.certificates c
   SET scope_size = dc.modules_covered
  FROM academy.dept_completions dc
 WHERE c.kind = 'DEPT'
   AND c.scope_size IS NULL
   AND dc.trainee_id = c.trainee_id
   AND dc.dept       = c.dept
   AND dc.modules_covered IS NOT NULL;

UPDATE academy.certificates c
   SET scope_size = lc.stages_covered
  FROM academy.level_completions lc
 WHERE c.kind = 'LEVEL'
   AND c.scope_size IS NULL
   AND lc.trainee_id = c.trainee_id
   AND lc.level_id   = c.level_id
   AND lc.stages_covered IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 6. Say out loud what the backfill could not work out, and what it found
--    already behind.
--
--    Two different things, and both matter to whoever applies this:
--
--      unknown  a completion whose scope could not be inferred. The
--               application will not re-issue on one of these, because it
--               cannot tell a grown academy from an unchanged one. Zero is the
--               expected answer.
--      behind   a completion whose trainee has SINCE passed more modules of
--               that academy than the completion covers. That is the
--               deployment window in the header: the module went live before
--               this file did. These people are owed a current certificate and
--               this file cannot mint one — the application issues it the next
--               time the completion rule runs for them (any passing attempt on
--               a module of that academy, including a retake). Zero is the
--               expected answer.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    dept_unknown  BIGINT;
    level_unknown BIGINT;
    dept_behind   BIGINT;
    level_behind  BIGINT;
BEGIN
    SELECT count(*) INTO dept_unknown
      FROM academy.dept_completions WHERE modules_covered IS NULL;
    SELECT count(*) INTO level_unknown
      FROM academy.level_completions WHERE stages_covered IS NULL;

    SELECT count(*) INTO dept_behind
      FROM academy.dept_completions d
     WHERE d.modules_covered IS NOT NULL
       AND d.modules_covered < (
           SELECT count(*)
             FROM academy.stage_completions sc
             JOIN academy.stages s ON s.id = sc.stage_id AND s.dept = d.dept
            WHERE sc.trainee_id = d.trainee_id);

    SELECT count(*) INTO level_behind
      FROM academy.level_completions l
     WHERE l.stages_covered IS NOT NULL
       AND l.stages_covered < (
           SELECT count(*)
             FROM academy.stage_completions sc
             JOIN academy.stages s ON s.id = sc.stage_id AND s.level_id = l.level_id
            WHERE sc.trainee_id = l.trainee_id);

    RAISE NOTICE 'Completion scope backfilled. Unknown scope: % department, % level completion(s).',
        dept_unknown, level_unknown;

    IF dept_unknown > 0 OR level_unknown > 0 THEN
        RAISE NOTICE 'Those rows have no qualifying stage pass behind them, so no scope could be inferred; the academy will not re-issue a certificate on them. List them with: SELECT trainee_id, dept FROM academy.dept_completions WHERE modules_covered IS NULL;';
    END IF;

    IF dept_behind > 0 OR level_behind > 0 THEN
        RAISE NOTICE 'ALREADY BEHIND: % department and % level completion(s) cover less than the trainee has since passed. Their new certificate is issued on their next passing attempt in that academy (a retake counts).',
            dept_behind, level_behind;
    END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- 7. One certificate per trainee per target PER SCOPE.
--
--    0002 created certificates_one_per_level and certificates_one_per_dept.
--    They are the reason a grown academy can never be certified twice, so they
--    have to widen — but widening a uniqueness rule must never be able to
--    strand an existing row, so the new index is CREATED FIRST. If two rows
--    somehow collide under the new key, the CREATE fails, the whole migration
--    rolls back in its transaction, and the old indexes are still there,
--    untouched. Only once the new index exists is the old one dropped.
--
--    NULLS NOT DISTINCT (PostgreSQL 15+; production is 17) so that two
--    unknown-scope certificates for the same target still collide, which is
--    what the application's IS NOT DISTINCT FROM lookup expects. Without it,
--    every NULL would be unique and an unknown-scope certificate could be
--    minted over and over.
--
--    certificates_one_per_track is left exactly as it was: a TRACK award has
--    no scope.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_per_level_scope
    ON academy.certificates (trainee_id, level_id, scope_size) NULLS NOT DISTINCT
    WHERE kind = 'LEVEL';

CREATE UNIQUE INDEX IF NOT EXISTS certificates_one_per_dept_scope
    ON academy.certificates (trainee_id, dept, scope_size) NULLS NOT DISTINCT
    WHERE kind = 'DEPT';

DROP INDEX IF EXISTS academy.certificates_one_per_level;
DROP INDEX IF EXISTS academy.certificates_one_per_dept;


-- ---------------------------------------------------------------------------
-- Grants. This file creates no table and no sequence, and a new column
-- inherits the privileges already held on the table it belongs to, so there is
-- nothing to grant (README rule: a migration that creates a table grants for
-- it). What there IS to do is check, the way 0008 does, because the failure
-- this migration would otherwise ship is a column the application cannot
-- write: dept_completions and level_completions are now UPDATEd (the scope
-- moving up when an academy grows), and certificates are INSERTed a second
-- time for the same target. 0002 granted SELECT, INSERT, UPDATE and DELETE on
-- every table in the schema and revoked nothing from these three, so all three
-- should already be there.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    tbl     TEXT;
    missing TEXT;
    faults  TEXT := '';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
        RAISE NOTICE 'Role academy_app does not exist: nothing to check.';
        RETURN;
    END IF;

    FOREACH tbl IN ARRAY ARRAY[
        'academy.dept_completions',
        'academy.level_completions',
        'academy.certificates'
    ] LOOP
        SELECT string_agg(p, ', ' ORDER BY p) INTO missing
          FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
         WHERE NOT has_table_privilege('academy_app', tbl, p);

        IF missing IS NOT NULL THEN
            faults := faults || format('%s lacks %s; ', tbl, missing);
        END IF;
    END LOOP;

    IF faults <> '' THEN
        RAISE EXCEPTION 'academy_app is missing privileges: %Re-run the grant block at the end of 0002_academy_v2_alignment.sql.', faults;
    END IF;

    RAISE NOTICE 'academy_app can read, insert and update completions and certificates, including the new scope columns.';
END
$$;
