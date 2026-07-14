import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const configUrl = pathToFileURL(path.resolve("src/config.js")).href;
const strongSecret = Buffer.alloc(32, 7).toString("base64url");

function checkProductionConfig(extraEnvironment = {}) {
  const script = `
    import { assertProductionConfig } from ${JSON.stringify(configUrl)};
    try {
      assertProductionConfig();
      process.stdout.write("ok");
    } catch (error) {
      process.stderr.write(String(error.message || error));
      process.exitCode = 1;
    }
  `;
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: "postgres://inventory.invalid/inventory",
    OIDC_ISSUER: "https://auth.example.test/application/o/inventory/",
    OIDC_AUDIENCE: "inventory-web",
    PLATFORM_ADMIN_EMAILS: "admin@example.test",
    PUBLIC_MEDIA_BASE_URL: "https://api.876en.org/media",
    MEDIA_SIGNING_SECRET: strongSecret,
    CREW_ACCESS_SECRET: "",
    ...extraEnvironment
  };
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: environment,
    encoding: "utf8"
  });
}

test("production crew access rejects ephemeral fallback and accepts persistent configured secrets", () => {
  const missing = checkProductionConfig({ MEDIA_SIGNING_SECRET: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CREW_ACCESS_SECRET or persistent MEDIA_SIGNING_SECRET/);

  const mediaFallback = checkProductionConfig();
  assert.equal(mediaFallback.status, 0, mediaFallback.stderr);
  assert.equal(mediaFallback.stdout, "ok");

  const dedicated = checkProductionConfig({ CREW_ACCESS_SECRET: strongSecret });
  assert.equal(dedicated.status, 0, dedicated.stderr);
  assert.equal(dedicated.stdout, "ok");
});

test("Authentik tenant-group fallback defaults on and can be disabled explicitly", () => {
  const script = `
    import { config } from ${JSON.stringify(configUrl)};
    process.stdout.write(String(config.oidc.tenantGroupFallbackEnabled));
  `;
  const baseEnvironment = { ...process.env, NODE_ENV: "test" };
  delete baseEnvironment.AUTHENTIK_TENANT_GROUP_FALLBACK_ENABLED;

  const defaultResult = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: baseEnvironment,
    encoding: "utf8"
  });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(defaultResult.stdout, "true");

  const disabledResult = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: { ...baseEnvironment, AUTHENTIK_TENANT_GROUP_FALLBACK_ENABLED: "false" },
    encoding: "utf8"
  });
  assert.equal(disabledResult.status, 0, disabledResult.stderr);
  assert.equal(disabledResult.stdout, "false");
});
