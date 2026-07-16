import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = path.join(repoRoot, "react-app", "dist", "assets");

test("the production PDF worker is emitted as a JavaScript asset", async () => {
  const assetNames = await readdir(assetsDirectory);
  const workerScripts = assetNames.filter(name => /^pdf\.worker\.min-[A-Za-z0-9_-]+\.js$/.test(name));
  const workerModules = assetNames.filter(name => /^pdf\.worker\.min-.*\.mjs$/.test(name));

  assert.equal(workerScripts.length, 1, "expected one .js PDF worker in the production build");
  assert.deepEqual(workerModules, [], "the static host serves .mjs with an invalid worker MIME type");

  const applicationScripts = assetNames.filter(name => name.endsWith(".js") && !workerScripts.includes(name));
  const applicationSource = (await Promise.all(
    applicationScripts.map(name => readFile(path.join(assetsDirectory, name), "utf8"))
  )).join("\n");

  assert.match(
    applicationSource,
    new RegExp(`/assets/${workerScripts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the application bundle should load the renamed PDF worker"
  );
});
