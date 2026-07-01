const RESERVED_SUBDOMAINS = new Set(["api", "auth", "coolify", "www"]);

export const appConfig = {
  baseDomain: import.meta.env.VITE_BASE_DOMAIN || "876en.org",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "/api",
  legacyBucketBaseUrl: import.meta.env.VITE_LEGACY_BUCKET_BASE_URL || "https://ms-inventories.s3.us-east-1.amazonaws.com",
  enableDemoFallback: import.meta.env.VITE_ENABLE_DEMO_FALLBACK !== "false"
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
