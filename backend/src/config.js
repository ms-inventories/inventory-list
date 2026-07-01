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
  baseDomain: String(process.env.BASE_DOMAIN || "inventory.876en.org").toLowerCase(),
  allowDevAuth: String(process.env.ALLOW_DEV_AUTH || "").toLowerCase() === "true",
  corsOrigins: splitCsv(process.env.CORS_ORIGINS),
  oidc: {
    issuer: process.env.OIDC_ISSUER || "",
    audience: process.env.OIDC_AUDIENCE || "",
    discoveryUrl: process.env.OIDC_DISCOVERY_URL || "",
    groupsClaim: process.env.OIDC_GROUPS_CLAIM || "groups",
    platformAdminGroup: process.env.PLATFORM_ADMIN_GROUP || "inventory-platform-admins"
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || "local",
    root: process.env.STORAGE_ROOT || "/data/inventory-uploads",
    publicMediaBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL || ""
  },
  email: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    fromName: process.env.EMAIL_FROM_NAME || "876 EN Inventory",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "no-reply@876en.org"
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
