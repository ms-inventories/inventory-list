import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const MIGRATION_TABLE = "schema_migrations";
const MIGRATION_LOCK_KEY = "inventory-list-migrations";
const BASELINE_MARKERS = new Map([
  ["001_init.sql", "tenants"],
  ["002_tenant_admin_invites.sql", "tenant_invitations"],
  ["003_packet_import_batches.sql", "packet_import_batches"]
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "..", "db");

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function tableExists(client, tableName) {
  const result = await client.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function acquireMigrationLock(client) {
  console.log("waiting for migration lock");
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
}

async function releaseMigrationLock(client) {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
}

async function getMigrationFiles() {
  const files = await fs.readdir(migrationsDir);
  return files
    .filter(file => /^\d+_.+\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(client) {
  const result = await client.query(`SELECT filename FROM ${MIGRATION_TABLE}`);
  return new Set(result.rows.map(row => row.filename));
}

async function baselineExistingInstall(client, migrationFiles) {
  const hasExistingSchema = await tableExists(client, "tenants");
  if (!hasExistingSchema) return [];

  const baselined = [];
  for (const file of migrationFiles) {
    const markerTable = BASELINE_MARKERS.get(file);
    if (!markerTable || !(await tableExists(client, markerTable))) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await client.query(
      `
        INSERT INTO ${MIGRATION_TABLE} (filename, checksum)
        VALUES ($1, $2)
        ON CONFLICT (filename) DO NOTHING
      `,
      [file, checksum(sql)]
    );
    baselined.push(file);
  }

  return baselined;
}

async function applyMigration(client, file) {
  const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      `
        INSERT INTO ${MIGRATION_TABLE} (filename, checksum)
        VALUES ($1, $2)
      `,
      [file, checksum(sql)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const client = await pool.connect();
  let hasLock = false;

  try {
    await acquireMigrationLock(client);
    hasLock = true;
    await ensureMigrationTable(client);
    const migrationFiles = await getMigrationFiles();
    let applied = await getAppliedMigrations(client);

    if (!applied.size) {
      const baselined = await baselineExistingInstall(client, migrationFiles);
      baselined.forEach(file => console.log(`baselined ${file}`));
      applied = await getAppliedMigrations(client);
    }

    let appliedCount = 0;
    for (const file of migrationFiles) {
      if (applied.has(file)) {
        console.log(`already applied ${file}`);
        continue;
      }

      await applyMigration(client, file);
      appliedCount += 1;
      console.log(`applied ${file}`);
    }

    console.log(appliedCount ? `migration complete: ${appliedCount} applied` : "migration complete: database is current");
  } finally {
    if (hasLock) {
      try {
        await releaseMigrationLock(client);
      } catch (error) {
        console.error("failed to release migration lock", error);
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
