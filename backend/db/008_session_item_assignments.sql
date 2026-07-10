ALTER TABLE inventory_session_items
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

CREATE INDEX IF NOT EXISTS session_items_assigned_to_idx ON inventory_session_items(assigned_to);
