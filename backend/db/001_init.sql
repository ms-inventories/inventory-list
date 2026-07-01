CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_subject text UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('tenant_admin', 'contributor', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  invited_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  common_name text,
  army_name text,
  lin text,
  nsn text,
  description text,
  current_location text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_items_tenant_idx ON inventory_items(tenant_id);
CREATE INDEX inventory_items_lin_idx ON inventory_items(tenant_id, lin);
CREATE INDEX inventory_items_nsn_idx ON inventory_items(tenant_id, nsn);

CREATE TABLE inventory_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  packet_source text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX inventory_sessions_tenant_idx ON inventory_sessions(tenant_id);

CREATE TABLE inventory_session_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  packet_line text,
  expected_qty integer,
  location_hint text,
  status text NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked', 'found', 'not_found', 'mismatch', 'needs_review', 'approved')),
  direct_verified_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_items_session_idx ON inventory_session_items(session_id);

CREATE TABLE item_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_item_id uuid NOT NULL REFERENCES inventory_session_items(id) ON DELETE CASCADE,
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  status text NOT NULL CHECK (status IN ('found', 'not_found', 'mismatch', 'needs_review')),
  location_text text,
  note text,
  serial_number text,
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'request_more_info', 'rejected')),
  reviewed_by uuid REFERENCES app_users(id),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX item_submissions_session_item_idx ON item_submissions(session_item_id);

CREATE TABLE submission_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES item_submissions(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  caption text,
  kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'serial', 'location', 'damage')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES item_submissions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  message text NOT NULL,
  requested_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_idx ON audit_events(tenant_id, created_at DESC);
