ALTER TABLE packet_import_batches
  ADD COLUMN IF NOT EXISTS source_size_bytes bigint;
