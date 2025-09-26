-- Manual migration: add student_id ownership scope to student-specific tables
-- Target: PostgreSQL 15+
-- Usage: Run in DBeaver (or psql) as a single script. Requires privileges to ALTER tables.
-- Safe to run multiple times (uses IF NOT EXISTS guards). Will fail if backfill cannot determine student_id.

BEGIN;

-- 0) Optional safety: ensure we're on the expected schema
-- SET search_path = public;

-- 1) question_response --------------------------------------------------------
ALTER TABLE IF EXISTS question_response
  ADD COLUMN IF NOT EXISTS student_id BIGINT;

UPDATE question_response qr
SET student_id = sa.student_id
FROM student_assessment sa
WHERE sa.id = qr.student_assessment_id
  AND qr.student_id IS NULL;

DO $$
DECLARE x BIGINT;
BEGIN
  SELECT COUNT(*) INTO x FROM question_response WHERE student_id IS NULL;
  IF x > 0 THEN
    RAISE EXCEPTION 'Backfill failed for question_response.student_id: % rows still NULL', x;
  END IF;
END $$;

ALTER TABLE IF EXISTS question_response
  ALTER COLUMN student_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qr_student_id ON question_response(student_id);
CREATE INDEX IF NOT EXISTS idx_qr_student_assessment ON question_response(student_assessment_id);


-- 2) student_attribute_score --------------------------------------------------
ALTER TABLE IF EXISTS student_attribute_score
  ADD COLUMN IF NOT EXISTS student_id BIGINT;

UPDATE student_attribute_score sas
SET student_id = sa.student_id
FROM student_assessment sa
WHERE sa.id = sas.student_assessment_id
  AND sas.student_id IS NULL;

DO $$
DECLARE x BIGINT;
BEGIN
  SELECT COUNT(*) INTO x FROM student_attribute_score WHERE student_id IS NULL;
  IF x > 0 THEN
    RAISE EXCEPTION 'Backfill failed for student_attribute_score.student_id: % rows still NULL', x;
  END IF;
END $$;

ALTER TABLE IF EXISTS student_attribute_score
  ALTER COLUMN student_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sas_student_id ON student_attribute_score(student_id);


-- 3) game_save ----------------------------------------------------------------
ALTER TABLE IF EXISTS game_save
  ADD COLUMN IF NOT EXISTS student_id BIGINT;

UPDATE game_save gs
SET student_id = sa.student_id
FROM student_assessment sa
WHERE sa.id = gs.assessment_id
  AND gs.student_id IS NULL;

DO $$
DECLARE x BIGINT;
BEGIN
  SELECT COUNT(*) INTO x FROM game_save WHERE student_id IS NULL;
  IF x > 0 THEN
    RAISE EXCEPTION 'Backfill failed for game_save.student_id: % rows still NULL', x;
  END IF;
END $$;

ALTER TABLE IF EXISTS game_save
  ALTER COLUMN student_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_save_student_id ON game_save(student_id);


-- 4) game_save_history --------------------------------------------------------
ALTER TABLE IF EXISTS game_save_history
  ADD COLUMN IF NOT EXISTS student_id BIGINT;

UPDATE game_save_history gsh
SET student_id = sa.student_id
FROM game_save gs
JOIN student_assessment sa ON sa.id = gs.assessment_id
WHERE gs.id = gsh.game_save_id
  AND gsh.student_id IS NULL;

DO $$
DECLARE x BIGINT;
BEGIN
  SELECT COUNT(*) INTO x FROM game_save_history WHERE student_id IS NULL;
  IF x > 0 THEN
    RAISE EXCEPTION 'Backfill failed for game_save_history.student_id: % rows still NULL', x;
  END IF;
END $$;

ALTER TABLE IF EXISTS game_save_history
  ALTER COLUMN student_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gsh_student_id ON game_save_history(student_id);


-- 5) career_match -------------------------------------------------------------
ALTER TABLE IF EXISTS career_match
  ADD COLUMN IF NOT EXISTS student_id BIGINT;

UPDATE career_match cm
SET student_id = sa.student_id
FROM student_assessment sa
WHERE sa.id = cm.student_assessment_id
  AND cm.student_id IS NULL;

DO $$
DECLARE x BIGINT;
BEGIN
  SELECT COUNT(*) INTO x FROM career_match WHERE student_id IS NULL;
  IF x > 0 THEN
    RAISE EXCEPTION 'Backfill failed for career_match.student_id: % rows still NULL', x;
  END IF;
END $$;

ALTER TABLE IF EXISTS career_match
  ALTER COLUMN student_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_career_match_student_id ON career_match(student_id);
CREATE INDEX IF NOT EXISTS idx_career_match_assessment ON career_match(student_assessment_id);
CREATE INDEX IF NOT EXISTS idx_career_match_score ON career_match(student_assessment_id, match_score DESC);


-- Optional hardening (uncomment if desired): enforce one active assessment per student/template
-- CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_assessment_per_student
--   ON student_assessment(student_id, career_assessment_id)
--   WHERE end_date IS NULL;

COMMIT;


