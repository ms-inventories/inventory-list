import { pathToFileURL } from "node:url";
import { loadEnv } from "vite";

export const DEFAULT_OIDC_SCOPE = "openid profile email groups offline_access";

export function assertRenewableOidcScope(scope = DEFAULT_OIDC_SCOPE) {
  const scopes = new Set(String(scope || "").trim().split(/\s+/).filter(Boolean));
  if (!scopes.has("offline_access")) {
    throw new Error(
      "Production VITE_OIDC_SCOPE must include offline_access so signed-in sessions can renew without redirecting. Attach Authentik's offline_access scope mapping before deploying."
    );
  }
  return scopes;
}

export function readProductionOidcScope({ cwd = process.cwd(), environment = process.env } = {}) {
  const fileEnvironment = loadEnv("production", cwd, "");
  return environment.VITE_OIDC_SCOPE || fileEnvironment.VITE_OIDC_SCOPE || DEFAULT_OIDC_SCOPE;
}

function isDirectRun() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectRun()) {
  assertRenewableOidcScope(readProductionOidcScope());
}
