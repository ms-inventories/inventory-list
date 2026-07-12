CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  storage_key text NOT NULL UNIQUE,
  original_file_name text,
  mime_type text NOT NULL,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  purpose text NOT NULL CHECK (purpose IN ('evidence', 'inventory_reference', 'packet_source')),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'attached')),
  staged_expires_at timestamptz,
  attached_to_type text CHECK (attached_to_type IN ('item_submission', 'inventory_item', 'packet_import_batch')),
  attached_to_id uuid,
  attached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      state = 'staged'
      AND staged_expires_at IS NOT NULL
      AND attached_to_type IS NULL
      AND attached_to_id IS NULL
      AND attached_at IS NULL
    )
    OR
    (
      state = 'attached'
      AND staged_expires_at IS NULL
      AND attached_to_type IS NOT NULL
      AND attached_to_id IS NOT NULL
      AND attached_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS media_uploads_tenant_state_idx
  ON media_uploads(tenant_id, state, staged_expires_at);

CREATE INDEX IF NOT EXISTS media_uploads_uploader_idx
  ON media_uploads(uploaded_by, created_at DESC);

ALTER TABLE submission_photos
  ADD COLUMN IF NOT EXISTS media_upload_id uuid REFERENCES media_uploads(id) ON DELETE RESTRICT;

INSERT INTO media_uploads (
  tenant_id,
  uploaded_by,
  storage_key,
  mime_type,
  purpose,
  state,
  attached_to_type,
  attached_to_id,
  attached_at,
  created_at
)
SELECT DISTINCT ON (photo.storage_key)
  session.tenant_id,
  submission.submitted_by,
  photo.storage_key,
  CASE
    WHEN lower(photo.storage_key) LIKE '%.png' THEN 'image/png'
    WHEN lower(photo.storage_key) LIKE '%.webp' THEN 'image/webp'
    WHEN lower(photo.storage_key) LIKE '%.gif' THEN 'image/gif'
    ELSE 'image/jpeg'
  END,
  'evidence',
  'attached',
  'item_submission',
  submission.id,
  photo.created_at,
  photo.created_at
FROM submission_photos photo
JOIN item_submissions submission ON submission.id = photo.submission_id
JOIN inventory_session_items item ON item.id = submission.session_item_id
JOIN inventory_sessions session ON session.id = item.session_id
ORDER BY photo.storage_key, photo.created_at, photo.id
ON CONFLICT (storage_key) DO NOTHING;

WITH ranked_photos AS (
  SELECT
    photo.id,
    photo.storage_key,
    row_number() OVER (
      PARTITION BY photo.storage_key
      ORDER BY photo.created_at, photo.id
    ) AS storage_rank
  FROM submission_photos photo
)
UPDATE submission_photos photo
SET media_upload_id = upload.id
FROM ranked_photos ranked
JOIN media_uploads upload ON upload.storage_key = ranked.storage_key
WHERE photo.id = ranked.id
  AND ranked.storage_rank = 1
  AND photo.media_upload_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS submission_photos_media_upload_idx
  ON submission_photos(media_upload_id)
  WHERE media_upload_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_item_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  media_upload_id uuid NOT NULL UNIQUE REFERENCES media_uploads(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_item_id, media_upload_id)
);

CREATE INDEX IF NOT EXISTS inventory_item_media_item_idx
  ON inventory_item_media(inventory_item_id, sort_order, created_at);

ALTER TABLE packet_import_batches
  ADD COLUMN IF NOT EXISTS media_upload_id uuid REFERENCES media_uploads(id) ON DELETE RESTRICT;

INSERT INTO media_uploads (
  tenant_id,
  uploaded_by,
  storage_key,
  original_file_name,
  mime_type,
  size_bytes,
  purpose,
  state,
  attached_to_type,
  attached_to_id,
  attached_at,
  created_at
)
SELECT DISTINCT ON (batch.source_storage_key)
  batch.tenant_id,
  batch.created_by,
  batch.source_storage_key,
  batch.source_name,
  COALESCE(NULLIF(batch.source_mime_type, ''), 'application/octet-stream'),
  batch.source_size_bytes,
  'packet_source',
  'attached',
  'packet_import_batch',
  batch.id,
  batch.created_at,
  batch.created_at
FROM packet_import_batches batch
WHERE batch.source_storage_key IS NOT NULL
ORDER BY batch.source_storage_key, batch.created_at, batch.id
ON CONFLICT (storage_key) DO NOTHING;

UPDATE packet_import_batches batch
SET media_upload_id = upload.id
FROM media_uploads upload
WHERE upload.storage_key = batch.source_storage_key
  AND batch.media_upload_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS packet_import_batches_media_upload_idx
  ON packet_import_batches(media_upload_id)
  WHERE media_upload_id IS NOT NULL;
