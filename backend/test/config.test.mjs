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

test("crew staging quota always leaves room for a ten-photo evidence submission", () => {
  const script = `
    import { config } from ${JSON.stringify(configUrl)};
    process.stdout.write(String(config.crewAccess.maxStagedUploadsPerAuthSession));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      CREW_MAX_STAGED_UPLOADS_PER_SESSION: "4"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "12");
});

test("temporary crew inactivity defaults to 36 hours and remains bounded", () => {
  const script = `
    import { config } from ${JSON.stringify(configUrl)};
    process.stdout.write(String(config.crewAccess.inactivityTtlHours));
  `;
  const baseEnvironment = { ...process.env, NODE_ENV: "test" };
  delete baseEnvironment.CREW_INACTIVITY_TTL_HOURS;

  const defaultResult = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: baseEnvironment,
    encoding: "utf8"
  });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(defaultResult.stdout, "36");

  const boundedResult = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve("."),
    env: { ...baseEnvironment, CREW_INACTIVITY_TTL_HOURS: "999" },
    encoding: "utf8"
  });
  assert.equal(boundedResult.status, 0, boundedResult.stderr);
  assert.equal(boundedResult.stdout, "168");
});

test("Authentik provisioning is inert by default and validates every required setting when enabled", () => {
  const disabled = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "false",
    AUTHENTIK_API_ORIGIN: "",
    AUTHENTIK_API_TOKEN: "",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "",
    AUTHENTIK_MANAGED_USER_PATH: ""
  });
  assert.equal(disabled.status, 0, disabled.stderr);

  const missing = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "http://auth.example.test",
    AUTHENTIK_API_TOKEN: "",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "not-a-uuid",
    AUTHENTIK_MANAGED_USER_PATH: ""
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /AUTHENTIK_API_ORIGIN/);
  assert.match(missing.stderr, /AUTHENTIK_API_TOKEN/);
  assert.match(missing.stderr, /AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID/);
  assert.match(missing.stderr, /AUTHENTIK_MANAGED_USER_PATH/);

  const configured = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-"
  });
  assert.equal(configured.status, 0, configured.stderr);

  const tooLong = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-",
    AUTHENTIK_RECOVERY_TOKEN_DURATION: "days=8"
  });
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stderr, /days=1 through days=7/);

  const unsafeLease = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-",
    AUTHENTIK_API_TIMEOUT_MS: "30000",
    AUTHENTIK_PROVISIONING_LEASE_SECONDS: "30"
  });
  assert.equal(unsafeLease.status, 1);
  assert.match(unsafeLease.stderr, /at least three AUTHENTIK_API_TIMEOUT_MS intervals plus 5 seconds/);

  const safeLease = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-",
    AUTHENTIK_API_TIMEOUT_MS: "30000",
    AUTHENTIK_PROVISIONING_LEASE_SECONDS: "95"
  });
  assert.equal(safeLease.status, 0, safeLease.stderr);

  const privilegedBase = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en-admins",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-"
  });
  assert.equal(privilegedBase.status, 1);
  assert.match(privilegedBase.stderr, /must not be privileged or tenant-scoped/);

  const configuredPrivilegedBase = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "custom-admins",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-",
    PLATFORM_ADMIN_GROUP: "custom-admins"
  });
  assert.equal(configuredPrivilegedBase.status, 1);
  assert.match(configuredPrivilegedBase.stderr, /must not be privileged or tenant-scoped/);

  const tenantScopedBase = checkProductionConfig({
    AUTHENTIK_PROVISIONING_ENABLED: "true",
    AUTHENTIK_API_ORIGIN: "https://auth.example.test",
    AUTHENTIK_API_TOKEN: "least-privilege-service-token",
    AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID: "61aa7317-087f-4ed0-b446-485b6934b145",
    AUTHENTIK_MANAGED_USER_PATH: "users/inventory",
    AUTHENTIK_BASE_GROUP: "876en-ms",
    AUTHENTIK_TENANT_GROUP_PREFIX: "876en-"
  });
  assert.equal(tenantScopedBase.status, 1);
  assert.match(tenantScopedBase.stderr, /must not be privileged or tenant-scoped/);
});
