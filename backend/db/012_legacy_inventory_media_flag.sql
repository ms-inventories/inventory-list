ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS legacy_media_metadata boolean NOT NULL DEFAULT false;

UPDATE inventory_items
SET legacy_media_metadata = true
WHERE legacy_media_metadata = false
  AND metadata::text LIKE '%/media/tenants/%';
