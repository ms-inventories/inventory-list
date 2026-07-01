import "dotenv/config";

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
  baseDomain: String(process.env.BASE_DOMAIN || "inventory.bensonhub.com").toLowerCase(),
  allowDevAuth: String(process.env.ALLOW_DEV_AUTH || "").toLowerCase() === "true",
  corsOrigins: splitCsv(process.env.CORS_ORIGINS),
  oidc: {
    issuer: process.env.OIDC_ISSUER || "",
    audience: process.env.OIDC_AUDIENCE || "",
    discoveryUrl: process.env.OIDC_DISCOVERY_URL || "",
    groupsClaim: process.env.OIDC_GROUPS_CLAIM || "groups",
    platformAdminGroup: process.env.PLATFORM_ADMIN_GROUP || "inventory-platform-admins"
  }
};

export function assertProductionConfig() {
  if (config.env !== "production") return;

  const missing = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.oidc.issuer) missing.push("OIDC_ISSUER");
  if (!config.oidc.audience) missing.push("OIDC_AUDIENCE");

  if (missing.length) {
    throw new Error(`Missing required production config: ${missing.join(", ")}`);
  }

  if (config.allowDevAuth) {
    throw new Error("ALLOW_DEV_AUTH must be false in production");
  }
}
