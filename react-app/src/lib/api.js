import { appConfig } from "../config.js";
import { readAuthSession } from "./auth.js";

const QA_IDENTITY_KEY = "inventory.qa.identity";

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

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

  const response = await fetch(buildApiUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        "API returned a non-JSON response. Check VITE_API_BASE_URL and Cloudflare/Coolify routing.",
        response.status,
        { raw: getResponsePreview(text), url: buildApiUrl(path) }
      );
    }
  }

  if (!response.ok) {
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status, data);
  }

  return data || {};
}

export function getApiErrorMessage(error) {
  if (error instanceof ApiError) return error.message;
  return error?.message || "Request failed";
}
