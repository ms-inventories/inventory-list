import { config } from "./config.js";
import { query } from "./db.js";

function getRequestHost(request) {
  const forwarded = request.headers["x-forwarded-host"];
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded || request.headers.host || "";
  return String(host).split(",")[0].trim().split(":")[0].toLowerCase();
}

function getTenantSlugHeader(request) {
  const value = request.headers["x-tenant-slug"];
  const slug = Array.isArray(value) ? value[0] : value;
  const normalized = String(slug || "").trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : "";
}

export function tenantSlugFromHost(request) {
  let host = getRequestHost(request);
  const baseDomain = config.baseDomain.toLowerCase();
  const headerSlug = getTenantSlugHeader(request);

  if (headerSlug && (host === baseDomain || host === `api.${baseDomain}`)) return headerSlug;
  if (host.startsWith("api.")) host = host.slice(4);
  if (host === baseDomain) return "";

  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return "";

  const subdomain = host.slice(0, -suffix.length);
  return subdomain.split(".").filter(Boolean).pop() || "";
}

export async function resolveTenant(request) {
  const host = getRequestHost(request);
  const slug = tenantSlugFromHost(request);

  const result = await query(
    `
      SELECT t.id, t.slug, t.name, t.status
      FROM tenants t
      LEFT JOIN tenant_domains d ON d.tenant_id = t.id
      WHERE t.status = 'active'
        AND (t.slug = $1 OR d.hostname = $2)
      LIMIT 1
    `,
    [slug, host]
  );

  return result.rows[0] || null;
}

export async function getTenantMembership(tenantId, userId) {
  if (!tenantId || !userId) return null;

  const result = await query(
    `
      SELECT id, tenant_id, user_id, role, status
      FROM tenant_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1
    `,
    [tenantId, userId]
  );

  return result.rows[0] || null;
}

function roleRank(role) {
  return {
    viewer: 1,
    contributor: 2,
    tenant_admin: 3
  }[role] || 0;
}

function groupMembershipForTenant(tenant, userId, identity) {
  if (!tenant || !identity) return null;

  if (identity.isPlatformAdmin) {
    return {
      id: `authentik:${tenant.slug}:platform-admin`,
      tenant_id: tenant.id,
      user_id: userId,
      role: "tenant_admin",
      status: "active",
      source: "authentik"
    };
  }

  const groups = identity.groups || [];
  const tenantGroup = `${config.oidc.tenantGroupPrefix}${tenant.slug}`.toLowerCase();
  if (!groups.includes(tenantGroup)) return null;

  const role = groups.includes(config.oidc.tenantAdminGroup) ? "tenant_admin" : "contributor";
  return {
    id: `authentik:${tenant.slug}:${role}`,
    tenant_id: tenant.id,
    user_id: userId,
    role,
    status: "active",
    source: "authentik"
  };
}

function mergeMembership(databaseMembership, authentikMembership) {
  if (!databaseMembership) return authentikMembership;
  if (!authentikMembership) return databaseMembership;
  if (roleRank(authentikMembership.role) <= roleRank(databaseMembership.role)) return databaseMembership;

  return {
    ...databaseMembership,
    role: authentikMembership.role,
    source: "authentik"
  };
}

export function hasTenantRole(context, roles) {
  if (context.identity?.isPlatformAdmin) return true;
  if (!context.membership) return false;
  return roles.includes(context.membership.role);
}

export async function tenantContext(request, auth) {
  const tenant = await resolveTenant(request);
  const databaseMembership = tenant ? await getTenantMembership(tenant.id, auth.user.id) : null;
  const authentikMembership = groupMembershipForTenant(tenant, auth.user.id, auth.identity);
  const membership = mergeMembership(databaseMembership, authentikMembership);

  return {
    ...auth,
    tenant,
    membership
  };
}
