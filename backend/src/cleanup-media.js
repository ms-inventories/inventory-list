import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { closePool, withTransaction } from "./db.js";
import { normalizeMediaStorageKey } from "./media.js";

function boundedLimit(value, fallback = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(5000, Math.floor(parsed)));
}

async function unlinkUpload(storageKey) {
  const normalized = normalizeMediaStorageKey(storageKey);
  if (!normalized) throw new Error("Invalid staged media storage key");
  const rootPath = path.resolve(config.storage.root);
  const absolutePath = path.resolve(rootPath, normalized);
  if (!absolutePath.startsWith(rootPath + path.sep)) throw new Error("Staged media path escapes storage root");

  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanupBatch(limit) {
  return withTransaction(async client => {
    const result = await client.query(
      `
        SELECT id, tenant_id, storage_key, purpose, mime_type, size_bytes
        FROM media_uploads
        WHERE state = 'staged'
          AND staged_expires_at <= now()
        ORDER BY staged_expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      `,
      [limit]
    );

    let deleted = 0;
    let failed = 0;
    for (const upload of result.rows) {
      try {
        await unlinkUpload(upload.storage_key);
        await client.query("DELETE FROM media_uploads WHERE id = $1 AND state = 'staged'", [upload.id]);
        await client.query(
          `
            INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
            VALUES ($1, NULL, 'media_upload.expired', 'media_upload', $2, $3::jsonb)
          `,
          [
            upload.tenant_id,
            upload.id,
            JSON.stringify({
              purpose: upload.purpose,
              mimeType: upload.mime_type,
              sizeBytes: upload.size_bytes == null ? null : Number(upload.size_bytes)
            })
          ]
        );
        deleted += 1;
      } catch (error) {
        failed += 1;
        console.error(JSON.stringify({
          event: "media_upload_cleanup_failed",
          uploadId: upload.id,
          errorMessage: error?.message || String(error)
        }));
      }
    }

    return { selected: result.rows.length, deleted, failed };
  });
}

async function main() {
  const limit = boundedLimit(process.env.MEDIA_CLEANUP_LIMIT);
  let attempted = 0;
  let deleted = 0;
  let failed = 0;

  while (attempted < limit) {
    const batch = await cleanupBatch(Math.min(50, limit - attempted));
    attempted += batch.selected;
    deleted += batch.deleted;
    failed += batch.failed;
    if (!batch.selected || !batch.deleted) break;
  }

  console.log(JSON.stringify({
    event: "media_upload_cleanup_complete",
    attempted,
    deleted,
    failed
  }));
  if (failed) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
