import "dotenv/config";
import crypto from "node:crypto";

const environment = process.env.NODE_ENV || "development";
const baseDomain = String(process.env.BASE_DOMAIN || "876en.org").toLowerCase();
const configuredMediaSigningSecret = String(process.env.MEDIA_SIGNING_SECRET || "").trim();
const generatedMediaSigningSecret = configuredMediaSigningSecret
  ? ""
  : crypto.randomBytes(32).toString("base64url");

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function hasStrongMediaSecret(value) {
  try {
    const normalized = String(value || "").trim();
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) return false;
    return Buffer.from(normalized, "base64url").length >= 32;
  } catch {
    return false;
  }
}

export const config = {
  env: environment,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
  baseDomain,
  publicAppUrl: String(process.env.PUBLIC_APP_URL || `https://${process.env.BASE_DOMAIN || "876en.org"}`).replace(/\/+$/, ""),
  platformAdminEmails: splitCsv(process.env.PLATFORM_ADMIN_EMAILS).map(email => email.toLowerCase()),
  platformAdminSubjects: splitCsv(process.env.PLATFORM_ADMIN_SUBJECTS).map(subject => subject.toLowerCase()),
  allowDevAuth: String(process.env.ALLOW_DEV_AUTH || "").toLowerCase() === "true",
  corsOrigins: splitCsv(process.env.CORS_ORIGINS),
  oidc: {
    clientId: process.env.OIDC_CLIENT_ID || process.env.VITE_OIDC_CLIENT_ID || process.env.OIDC_AUDIENCE || "",
    issuer: process.env.OIDC_ISSUER || "",
    audience: process.env.OIDC_AUDIENCE || "",
    discoveryUrl: process.env.OIDC_DISCOVERY_URL || "",
    groupsClaim: process.env.OIDC_GROUPS_CLAIM || "groups",
    platformAdminGroup: String(process.env.PLATFORM_ADMIN_GROUP || "876en-admins").toLowerCase(),
    frgAdminGroup: String(process.env.FRG_ADMIN_GROUP || "876en-frg-admins").toLowerCase(),
    tenantAdminGroup: String(process.env.TENANT_ADMIN_GROUP || "876en-platoon-admin").toLowerCase(),
    tenantGroupPrefix: String(process.env.TENANT_GROUP_PREFIX || "876en-").toLowerCase()
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || "local",
    root: process.env.STORAGE_ROOT || "/data/inventory-uploads",
    publicMediaBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL || (environment === "production" ? `https://api.${baseDomain}/media` : ""),
    mediaSigningSecret: configuredMediaSigningSecret || generatedMediaSigningSecret,
    mediaSigningSecretIsEphemeral: !configuredMediaSigningSecret,
    mediaSessionTtlSeconds: boundedInteger(process.env.MEDIA_SESSION_TTL_SECONDS, 300, 30, 3600),
    mediaUploadStagingTtlHours: boundedInteger(process.env.MEDIA_UPLOAD_STAGING_TTL_HOURS, 24, 1, 168)
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
  if (!hasStrongMediaSecret(config.storage.mediaSigningSecret)) {
    missing.push("MEDIA_SIGNING_SECRET (base64 for at least 32 random bytes)");
  }
  try {
    const mediaBaseUrl = new URL(config.storage.publicMediaBaseUrl);
    if (mediaBaseUrl.protocol !== "https:" || !mediaBaseUrl.pathname.replace(/\/+$/, "").endsWith("/media")) {
      missing.push("PUBLIC_MEDIA_BASE_URL (HTTPS API /media URL)");
    }
  } catch {
    missing.push("PUBLIC_MEDIA_BASE_URL (HTTPS API /media URL)");
  }
  if (!config.platformAdminEmails.length && !config.platformAdminSubjects.length) {
    missing.push("PLATFORM_ADMIN_EMAILS or PLATFORM_ADMIN_SUBJECTS");
  }

  if (missing.length) {
    throw new Error(`Missing required production config: ${missing.join(", ")}`);
  }

  if (config.allowDevAuth) {
    throw new Error("ALLOW_DEV_AUTH must be false in production");
  }
}
