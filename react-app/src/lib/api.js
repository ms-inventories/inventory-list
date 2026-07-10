import { appConfig } from "../config.js";
import { readAuthSession } from "./auth.js";

const QA_IDENTITY_KEY = "inventory.qa.identity";

export class ApiError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details && typeof details === "object" ? details : { raw: details };
    this.code = this.details.code || "";
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

  if (token) headers.Authorization = `Bearer ${token}`;
  const session = token ? readAuthSession() : null;
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
      cache: "no-store"
    });
  } catch (error) {
    throw new ApiError(API_NETWORK_MESSAGE, 0, {
      code: "api_network",
      url,
      cause: error?.message || String(error)
    });
  }

  const text = await response.text();
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
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, data || { url });
  }

  return data || {};
}

export function getApiErrorMessage(error) {
  if (error instanceof ApiError) return error.message;
  const message = typeof error === "string" ? error : error?.message || error?.text || "";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return API_NETWORK_MESSAGE;
  return message || "Request failed";
}
