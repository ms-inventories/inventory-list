import { config } from "./config.js";
import { query } from "./db.js";

function getRequestHost(request) {
  const forwarded = request.headers["x-forwarded-host"];
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded || request.headers.host || "";
  return String(host).split(",")[0].trim().split(":")[0].toLowerCase();
}

export function tenantSlugFromHost(request) {
  let host = getRequestHost(request);
  const baseDomain = config.baseDomain.toLowerCase();

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

export function hasTenantRole(context, roles) {
  if (context.identity?.isPlatformAdmin) return true;
  if (!context.membership) return false;
  return roles.includes(context.membership.role);
}

export async function tenantContext(request, auth) {
  const tenant = await resolveTenant(request);
  const membership = tenant ? await getTenantMembership(tenant.id, auth.user.id) : null;

  return {
    ...auth,
    tenant,
    membership
  };
}
