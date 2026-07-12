CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  notification_preferences jsonb NOT NULL DEFAULT '{
    "proof_submitted": true,
    "proof_requests": true,
    "open_rows": true,
    "packet_imports": true,
    "session_closed": true,
    "email_proof_submitted": true,
    "email_proof_requests": true
  }'::jsonb,
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(notification_preferences) = 'object')
);

CREATE INDEX IF NOT EXISTS tenant_settings_updated_idx
  ON tenant_settings(updated_at DESC);
