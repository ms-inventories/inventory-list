import { appConfig } from "../config.js";

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function buildApiUrl(path) {
  const base = String(appConfig.apiBaseUrl || "/api").replace(/\/+$/, "");
  const cleanPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

export async function apiRequest(path, { method = "GET", token = "", tenantSlug = "", body } = {}) {
  const headers = {
    Accept: "application/json"
  };

  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
  if (body !== undefined) headers["Content-Type"] = "application/json";

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
      data = { raw: text };
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
