-- ============================================================================
-- 0008_listen_budget: when a listen STARTED, so the wall-clock budget that
-- proves a full listen can be measured over the whole listen instead of one
-- beacon at a time (S06, decision D4; the defect found on 25 Sep 2026).
--
-- The rule has always been "media time credited may never exceed the wall-clock
-- time that passed while it was credited". It was enforced per beacon: a beacon
-- could buy at most the seconds since the PREVIOUS beacon, and any unspent
-- remainder was forfeited at the beacon boundary. Against a cheat that is the
-- same rule — the per-beacon gaps add up to the time since the first beacon —
-- but against an honest listen it is not: a beacon that fires a few
-- milliseconds early, a slow request or a throttled tab makes one beacon's
-- media advance a little more than the gap it is measured against, the excess
-- was trimmed off the end, and the shortfalls added up until they were bigger
-- than the jitter tolerance. Two trainees' full listens were credited about
-- half, and their stage quizzes stayed locked.
--
-- Measuring from the FIRST beacon instead lets the wobble cancel out, and that
-- needs the first beacon's time. last_beacon_at cannot stand in for it: it
-- moves on every beacon, and it is also what the management views report as
-- "last activity", so it must go on meaning exactly that.
--
-- Fix-forward on top of 0001 (never edited) and 0002-0007. The runner applies
-- this file in one transaction with search_path = academy, public; every name is
-- schema-qualified anyway and every step is a no-op on a re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. first_beacon_at: when the first beacon for this (trainee, recording) was
--    accepted. Written once, with COALESCE, and never moved afterwards — if it
--    could be pushed forward, the budget anchored on it could be too.
--
--    Nullable, because a row can only exist if a beacon has been accepted, and
--    the application treats NULL as "no beacon yet" (which grants the one-off
--    first-beacon allowance and nothing more). No DEFAULT now(): a default
--    would quietly stamp the CURRENT time on any row inserted without the
--    column, which for this column is a free budget reset.
-- ---------------------------------------------------------------------------
ALTER TABLE academy.listen_progress
    ADD COLUMN IF NOT EXISTS first_beacon_at TIMESTAMPTZ;

COMMENT ON COLUMN academy.listen_progress.first_beacon_at IS
    'When the first beacon for this recording was accepted. The cumulative wall-clock budget for the listen is measured from here, so it is set once and never moved. NULL only before the first beacon.';


-- ---------------------------------------------------------------------------
-- 2. Backfill. Rows written before this column existed have no record of when
--    their listen began, so the honest reading of what we know is "no earlier
--    than the last beacon we saw" — that gives those listens no budget they
--    have not already been granted under the old per-beacon rule, and the next
--    beacon carries on from there. Only rows that have beaconed are touched.
-- ---------------------------------------------------------------------------
UPDATE academy.listen_progress
   SET first_beacon_at = last_beacon_at
 WHERE first_beacon_at IS NULL
   AND last_beacon_at IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 3. No CHECK on the ordering of the two timestamps, on purpose.
--
--    "first_beacon_at <= last_beacon_at" reads like a free safety net, but
--    last_beacon_at is written from the server's clock on every beacon, and a
--    clock that steps backwards (an NTP correction on a VM, a host resume) would
--    then make every beacon for that row raise a check violation and roll its
--    transaction back — a trainee unable to listen at all, in exchange for
--    guarding against nothing the application can do. What actually keeps
--    first_beacon_at still is the COALESCE in the upsert that writes it, and the
--    budget clamps a negative elapsed time to zero regardless.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Grants. Nothing to grant: this file creates no table and no sequence, and a
-- new column inherits the privileges already held on the table it belongs to.
-- 0002's grant block gave academy_app SELECT, INSERT, UPDATE and DELETE on
-- every table in the schema, and listen_progress is not one of the tables it
-- then revoked anything from (that was audit_events, provisioning_events, the
-- views and the migration ledger) — it is a live progress row, updated by every
-- beacon, so it keeps UPDATE. The block below only checks that, and says so out
-- loud, because a column that cannot be written is the failure mode this
-- migration would otherwise ship.
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
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p
     WHERE NOT has_table_privilege('academy_app', 'academy.listen_progress', p);

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'academy_app lacks % on academy.listen_progress: re-run the grant block at the end of 0002_academy_v2_alignment.sql.', missing;
    END IF;

    RAISE NOTICE 'academy_app can read and write academy.listen_progress, including first_beacon_at.';
END
$$;
