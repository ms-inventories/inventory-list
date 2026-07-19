ALTER TABLE item_submissions
  DROP CONSTRAINT IF EXISTS item_submissions_review_state_check;

ALTER TABLE item_submissions
  ADD COLUMN IF NOT EXISTS review_return_route text,
  ADD COLUMN IF NOT EXISTS withdrawn_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD CONSTRAINT item_submissions_review_state_check
    CHECK (review_state IN (
      'pending',
      'approved',
      'request_more_info',
      'rejected',
      'superseded',
      'withdrawn'
    )),
  ADD CONSTRAINT item_submissions_review_return_route_check
    CHECK (review_return_route IS NULL OR review_return_route IN ('submitter', 'unassigned')),
  ADD CONSTRAINT item_submissions_withdrawal_check
    CHECK (
      (review_state = 'withdrawn' AND withdrawn_at IS NOT NULL)
      OR (review_state <> 'withdrawn' AND withdrawn_at IS NULL AND withdrawn_by IS NULL)
    );

-- Older rejected proof predates explicit routing. Treat it as returned to the
-- shared queue so every historical rejection has a deterministic API value.
UPDATE item_submissions
SET review_return_route = 'unassigned'
WHERE review_state = 'rejected'
  AND review_return_route IS NULL;

ALTER TABLE item_submissions
  ADD CONSTRAINT item_submissions_rejection_route_check
    CHECK (
      (review_state = 'rejected' AND review_return_route IS NOT NULL)
      OR (review_state <> 'rejected' AND review_return_route IS NULL)
    );

CREATE INDEX IF NOT EXISTS item_submissions_rejected_submitter_idx
  ON item_submissions(submitted_by, reviewed_at DESC)
  WHERE review_state = 'rejected';

CREATE INDEX IF NOT EXISTS item_submissions_withdrawn_at_idx
  ON item_submissions(withdrawn_at DESC)
  WHERE review_state = 'withdrawn';

ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE inventory_sessions
SET started_at = created_at
WHERE started_at IS NULL
  AND status IN ('active', 'closed');

WITH completion AS (
  SELECT item.session_id,
    max(item.updated_at) AS completed_at
  FROM inventory_session_items item
  GROUP BY item.session_id
  HAVING count(*) > 0
    AND bool_and(item.status IN ('found', 'not_found', 'mismatch', 'approved'))
)
UPDATE inventory_sessions session
SET completed_at = completion.completed_at
FROM completion
WHERE session.id = completion.session_id
  AND session.completed_at IS NULL;

CREATE OR REPLACE FUNCTION record_inventory_session_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_session_id uuid;
BEGIN
  target_session_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;

  UPDATE inventory_sessions session
  SET completed_at = CASE
    WHEN EXISTS (
      SELECT 1
      FROM inventory_session_items item
      WHERE item.session_id = target_session_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_session_items item
      WHERE item.session_id = target_session_id
        AND item.status NOT IN ('found', 'not_found', 'mismatch', 'approved')
    )
      THEN COALESCE(session.completed_at, now())
    ELSE NULL
  END
  WHERE session.id = target_session_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS inventory_session_completion_trigger ON inventory_session_items;
CREATE TRIGGER inventory_session_completion_trigger
AFTER INSERT OR DELETE OR UPDATE OF status, session_id ON inventory_session_items
FOR EACH ROW
EXECUTE FUNCTION record_inventory_session_completion();

CREATE INDEX IF NOT EXISTS inventory_sessions_tenant_active_started_idx
  ON inventory_sessions(tenant_id, started_at DESC, created_at DESC)
  WHERE status = 'active';
