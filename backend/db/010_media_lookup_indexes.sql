CREATE INDEX IF NOT EXISTS submission_photos_storage_key_idx
  ON submission_photos(storage_key);

CREATE INDEX IF NOT EXISTS packet_import_batches_tenant_source_storage_key_idx
  ON packet_import_batches(tenant_id, source_storage_key)
  WHERE source_storage_key IS NOT NULL;
