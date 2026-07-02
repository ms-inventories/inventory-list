const RESERVED_SUBDOMAINS = new Set(["admin", "api", "auth", "coolify", "www"]);

function getBrowserHostname() {
  return typeof window === "undefined" ? "" : window.location.hostname;
}

function getDefaultApiBaseUrl() {
  const hostname = getBrowserHostname().toLowerCase();
  const baseDomain = (import.meta.env.VITE_BASE_DOMAIN || "876en.org").toLowerCase();

  if (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)) {
    return `https://api.${baseDomain}/api`;
  }

  return "/api";
}

export const appConfig = {
  baseDomain: import.meta.env.VITE_BASE_DOMAIN || "876en.org",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || getDefaultApiBaseUrl(),
  legacyBucketBaseUrl: import.meta.env.VITE_LEGACY_BUCKET_BASE_URL || "https://ms-inventories.s3.us-east-1.amazonaws.com",
  enableDemoFallback: import.meta.env.VITE_ENABLE_DEMO_FALLBACK !== "false",
  enableQaAuth: import.meta.env.VITE_ENABLE_QA_AUTH === "true",
  oidc: {
    clientId: import.meta.env.VITE_OIDC_CLIENT_ID || "inventory-web",
    discoveryUrl: import.meta.env.VITE_OIDC_DISCOVERY_URL || "https://auth.876en.org/application/o/inventory/.well-known/openid-configuration",
    scope: import.meta.env.VITE_OIDC_SCOPE || "openid profile email groups"
  }
};

export function getTenantSlugFromHostname(hostname = window.location.hostname) {
  const cleanHost = String(hostname || "").split(":")[0].toLowerCase();
  const baseDomain = appConfig.baseDomain.toLowerCase();

  if (!cleanHost || cleanHost === "localhost" || cleanHost === "127.0.0.1") return "";
  if (cleanHost === baseDomain) return "";
  if (!cleanHost.endsWith(`.${baseDomain}`)) return "";

  const subdomain = cleanHost.slice(0, -(baseDomain.length + 1)).split(".").pop() || "";
  if (RESERVED_SUBDOMAINS.has(subdomain)) return "";
  return subdomain;
}

export function isAdminHostname(hostname = getBrowserHostname()) {
  return String(hostname || "").split(":")[0].toLowerCase() === `admin.${appConfig.baseDomain.toLowerCase()}`;
}
