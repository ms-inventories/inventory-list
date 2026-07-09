import { appConfig } from "../config.js";

const AUTH_SESSION_KEY = "inventory.auth.session";
const OIDC_STATE_KEY = "inventory.oidc.state";
const OIDC_VERIFIER_KEY = "inventory.oidc.verifier";

export class AuthFlowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AuthFlowError";
    this.code = code;
    this.details = details;
  }
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(hash));
}

async function getOidcDiscovery() {
  if (appConfig.oidc.authorizationEndpoint && appConfig.oidc.tokenEndpoint) {
    return {
      authorization_endpoint: appConfig.oidc.authorizationEndpoint,
      token_endpoint: appConfig.oidc.tokenEndpoint
    };
  }

  let response;
  try {
    response = await fetch(appConfig.oidc.discoveryUrl, { cache: "no-store" });
  } catch (error) {
    throw new AuthFlowError("oidc_discovery_network", "Could not reach the sign-in service.", {
      cause: error?.message || String(error),
      discoveryUrl: appConfig.oidc.discoveryUrl
    });
  }

  if (!response.ok) {
    throw new AuthFlowError("oidc_discovery_failed", "The sign-in service did not return its configuration.", {
      status: response.status,
      discoveryUrl: appConfig.oidc.discoveryUrl
    });
  }

  let discovery;
  try {
    discovery = await response.json();
  } catch {
    throw new AuthFlowError("oidc_discovery_invalid", "The sign-in service returned an invalid configuration.", {
      status: response.status,
      discoveryUrl: appConfig.oidc.discoveryUrl
    });
  }

  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new AuthFlowError("oidc_discovery_incomplete", "The sign-in service configuration is missing required endpoints.", {
      discoveryUrl: appConfig.oidc.discoveryUrl
    });
  }
  return discovery;
}

function getRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function buildApiUrl(path) {
  const base = String(appConfig.apiBaseUrl || "/api").replace(/\/+$/, "");
  const cleanPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

function cleanRedirectUrl(returnTo) {
  window.history.replaceState({}, "", returnTo || `${window.location.pathname}${window.location.hash || ""}`);
}

async function parseTokenResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new AuthFlowError("token_exchange_invalid_response", "The inventory API returned an invalid sign-in response.", {
      status: response.status,
      raw: text.slice(0, 240)
    });
  }
}

export function readAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveAuthSession(session) {
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

export function clearAuthSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
}

export function getSessionAccessToken(session) {
  if (!session?.accessToken) return "";
  if (session.expiresAt && Date.now() > session.expiresAt - 30000) return "";
  return session.accessToken;
}

export async function beginOidcLogin(returnTo = `${window.location.pathname}${window.location.hash || ""}`) {
  const discovery = await getOidcDiscovery();
  const state = randomString(24);
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);

  sessionStorage.setItem(OIDC_STATE_KEY, JSON.stringify({ state, returnTo, createdAt: Date.now() }));
  sessionStorage.setItem(OIDC_VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: appConfig.oidc.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: appConfig.oidc.scope,
    state
  });

  window.location.assign(`${discovery.authorization_endpoint}?${params.toString()}`);
}

export async function completeOidcRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) return null;

  const storedState = JSON.parse(sessionStorage.getItem(OIDC_STATE_KEY) || "null");
  const verifier = sessionStorage.getItem(OIDC_VERIFIER_KEY);
  sessionStorage.removeItem(OIDC_STATE_KEY);
  sessionStorage.removeItem(OIDC_VERIFIER_KEY);

  if (!storedState?.state || storedState.state !== returnedState || !verifier) {
    cleanRedirectUrl();
    throw new AuthFlowError("state_mismatch", "The sign-in session expired. Try signing in again.");
  }

  let response;
  try {
    response = await fetch(buildApiUrl("/auth/oidc/token"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        code,
        codeVerifier: verifier,
        redirectUri: getRedirectUri()
      }),
      cache: "no-store"
    });
  } catch (error) {
    cleanRedirectUrl(storedState.returnTo);
    throw new AuthFlowError("token_exchange_network", "Could not reach the inventory API to finish sign-in.", {
      cause: error?.message || String(error),
      apiBaseUrl: appConfig.apiBaseUrl
    });
  }

  let tokenSet;
  try {
    tokenSet = await parseTokenResponse(response);
  } catch (error) {
    cleanRedirectUrl(storedState.returnTo);
    throw error;
  }
  if (!response.ok) {
    cleanRedirectUrl(storedState.returnTo);
    throw new AuthFlowError("token_exchange_failed", tokenSet?.error_description || tokenSet?.error || "Sign-in was rejected.", {
      status: response.status
    });
  }

  const expiresIn = Number(tokenSet.expires_in || 3600);
  const session = {
    accessToken: tokenSet.access_token,
    idToken: tokenSet.id_token || "",
    refreshToken: tokenSet.refresh_token || "",
    expiresAt: Date.now() + expiresIn * 1000,
    createdAt: Date.now()
  };

  saveAuthSession(session);
  cleanRedirectUrl(storedState.returnTo);
  return session;
}
