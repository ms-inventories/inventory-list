import { appConfig } from "../config.js";

const AUTH_SESSION_KEY = "inventory.auth.session";
const OIDC_STATE_KEY = "inventory.oidc.state";
const OIDC_VERIFIER_KEY = "inventory.oidc.verifier";

export const AUTH_SESSION_INVALIDATED_EVENT = "inventory:auth-session-invalidated";
export const AUTH_SESSION_REFRESH_EVENT = "inventory:auth-session-refresh";

let currentRedirectCompletion = null;
let currentSessionRefresh = null;
let authSessionGeneration = 0;
let reconnectRequired = false;
let authSessionEnding = false;

function notifyAuthSessionRefresh(state, session = null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_REFRESH_EVENT, {
    detail: { state, session }
  }));
}

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

function notifyRouteChanged() {
  window.dispatchEvent(new PopStateEvent("popstate"));
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
  authSessionEnding = false;
  reconnectRequired = false;
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

export function clearAuthSession() {
  reconnectRequired = false;
  localStorage.removeItem(AUTH_SESSION_KEY);
}

export function authSessionRequiresReconnect() {
  return reconnectRequired;
}

export async function endOidcSession() {
  authSessionEnding = true;
  authSessionGeneration += 1;
  const pendingRefresh = currentSessionRefresh?.promise || null;
  clearAuthSession();
  try {
    if (pendingRefresh) await pendingRefresh.catch(() => null);
    const response = await fetch(buildApiUrl("/auth/oidc/logout"), {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "include"
    });
    if (!response.ok) {
      throw new AuthFlowError("logout_failed", "The app could not finish signing out. Try again.", {
        status: response.status
      });
    }
  } finally {
    clearAuthSession();
  }
}

export function invalidateAuthSession(accessToken, reason = "unauthorized") {
  const session = readAuthSession();
  if (!session?.accessToken || (accessToken && session.accessToken !== accessToken)) return false;

  clearAuthSession();
  reconnectRequired = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_INVALIDATED_EVENT, {
      detail: { reason }
    }));
  }
  return true;
}

export function getSessionAccessToken(session) {
  if (!session?.accessToken) return "";
  if (session.expiresAt && Date.now() > session.expiresAt - 30000 && !authSessionCanRefresh(session)) return "";
  return session.accessToken;
}

export function authSessionCanRefresh(session) {
  return Boolean(session?.refreshToken || session?.refreshAvailable);
}

export function authSessionNeedsRefresh(session, now = Date.now()) {
  if (!session?.accessToken || !authSessionCanRefresh(session)) return false;
  return !session.expiresAt || now >= Number(session.expiresAt) - 60_000;
}

async function refreshAuthSessionOnce(session) {
  const generation = authSessionGeneration;
  let response;
  try {
    response = await fetch(buildApiUrl("/auth/oidc/refresh"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(session?.refreshToken ? { refreshToken: session.refreshToken } : {}),
      cache: "no-store",
      credentials: "include"
    });
  } catch (error) {
    throw new AuthFlowError("token_refresh_network", "Could not renew the sign-in session.", {
      cause: error?.message || String(error),
      apiBaseUrl: appConfig.apiBaseUrl
    });
  }

  const tokenSet = await parseTokenResponse(response);
  if (!response.ok || !tokenSet?.access_token) {
    if ((response.status === 401 || tokenSet?.code === "oidc_refresh_rejected") && session?.accessToken) {
      invalidateAuthSession(session.accessToken, "refresh_rejected");
    }
    throw new AuthFlowError(
      "token_refresh_failed",
      tokenSet?.error_description || tokenSet?.error || "The sign-in session could not be renewed.",
      { status: response.status }
    );
  }

  const expiresIn = Number(tokenSet.expires_in || 3600);
  const refreshedSession = {
    ...(session || {}),
    accessToken: tokenSet.access_token,
    idToken: tokenSet.id_token || session?.idToken || "",
    refreshToken: tokenSet.refresh_token || session?.refreshToken || "",
    refreshAvailable: Boolean(tokenSet.refresh_available || tokenSet.refresh_token || session?.refreshAvailable),
    expiresAt: Date.now() + expiresIn * 1000,
    createdAt: session?.createdAt || Date.now(),
    refreshedAt: Date.now()
  };
  if (generation !== authSessionGeneration) {
    throw new AuthFlowError("token_refresh_cancelled", "Sign-in renewal was cancelled because you signed out.");
  }
  saveAuthSession(refreshedSession);
  return refreshedSession;
}

export async function refreshAuthSession(session = readAuthSession(), { force = false } = {}) {
  if (authSessionEnding) {
    throw new AuthFlowError("token_refresh_cancelled", "Sign-in renewal was cancelled because you signed out.");
  }
  if (!force && (!session?.accessToken || !authSessionCanRefresh(session))) return session;
  if (!force && !authSessionNeedsRefresh(session)) return session;

  const refreshKey = session?.refreshToken || "oidc-cookie";
  if (currentSessionRefresh?.refreshKey === refreshKey) {
    return currentSessionRefresh.promise;
  }

  notifyAuthSessionRefresh("start");
  const promise = refreshAuthSessionOnce(session)
    .then(refreshedSession => {
      notifyAuthSessionRefresh("success", refreshedSession);
      return refreshedSession;
    })
    .catch(error => {
      notifyAuthSessionRefresh("error");
      throw error;
    })
    .finally(() => {
      if (currentSessionRefresh?.promise === promise) currentSessionRefresh = null;
    });
  currentSessionRefresh = { refreshKey, promise };
  return promise;
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

  window.location.replace(`${discovery.authorization_endpoint}?${params.toString()}`);
}

async function completeOidcRedirectOnce(code, returnedState) {
  const storedState = JSON.parse(sessionStorage.getItem(OIDC_STATE_KEY) || "null");
  const verifier = sessionStorage.getItem(OIDC_VERIFIER_KEY);
  sessionStorage.removeItem(OIDC_STATE_KEY);
  sessionStorage.removeItem(OIDC_VERIFIER_KEY);

  if (!storedState?.state || storedState.state !== returnedState || !verifier) {
    const existingSession = readAuthSession();
    cleanRedirectUrl();
    if (getSessionAccessToken(existingSession)) {
      notifyRouteChanged();
      return existingSession;
    }
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
      cache: "no-store",
      credentials: "include"
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
    refreshAvailable: Boolean(tokenSet.refresh_available || tokenSet.refresh_token),
    expiresAt: Date.now() + expiresIn * 1000,
    createdAt: Date.now()
  };

  saveAuthSession(session);
  cleanRedirectUrl(storedState.returnTo);
  notifyRouteChanged();
  return session;
}

export async function completeOidcRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) return null;

  const completionKey = `${returnedState}:${code}`;
  if (currentRedirectCompletion?.key === completionKey) {
    return currentRedirectCompletion.promise;
  }

  const promise = Promise.resolve().then(() => completeOidcRedirectOnce(code, returnedState));
  currentRedirectCompletion = { key: completionKey, promise };
  return promise;
}
