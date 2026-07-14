ALTER TABLE inventory_items
  ADD COLUMN serial_number text,
  ADD COLUMN last_verified_submission_id uuid REFERENCES item_submissions(id) ON DELETE SET NULL,
  ADD COLUMN last_verified_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN last_verified_at timestamptz;

CREATE INDEX inventory_items_tenant_serial_normalized_idx
  ON inventory_items (
    tenant_id,
    upper(regexp_replace(COALESCE(serial_number, ''), '[^A-Za-z0-9]', '', 'g'))
  )
  WHERE serial_number IS NOT NULL AND btrim(serial_number) <> '';

ALTER TABLE inventory_session_items
  ADD COLUMN suggested_inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  ADD COLUMN inventory_match_confirmed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN inventory_match_confirmed_at timestamptz,
  ADD CONSTRAINT inventory_session_items_match_confirmation_check CHECK (
    (inventory_match_confirmed_by IS NULL) = (inventory_match_confirmed_at IS NULL)
  ),
  ADD CONSTRAINT inventory_session_items_distinct_match_check CHECK (
    inventory_item_id IS NULL
    OR suggested_inventory_item_id IS NULL
    OR inventory_item_id <> suggested_inventory_item_id
  );

CREATE INDEX session_items_suggested_inventory_item_idx
  ON inventory_session_items(suggested_inventory_item_id)
  WHERE suggested_inventory_item_id IS NOT NULL;

-- Normalize older local photo URLs so leaders can keep or replace those photos
-- deliberately during the next review. The legacy metadata remains in place
-- until that explicit save, which also supports records whose old file is gone.
WITH legacy_media AS (
  SELECT DISTINCT
    item.id AS inventory_item_id,
    item.tenant_id,
    item.created_by,
    item.created_at,
    (matches.parts)[1] AS storage_key
  FROM inventory_items item
  JOIN tenants tenant ON tenant.id = item.tenant_id
  CROSS JOIN LATERAL regexp_matches(
    item.metadata::text,
    '(tenants/[A-Za-z0-9._~%/-]+)',
    'g'
  ) AS matches(parts)
  WHERE item.legacy_media_metadata = true
    AND (matches.parts)[1] LIKE 'tenants/' || tenant.slug || '/%'
)
INSERT INTO media_uploads (
  tenant_id,
  uploaded_by,
  storage_key,
  original_file_name,
  mime_type,
  purpose,
  state,
  attached_to_type,
  attached_to_id,
  attached_at,
  created_at
)
SELECT
  legacy.tenant_id,
  legacy.created_by,
  legacy.storage_key,
  regexp_replace(legacy.storage_key, '^.*/', ''),
  CASE
    WHEN lower(legacy.storage_key) LIKE '%.png' THEN 'image/png'
    WHEN lower(legacy.storage_key) LIKE '%.webp' THEN 'image/webp'
    WHEN lower(legacy.storage_key) LIKE '%.gif' THEN 'image/gif'
    ELSE 'image/jpeg'
  END,
  'inventory_reference',
  'attached',
  'inventory_item',
  legacy.inventory_item_id,
  legacy.created_at,
  legacy.created_at
FROM legacy_media legacy
ON CONFLICT (storage_key) DO NOTHING;

WITH legacy_media AS (
  SELECT DISTINCT
    item.id AS inventory_item_id,
    item.tenant_id,
    (matches.parts)[1] AS storage_key
  FROM inventory_items item
  JOIN tenants tenant ON tenant.id = item.tenant_id
  CROSS JOIN LATERAL regexp_matches(
    item.metadata::text,
    '(tenants/[A-Za-z0-9._~%/-]+)',
    'g'
  ) AS matches(parts)
  WHERE item.legacy_media_metadata = true
    AND (matches.parts)[1] LIKE 'tenants/' || tenant.slug || '/%'
), ranked_legacy_media AS (
  SELECT legacy.*,
    row_number() OVER (
      PARTITION BY legacy.inventory_item_id
      ORDER BY legacy.storage_key
    ) AS legacy_rank
  FROM legacy_media legacy
)
INSERT INTO inventory_item_media (inventory_item_id, media_upload_id, sort_order)
SELECT
  legacy.inventory_item_id,
  upload.id,
  100 + legacy.legacy_rank
FROM ranked_legacy_media legacy
JOIN media_uploads upload
  ON upload.storage_key = legacy.storage_key
 AND upload.tenant_id = legacy.tenant_id
WHERE legacy.legacy_rank <= 3
ON CONFLICT DO NOTHING;

-- Older records could contain up to eight reference photos. Keep the first three
-- links while preserving every underlying upload and submission-evidence row.
WITH ranked_references AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY inventory_item_id
      ORDER BY sort_order, created_at, id
    ) AS reference_rank
  FROM inventory_item_media
)
DELETE FROM inventory_item_media reference
USING ranked_references ranked
WHERE reference.id = ranked.id
  AND ranked.reference_rank > 3;

CREATE OR REPLACE FUNCTION enforce_inventory_item_media_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM inventory_items
  WHERE id = NEW.inventory_item_id
  FOR UPDATE;

  IF (
    SELECT count(*)
    FROM inventory_item_media reference
    WHERE reference.inventory_item_id = NEW.inventory_item_id
      AND reference.id IS DISTINCT FROM NEW.id
  ) >= 3 THEN
    RAISE EXCEPTION 'An inventory item can have no more than three saved photos.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_item_media_limit_trigger ON inventory_item_media;
CREATE TRIGGER inventory_item_media_limit_trigger
BEFORE INSERT OR UPDATE OF inventory_item_id ON inventory_item_media
FOR EACH ROW
EXECUTE FUNCTION enforce_inventory_item_media_limit();
