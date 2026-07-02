import { appConfig } from "../config.js";

const AUTH_SESSION_KEY = "inventory.auth.session";
const OIDC_STATE_KEY = "inventory.oidc.state";
const OIDC_VERIFIER_KEY = "inventory.oidc.verifier";

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
  const response = await fetch(appConfig.oidc.discoveryUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  const discovery = await response.json();
  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new Error("OIDC discovery is missing endpoints");
  }
  return discovery;
}

function getRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function cleanRedirectUrl(returnTo) {
  window.history.replaceState({}, "", returnTo || `${window.location.pathname}${window.location.hash || ""}`);
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
    throw new Error("Login state did not match");
  }

  const discovery = await getOidcDiscovery();
  const body = new URLSearchParams({
    client_id: appConfig.oidc.clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri()
  });

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const tokenSet = await response.json();
  if (!response.ok) {
    cleanRedirectUrl(storedState.returnTo);
    throw new Error(tokenSet?.error_description || tokenSet?.error || "Token exchange failed");
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
