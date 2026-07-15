import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformSetupInspector } from "../src/platform-setup.js";

function tenant(overrides = {}) {
  return {
    id: "tenant-1",
    slug: "ms",
    hostname: "ms.876en.org",
    adminCount: 1,
    pendingAdminInviteCount: 0,
    packetImportCount: 2,
    ...overrides
  };
}

test("platform setup reports local DNS, database access, packet history, and disabled provisioning safely", async () => {
  let lookupCalls = 0;
  let clientCalls = 0;
  const inspector = createPlatformSetupInspector({
    baseDomain: "localhost",
    storageRoot: "/qa/uploads",
    provisioningEnabled: false,
    tenantGroupPrefix: "876en-",
    lookup: async () => {
      lookupCalls += 1;
      return { address: "127.0.0.1" };
    },
    access: async () => {},
    createClient: () => {
      clientCalls += 1;
      throw new Error("should not create client");
    }
  });

  const result = await inspector.inspect([tenant({ hostname: "ms.localhost" })]);

  assert.equal(lookupCalls, 0);
  assert.equal(clientCalls, 0);
  assert.deepEqual(result.storage, { state: "ready" });
  assert.deepEqual(result.authentik, { state: "not_connected" });
  assert.deepEqual(result.tenants["tenant-1"], {
    hostname: "ms.localhost",
    dns: { state: "ready" },
    authentikGroup: { state: "not_connected", name: "876en-ms" },
    leaderAccess: { state: "ready", activeAdminCount: 1, pendingInviteCount: 0 },
    packetImport: { state: "ready", count: 2 }
  });
});

test("platform setup distinguishes missing groups, pending leader invites, DNS failures, and unwritable storage", async () => {
  const inspector = createPlatformSetupInspector({
    baseDomain: "876en.org",
    storageRoot: "/qa/uploads",
    provisioningEnabled: true,
    authentikOrigin: "https://auth.example.test",
    authentikToken: "test-token",
    tenantGroupPrefix: "876en-",
    authentikTimeoutMs: 100,
    lookup: async hostname => {
      if (hostname.startsWith("missing")) throw new Error("dns missing");
      return { address: "192.0.2.10" };
    },
    access: async () => {
      throw new Error("read only");
    },
    createClient: () => ({
      findGroupByName: async name => name === "876en-ms" ? { pk: "group-id" } : null
    })
  });

  const result = await inspector.inspect([
    tenant({ adminCount: 0, pendingAdminInviteCount: 1, packetImportCount: 0 }),
    tenant({ id: "tenant-2", slug: "missing", hostname: "missing.876en.org", adminCount: 0, packetImportCount: 0 })
  ]);

  assert.deepEqual(result.storage, { state: "unavailable" });
  assert.deepEqual(result.authentik, { state: "ready" });
  assert.equal(result.tenants["tenant-1"].dns.state, "ready");
  assert.equal(result.tenants["tenant-1"].authentikGroup.state, "ready");
  assert.equal(result.tenants["tenant-1"].leaderAccess.state, "pending");
  assert.equal(result.tenants["tenant-1"].packetImport.state, "missing");
  assert.equal(result.tenants["tenant-2"].dns.state, "missing");
  assert.deepEqual(result.tenants["tenant-2"].authentikGroup, { state: "missing", name: "876en-missing" });
  assert.equal(result.tenants["tenant-2"].leaderAccess.state, "missing");
});

test("platform setup contains Authentik outages and bounded DNS checks", async () => {
  const inspector = createPlatformSetupInspector({
    baseDomain: "876en.org",
    storageRoot: "/qa/uploads",
    provisioningEnabled: true,
    authentikOrigin: "https://auth.example.test",
    authentikToken: "test-token",
    tenantGroupPrefix: "876en-",
    authentikTimeoutMs: 100,
    dnsTimeoutMs: 5,
    lookup: async () => new Promise(resolve => setTimeout(() => resolve({ address: "192.0.2.11" }), 50)),
    access: async () => {},
    createClient: () => ({
      findGroupByName: async () => {
        throw new Error("provider unavailable");
      }
    })
  });

  const result = await inspector.inspect([tenant()]);

  assert.deepEqual(result.authentik, { state: "unavailable" });
  assert.equal(result.tenants["tenant-1"].authentikGroup.state, "unavailable");
  assert.equal(result.tenants["tenant-1"].dns.state, "missing");
  assert.equal(result.storage.state, "ready");
});
