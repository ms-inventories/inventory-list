import crypto from "node:crypto";

export const AUTHENTIK_ORIGIN = process.env.MVP_AUTHENTIK_ORIGIN || "https://auth.876en.org";
export const API_ORIGIN = process.env.MVP_API_ORIGIN || "https://api.876en.org";
export const TENANT_ORIGIN = process.env.MVP_TENANT_ORIGIN || "https://ms.876en.org";
export const ADMIN_ORIGIN = process.env.MVP_ADMIN_ORIGIN || "https://admin.876en.org";
export const CLIENT_ID = process.env.MVP_OIDC_CLIENT_ID || "kqEeiCB9UgmaDlU5dUi3YziORFIIGxbAxz7S9mLC";
export const OIDC_SCOPE = process.env.MVP_OIDC_SCOPE || "openid profile email groups ak_user_uuid";

const REQUEST_TIMEOUT_MS = 20_000;

export function requiredEnv(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function withTimeout(options = {}) {
  return {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
}

class CookieSession {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
  }

  absorb(response) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : [];
    for (const raw of values) {
      const pair = String(raw || "").split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
  }

  csrfToken() {
    return this.cookies.get("authentik_csrf") || this.cookies.get("csrftoken") || "";
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  async fetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookies.size) headers.set("Cookie", this.cookieHeader());
    if (options.method && options.method !== "GET" && options.method !== "HEAD") {
      const csrf = this.csrfToken();
      if (csrf) {
        headers.set("X-Authentik-CSRF", csrf);
        headers.set("X-CSRFToken", csrf);
      }
      headers.set("Origin", this.origin);
      headers.set("Referer", `${this.origin}/`);
    }
    const response = await fetch(url, withTimeout({
      ...options,
      headers,
      redirect: options.redirect || "manual"
    }));
    this.absorb(response);
    return response;
  }
}

export async function responseData(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    return JSON.parse(text);
  }
  return { textLength: text.length };
}

function safeStageFailure(response, data) {
  const component = data?.component || "unknown";
  const errorKeys = data?.response_errors && typeof data.response_errors === "object"
    ? Object.keys(data.response_errors)
    : [];
  return `Authentik flow failed (${response.status}, ${component}${errorKeys.length ? `, ${errorKeys.join(",")}` : ""})`;
}

export async function solveAuthentication(username, password) {
  const session = new CookieSession(AUTHENTIK_ORIGIN);
  const flowUrl = `${AUTHENTIK_ORIGIN}/api/v3/flows/executor/default-authentication-flow/?query=`;
  let response = await session.fetch(flowUrl, { headers: { Accept: "application/json" } });
  let redirects = 0;
  while (response.status >= 300 && response.status < 400 && redirects < 5) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Authentik flow redirect omitted its destination (${response.status})`);
    const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
    if (nextUrl.origin !== new URL(AUTHENTIK_ORIGIN).origin) {
      throw new Error(`Authentik flow redirected to an unexpected origin (${response.status})`);
    }
    response = await session.fetch(nextUrl, { headers: { Accept: "application/json" } });
    redirects += 1;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Authentik flow redirect loop");
  }

  let challenge = await responseData(response);
  if (!response.ok) throw new Error(safeStageFailure(response, challenge));
  for (let step = 0; step < 10; step += 1) {
    const component = challenge?.component;
    if (component === "xak-flow-redirect" || component === "ak-stage-session-end") return session;
    if (component === "ak-stage-access-denied" || component === "ak-stage-flow-error") {
      throw new Error(safeStageFailure(response, challenge));
    }

    let body;
    if (component === "ak-stage-identification") {
      body = { component, uid_field: username, password };
    } else if (component === "ak-stage-password") {
      body = { component, password };
    } else if (component === "ak-stage-autosubmit" || component === "ak-stage-user-login") {
      body = { component };
    } else {
      throw new Error(`Authentik requires unsupported authentication step ${component || "unknown"}`);
    }

    response = await session.fetch(flowUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let stageRedirects = 0;
    while (response.status >= 300 && response.status < 400 && stageRedirects < 5) {
      const meResponse = await session.fetch(`${AUTHENTIK_ORIGIN}/api/v3/core/users/me/`, {
        headers: { Accept: "application/json" }
      });
      const me = await responseData(meResponse);
      if (meResponse.ok && me?.user && me.user.is_anonymous !== true) return session;

      const location = response.headers.get("location");
      if (!location) throw new Error(`Authentik stage redirect omitted its destination (${response.status})`);
      const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
      if (nextUrl.origin !== new URL(AUTHENTIK_ORIGIN).origin) {
        throw new Error(`Authentik stage redirected to an unexpected origin (${response.status})`);
      }
      response = await session.fetch(nextUrl, { headers: { Accept: "application/json" } });
      stageRedirects += 1;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Authentik stage redirect loop");
    }
    challenge = await responseData(response);
    if (!response.ok) throw new Error(safeStageFailure(response, challenge));
  }
  throw new Error("Authentik authentication did not finish within ten stages");
}

export async function oidcAccessToken(username, password) {
  const session = await solveAuthentication(username, password);
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const authorizeQuery = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${ADMIN_ORIGIN}/`,
    response_type: "code",
    scope: OIDC_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  let response = await session.fetch(
    `${AUTHENTIK_ORIGIN}/application/o/authorize/?${authorizeQuery}`,
    { headers: { Accept: "text/html,application/xhtml+xml" } }
  );
  let redirects = 0;
  while (response.status >= 300 && response.status < 400 && redirects < 8) {
    const location = response.headers.get("location");
    if (!location) throw new Error("OIDC redirect omitted its destination");
    const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
    if (nextUrl.origin === new URL(ADMIN_ORIGIN).origin && nextUrl.searchParams.has("code")) {
      if (nextUrl.searchParams.get("state") !== state) throw new Error("OIDC state mismatch");
      const tokenResponse = await fetch(`${AUTHENTIK_ORIGIN}/application/o/token/`, withTimeout({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: `${ADMIN_ORIGIN}/`,
          code: nextUrl.searchParams.get("code"),
          code_verifier: verifier
        })
      }));
      const tokenData = await responseData(tokenResponse);
      if (!tokenResponse.ok || !tokenData?.access_token) {
        throw new Error(`OIDC token exchange failed (${tokenResponse.status})`);
      }
      return tokenData.access_token;
    }
    response = await session.fetch(nextUrl, { headers: { Accept: "text/html,application/xhtml+xml" } });
    redirects += 1;
  }
  throw new Error(`OIDC authorization did not return a code (${response.status})`);
}

export async function authentikRequest(session, path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await session.fetch(`${AUTHENTIK_ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await responseData(response);
  if (!response.ok) throw new Error(`Authentik API ${method} ${path} failed (${response.status})`);
  return data;
}

export async function appRequest(path, { token, method = "GET", body, tenantSlug = "" } = {}) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Origin: ADMIN_ORIGIN
  };
  if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ORIGIN}${path}`, withTimeout({
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  const data = await responseData(response);
  if (!response.ok) {
    const code = data?.code || "unknown";
    throw new Error(`Inventory API ${method} ${path} failed (${response.status}, ${code})`);
  }
  return data;
}
