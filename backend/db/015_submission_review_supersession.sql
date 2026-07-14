ALTER TABLE item_submissions
  DROP CONSTRAINT IF EXISTS item_submissions_review_state_check;

ALTER TABLE item_submissions
  ADD CONSTRAINT item_submissions_review_state_check
  CHECK (review_state IN ('pending', 'approved', 'request_more_info', 'rejected', 'superseded'));

WITH ranked_actionable AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY session_item_id
      ORDER BY created_at DESC, id DESC
    ) AS actionable_rank
  FROM item_submissions
  WHERE review_state IN ('pending', 'request_more_info')
), superseded AS (
  UPDATE item_submissions submission
  SET
    review_state = 'superseded',
    reviewed_at = COALESCE(submission.reviewed_at, now())
  FROM ranked_actionable ranked
  WHERE submission.id = ranked.id
    AND ranked.actionable_rank > 1
  RETURNING submission.id
)
UPDATE evidence_requests request
SET resolved_at = COALESCE(request.resolved_at, now())
WHERE request.submission_id IN (SELECT id FROM superseded);

CREATE UNIQUE INDEX IF NOT EXISTS item_submissions_one_actionable_per_item_idx
  ON item_submissions(session_item_id)
  WHERE review_state IN ('pending', 'request_more_info');
