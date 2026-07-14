import assert from "node:assert/strict";
import test from "node:test";
import { resolveEffectiveMembership } from "../src/tenant.js";

const authentikAdmin = {
  id: "authentik:ms:tenant_admin",
  tenant_id: "tenant-ms",
  user_id: "user-1",
  role: "tenant_admin",
  status: "active",
  source: "authentik"
};

test("active database membership keeps its exact role over Authentik", () => {
  const databaseViewer = {
    id: "membership-1",
    tenant_id: "tenant-ms",
    user_id: "user-1",
    role: "viewer",
    status: "active",
    source: "database"
  };

  assert.equal(resolveEffectiveMembership(databaseViewer, authentikAdmin), databaseViewer);
});

test("invited and disabled database memberships deny stale group access", () => {
  for (const status of ["invited", "disabled"]) {
    const databaseMembership = {
      id: `membership-${status}`,
      tenant_id: "tenant-ms",
      user_id: "user-1",
      role: "contributor",
      status,
      source: "database"
    };
    assert.equal(resolveEffectiveMembership(databaseMembership, authentikAdmin), null, status);
  }
});

test("Authentik tenant-group fallback only applies without a database row and when enabled", () => {
  assert.equal(
    resolveEffectiveMembership(null, authentikAdmin, { allowGroupFallback: true }),
    authentikAdmin
  );
  assert.equal(
    resolveEffectiveMembership(null, authentikAdmin, { allowGroupFallback: false }),
    null
  );
});

test("platform admin override remains available despite an inactive database row", () => {
  const disabled = {
    id: "membership-disabled",
    tenant_id: "tenant-ms",
    user_id: "platform-user",
    role: "viewer",
    status: "disabled",
    source: "database"
  };
  const platformOverride = {
    ...authentikAdmin,
    id: "authentik:ms:platform-admin",
    source: "platform_admin",
    platformAdminOverride: true
  };

  assert.equal(
    resolveEffectiveMembership(disabled, platformOverride, { isPlatformAdmin: true, allowGroupFallback: false }),
    platformOverride
  );
});
