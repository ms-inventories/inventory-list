CREATE TABLE IF NOT EXISTS packet_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  source_name text,
  source_mime_type text,
  source_storage_key text,
  extracted_text text,
  row_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS packet_import_batches_session_idx ON packet_import_batches(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS packet_import_batches_tenant_idx ON packet_import_batches(tenant_id, created_at DESC);

ALTER TABLE inventory_session_items
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES packet_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS session_items_import_batch_idx ON inventory_session_items(import_batch_id);
