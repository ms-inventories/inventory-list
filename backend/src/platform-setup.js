import dns from "node:dns/promises";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createAuthentikClient } from "./authentik.js";
import { config } from "./config.js";

const DEFAULT_DNS_TIMEOUT_MS = 1500;

function positiveCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("setup_check_timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createPlatformSetupInspector({
  baseDomain,
  storageRoot,
  provisioningEnabled,
  authentikOrigin,
  authentikToken,
  tenantGroupPrefix,
  authentikTimeoutMs,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
  lookup = dns.lookup,
  access = fs.access,
  createClient = createAuthentikClient
} = {}) {
  async function inspectDns(hostname) {
    if (!hostname) return false;
    if (isLocalHostname(hostname) || String(baseDomain || "").toLowerCase() === "localhost") {
      return true;
    }
    try {
      await settleWithin(lookup(hostname), dnsTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async function inspectStorage() {
    try {
      await access(storageRoot, fsConstants.R_OK | fsConstants.W_OK);
      return { state: "ready" };
    } catch {
      return { state: "unavailable" };
    }
  }

  async function inspectGroups(tenants) {
    if (!provisioningEnabled) {
      return {
        connection: { state: "not_connected" },
        groups: new Map(tenants.map(tenant => [tenant.id, { state: "not_connected" }]))
      };
    }

    let client;
    try {
      client = createClient({
        origin: authentikOrigin,
        token: authentikToken,
        timeoutMs: authentikTimeoutMs
      });
    } catch {
      return {
        connection: { state: "unavailable" },
        groups: new Map(tenants.map(tenant => [tenant.id, { state: "unavailable" }]))
      };
    }

    const results = await Promise.all(tenants.map(async tenant => {
      const name = `${tenantGroupPrefix}${tenant.slug}`.toLowerCase();
      try {
        const group = await client.findGroupByName(name);
        return [tenant.id, { state: group ? "ready" : "missing", name }];
      } catch {
        return [tenant.id, { state: "unavailable", name }];
      }
    }));
    const groups = new Map(results);
    const states = [...groups.values()].map(group => group.state);
    const connectionState = states.some(state => state !== "unavailable") ? "ready" : "unavailable";
    return { connection: { state: connectionState }, groups };
  }

  return Object.freeze({
    async inspect(tenants = []) {
      const safeTenants = Array.isArray(tenants) ? tenants : [];
      const [storage, groupInspection, dnsResults] = await Promise.all([
        inspectStorage(),
        inspectGroups(safeTenants),
        Promise.all(safeTenants.map(async tenant => [tenant.id, await inspectDns(tenant.hostname)]))
      ]);
      const dnsByTenant = new Map(dnsResults);

      return {
        storage,
        authentik: groupInspection.connection,
        tenants: Object.fromEntries(safeTenants.map(tenant => {
          const activeAdminCount = positiveCount(tenant.adminCount);
          const pendingAdminInviteCount = positiveCount(tenant.pendingAdminInviteCount);
          const packetImportCount = positiveCount(tenant.packetImportCount);
          const groupName = `${tenantGroupPrefix}${tenant.slug}`.toLowerCase();
          const group = groupInspection.groups.get(tenant.id) || {
            state: provisioningEnabled ? "unavailable" : "not_connected",
            name: groupName
          };

          return [tenant.id, {
            hostname: tenant.hostname || `${tenant.slug}.${baseDomain}`,
            dns: { state: dnsByTenant.get(tenant.id) ? "ready" : "missing" },
            authentikGroup: { ...group, name: group.name || groupName },
            leaderAccess: {
              state: activeAdminCount > 0
                ? "ready"
                : pendingAdminInviteCount > 0
                  ? "pending"
                  : "missing",
              activeAdminCount,
              pendingInviteCount: pendingAdminInviteCount
            },
            packetImport: {
              state: packetImportCount > 0 ? "ready" : "missing",
              count: packetImportCount
            }
          }];
        }))
      };
    }
  });
}

let defaultInspector;

export function inspectPlatformSetup(tenants) {
  if (!defaultInspector) {
    defaultInspector = createPlatformSetupInspector({
      baseDomain: config.baseDomain,
      storageRoot: config.storage.root,
      provisioningEnabled: config.authentikProvisioning.enabled,
      authentikOrigin: config.authentikProvisioning.origin,
      authentikToken: config.authentikProvisioning.token,
      tenantGroupPrefix: config.authentikProvisioning.tenantGroupPrefix,
      authentikTimeoutMs: config.authentikProvisioning.requestTimeoutMs
    });
  }
  return defaultInspector.inspect(tenants);
}
