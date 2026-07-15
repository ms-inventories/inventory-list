import {
  API_ORIGIN,
  appRequest,
  authentikRequest,
  oidcAccessToken,
  requiredEnv,
  solveAuthentication
} from "./production-auth-session.mjs";

const ADMIN_USERNAME = requiredEnv("MVP_ADMIN_USERNAME");
const ADMIN_PASSWORD = requiredEnv("MVP_ADMIN_PASSWORD");
const AUTHENTIK_ADMIN_USERNAME = requiredEnv("MVP_AUTHENTIK_ADMIN_USERNAME");
const AUTHENTIK_ADMIN_PASSWORD = requiredEnv("MVP_AUTHENTIK_ADMIN_PASSWORD");
const TENANT_SLUG = requiredEnv("MVP_RESET_TENANT_SLUG").trim().toLowerCase();
const CONFIRMATION = requiredEnv("MVP_RESET_CONFIRMATION");
const RESERVED_SLUGS = new Set(["admin", "api", "auth", "coolify", "www"]);

if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(TENANT_SLUG) || RESERVED_SLUGS.has(TENANT_SLUG)) {
  throw new Error("MVP_RESET_TENANT_SLUG is not a resettable workspace slug");
}
if (CONFIRMATION !== `DELETE ${TENANT_SLUG}`) {
  throw new Error(`MVP_RESET_CONFIRMATION must equal DELETE ${TENANT_SLUG}`);
}

const checks = [];
const adminToken = await oidcAccessToken(ADMIN_USERNAME, ADMIN_PASSWORD);
const adminMe = await appRequest("/api/me", { token: adminToken });
if (adminMe?.isPlatformAdmin !== true) throw new Error("Reset operator is not a platform administrator");
checks.push("platform-admin-verified");

const before = await appRequest("/api/platform/tenants", { token: adminToken });
const matches = (before?.tenants || []).filter(tenant => tenant.slug === TENANT_SLUG);
if (matches.length !== 1) throw new Error("Expected exactly one workspace with the reset slug");
const tenant = matches[0];
checks.push("workspace-found");

const authentikAdmin = await solveAuthentication(
  AUTHENTIK_ADMIN_USERNAME,
  AUTHENTIK_ADMIN_PASSWORD
);
const authentikMe = await authentikRequest(authentikAdmin, "/api/v3/core/users/me/");
if (authentikMe?.user?.is_superuser !== true && authentikMe?.is_superuser !== true) {
  throw new Error("Authentik reset operator is not a superuser");
}
checks.push("authentik-admin-verified");

const groupName = `876en-${TENANT_SLUG}`;
const groupData = await authentikRequest(
  authentikAdmin,
  `/api/v3/core/groups/?name=${encodeURIComponent(groupName)}&page_size=20&include_parents=true`
);
const groups = (groupData?.results || []).filter(group => group.name === groupName);
if (groups.length > 1) throw new Error("Authentik returned duplicate exact workspace groups");
const group = groups[0] || null;
if (group) {
  if (
    group.is_superuser !== false
    || group.parents?.length
    || group.roles?.length
    || group.attributes?.inventory_list_managed !== true
    || String(group.attributes?.inventory_tenant_id || "").toLowerCase() !== String(tenant.id).toLowerCase()
    || String(group.attributes?.inventory_tenant_slug || "").toLowerCase() !== TENANT_SLUG
  ) {
    throw new Error("Refusing to remove a workspace group without exact safe ownership tags");
  }
  await authentikRequest(authentikAdmin, `/api/v3/core/groups/${group.pk}/`, { method: "DELETE" });
}
checks.push("workspace-group-removed");

const reset = await appRequest(`/api/platform/tenants/${tenant.id}`, {
  token: adminToken,
  method: "DELETE",
  body: { confirmSlug: TENANT_SLUG }
});
if (reset?.reset?.tenant?.slug !== TENANT_SLUG) throw new Error("Reset response did not identify the requested workspace");
if (reset?.reset?.storageCleanup !== "complete") throw new Error("Workspace database reset succeeded but storage cleanup failed");
checks.push("workspace-data-removed");
checks.push("workspace-storage-removed");

const after = await appRequest("/api/platform/tenants", { token: adminToken });
if ((after?.tenants || []).some(candidate => candidate.slug === TENANT_SLUG)) {
  throw new Error("Workspace still appears in the platform tenant list after reset");
}
const groupAfter = await authentikRequest(
  authentikAdmin,
  `/api/v3/core/groups/?name=${encodeURIComponent(groupName)}&page_size=20`
);
if ((groupAfter?.results || []).some(candidate => candidate.name === groupName)) {
  throw new Error("Workspace group still exists after reset");
}
checks.push("workspace-absence-verified");
checks.push("slug-ready-for-recreation");

const tenantResponse = await fetch(`${API_ORIGIN}/api/tenant`, {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${adminToken}`,
    "X-Tenant-Slug": TENANT_SLUG
  }
});
if (tenantResponse.status !== 404) {
  await tenantResponse.body?.cancel?.().catch(() => {});
  throw new Error(`Reset workspace still resolves through the tenant API (${tenantResponse.status})`);
}
checks.push("tenant-route-cleared");

console.log(JSON.stringify({
  ok: true,
  slug: TENANT_SLUG,
  removed: reset.reset.removed,
  checks
}));
