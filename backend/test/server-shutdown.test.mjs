import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("shutdown drains HTTP before stopping provisioning and closing the database", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(directory, "../src/server.js"), "utf8");
  const serverClose = source.indexOf("server.close(resolve)");
  const workerStop = source.indexOf("stopProvisioningWorker()", serverClose);
  const poolClose = source.indexOf("closePool()", workerStop);

  assert.ok(serverClose >= 0);
  assert.ok(workerStop > serverClose);
  assert.ok(poolClose > workerStop);
  assert.match(source, /if \(closing\) return closing/);
});
