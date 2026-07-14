import { appConfig } from "../config.js";
import { getSessionAccessToken, invalidateAuthSession, readAuthSession } from "./auth.js";

const QA_IDENTITY_KEY = "inventory.qa.identity";
const LAST_API_REQUEST_ID_KEY = "inventory.lastApiRequestId";
export const CREW_ACCESS_ENDED_EVENT = "inventory:crew-access-ended";

export class ApiError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details && typeof details === "object" ? details : { raw: details };
    this.code = this.details.code || "";
    this.requestId = this.details.requestId || "";
  }
}

const API_NETWORK_MESSAGE = "Could not reach the inventory API. Try again, or ask an admin to check API routing if this keeps happening.";
const API_NON_JSON_MESSAGE = "The inventory API returned an unexpected response. Ask an admin to check API routing.";

export function readQaIdentity() {
  if (!appConfig.enableQaAuth) return null;
  try {
    const raw = localStorage.getItem(QA_IDENTITY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveQaIdentity(identity) {
  if (!appConfig.enableQaAuth) return;
  localStorage.setItem(QA_IDENTITY_KEY, JSON.stringify(identity));
}

export function clearQaIdentity() {
  localStorage.removeItem(QA_IDENTITY_KEY);
}

export function readLastApiRequestId() {
  try {
    return sessionStorage.getItem(LAST_API_REQUEST_ID_KEY) || "";
  } catch {
    return "";
  }
}

function rememberApiRequestId(requestId) {
  if (!requestId) return;
  try {
    sessionStorage.setItem(LAST_API_REQUEST_ID_KEY, requestId);
  } catch {
    // Diagnostics storage is best-effort only.
  }
}

function buildApiUrl(path) {
  const base = String(appConfig.apiBaseUrl || "/api").replace(/\/+$/, "");
  const cleanPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

function getResponsePreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

export async function apiRequest(path, { method = "GET", token = "", tenantSlug = "", body } = {}) {
  const headers = {
    Accept: "application/json"
  };

  const session = token ? readAuthSession() : null;
  if (session?.accessToken === token && !getSessionAccessToken(session)) {
    invalidateAuthSession(token, "expired");
    throw new ApiError("Your sign-in expired. Try again.", 401, { code: "auth_session_expired" });
  }

  if (token) headers.Authorization = `Bearer ${token}`;
  if (session?.accessToken === token && session.idToken) headers["X-ID-Token"] = session.idToken;
  if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const qaIdentity = readQaIdentity();
  if (qaIdentity) {
    headers["X-Dev-Sub"] = qaIdentity.sub;
    headers["X-Dev-Email"] = qaIdentity.email;
    headers["X-Dev-Name"] = qaIdentity.name || qaIdentity.email;
    headers["X-Dev-Groups"] = (qaIdentity.groups || []).join(",");
  }

  const url = buildApiUrl(path);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "include"
    });
  } catch (error) {
    throw new ApiError(API_NETWORK_MESSAGE, 0, {
      code: "api_network",
      url,
      cause: error?.message || String(error)
    });
  }

  const text = await response.text();
  const responseRequestId = response.headers.get("X-Request-ID") || "";
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        API_NON_JSON_MESSAGE,
        response.status,
        { code: "api_non_json", raw: getResponsePreview(text), url }
      );
    }
  }

  if (!response.ok) {
    const details = data && typeof data === "object" ? { ...data } : { url };
    if (!details.requestId && responseRequestId) details.requestId = responseRequestId;
    rememberApiRequestId(details.requestId);
    if (response.status === 401 && token) invalidateAuthSession(token, "unauthorized");
    if (response.status === 401 && details.code === "crew_access_ended" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CREW_ACCESS_ENDED_EVENT));
    }
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, details);
  }

  return data || {};
}

export function getApiErrorMessage(error) {
  if (error instanceof ApiError) {
    const message = error.message || "Request failed";
    return error.requestId && !message.includes(error.requestId)
      ? `${message.replace(/[.\s]+$/, "")}. Reference ID: ${error.requestId}.`
      : message;
  }
  const message = typeof error === "string" ? error : error?.message || error?.text || "";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return API_NETWORK_MESSAGE;
  return message || "Request failed";
}
