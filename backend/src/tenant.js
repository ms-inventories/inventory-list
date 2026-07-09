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
      WHERE tenant_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [tenantId, userId]
  );

  return result.rows[0] ? { ...result.rows[0], source: "database" } : null;
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

  const groups = identity.groups || [];
  const tenantGroup = `${config.oidc.tenantGroupPrefix}${tenant.slug}`.toLowerCase();
  const adminGroup = String(config.oidc.tenantAdminGroup || "").toLowerCase();

  if (identity.isPlatformAdmin) {
    return {
      id: `authentik:${tenant.slug}:platform-admin`,
      tenant_id: tenant.id,
      user_id: userId,
      role: "tenant_admin",
      status: "active",
      source: "platform_admin",
      matchedGroups: groups,
      expectedTenantGroup: tenantGroup,
      expectedTenantAdminGroup: adminGroup,
      platformAdminOverride: true
    };
  }

  if (!groups.includes(tenantGroup)) return null;

  const role = groups.includes(adminGroup) ? "tenant_admin" : "contributor";
  const matchedGroups = [tenantGroup, role === "tenant_admin" ? adminGroup : ""].filter(Boolean);
  return {
    id: `authentik:${tenant.slug}:${role}`,
    tenant_id: tenant.id,
    user_id: userId,
    role,
    status: "active",
    source: "authentik",
    matchedGroups,
    expectedTenantGroup: tenantGroup,
    expectedTenantAdminGroup: adminGroup,
    platformAdminOverride: false
  };
}

function mergeMembership(databaseMembership, authentikMembership) {
  const activeDatabaseMembership = databaseMembership?.status === "active" ? databaseMembership : null;

  if (!activeDatabaseMembership) return authentikMembership;
  if (!authentikMembership) return activeDatabaseMembership;
  if (roleRank(authentikMembership.role) <= roleRank(activeDatabaseMembership.role)) return activeDatabaseMembership;

  return {
    ...activeDatabaseMembership,
    role: authentikMembership.role,
    source: authentikMembership.source,
    matchedGroups: authentikMembership.matchedGroups,
    platformAdminOverride: authentikMembership.platformAdminOverride
  };
}

function accessMembership(membership) {
  if (!membership) return null;

  return {
    id: membership.id,
    tenantId: membership.tenant_id,
    userId: membership.user_id,
    role: membership.role,
    status: membership.status,
    source: membership.source || "database",
    matchedGroups: membership.matchedGroups || [],
    platformAdminOverride: Boolean(membership.platformAdminOverride)
  };
}

function buildAccessDetails(tenant, identity, databaseMembership, authentikMembership, membership) {
  const tenantGroup = tenant ? `${config.oidc.tenantGroupPrefix}${tenant.slug}`.toLowerCase() : "";
  const tenantAdminGroup = String(config.oidc.tenantAdminGroup || "").toLowerCase();
  const warnings = [];

  if (identity?.isPlatformAdmin && tenant) {
    warnings.push({
      type: "platform_admin_override",
      severity: "info",
      message: "Platform admin override grants platoon admin access here."
    });
  }

  if (databaseMembership?.status && databaseMembership.status !== "active" && authentikMembership) {
    warnings.push({
      type: "inactive_database_membership",
      severity: "warning",
      message: `Database membership is ${databaseMembership.status}, but Authentik still grants access.`
    });
  }

  if (databaseMembership?.status === "active" && authentikMembership && databaseMembership.role !== authentikMembership.role) {
    const databaseRank = roleRank(databaseMembership.role);
    const authentikRank = roleRank(authentikMembership.role);
    warnings.push({
      type: "role_mismatch",
      severity: "warning",
      message: authentikRank > databaseRank
        ? "Authentik grants a higher role than the database membership."
        : "Database membership grants a higher role than the Authentik group."
    });
  }

  if (databaseMembership?.status === "active" && !authentikMembership) {
    warnings.push({
      type: "authentik_group_missing",
      severity: "info",
      message: "Database membership grants access, but no matching Authentik tenant group was found."
    });
  }

  if (!membership && tenant) {
    warnings.push({
      type: "tenant_access_missing",
      severity: "warning",
      message: "No active database membership or matching Authentik group grants access."
    });
  }

  return {
    source: membership?.source || null,
    effectiveRole: membership?.role || null,
    effectiveStatus: membership?.status || null,
    databaseMembership: accessMembership(databaseMembership),
    authentikMembership: accessMembership(authentikMembership),
    platformAdminOverride: Boolean(identity?.isPlatformAdmin),
    expectedTenantGroup: tenantGroup,
    expectedTenantAdminGroup: tenantAdminGroup,
    matchedGroups: authentikMembership?.matchedGroups || [],
    warnings
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
  const access = buildAccessDetails(tenant, auth.identity, databaseMembership, authentikMembership, membership);

  return {
    ...auth,
    tenant,
    membership,
    access
  };
}
