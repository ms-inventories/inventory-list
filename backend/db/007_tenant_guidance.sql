CREATE TABLE IF NOT EXISTS tenant_guidance (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_guidance_updated_idx
  ON tenant_guidance(updated_at DESC);
