CREATE TABLE equipment_library_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_session_item_id uuid REFERENCES inventory_session_items(id) ON DELETE SET NULL,
  source_packet_line text NOT NULL,
  source_packet_line_normalized text NOT NULL,
  target_session_item_id uuid NOT NULL REFERENCES inventory_session_items(id) ON DELETE CASCADE,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT equipment_library_links_source_wording_check CHECK (
    btrim(source_packet_line) <> ''
    AND btrim(source_packet_line_normalized) <> ''
  ),
  CONSTRAINT equipment_library_links_distinct_items_check CHECK (
    source_session_item_id IS NULL
    OR source_session_item_id <> target_session_item_id
  ),
  UNIQUE (tenant_id, source_packet_line_normalized)
);

CREATE INDEX equipment_library_links_tenant_created_idx
  ON equipment_library_links(tenant_id, created_at DESC, id DESC);

CREATE INDEX equipment_library_links_target_item_idx
  ON equipment_library_links(target_session_item_id);

CREATE INDEX item_submissions_approved_item_cursor_idx
  ON item_submissions(session_item_id, created_at DESC, id DESC)
  WHERE review_state = 'approved';

CREATE INDEX submission_photos_submission_cursor_idx
  ON submission_photos(submission_id, created_at, id);
