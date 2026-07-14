const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const API_PREFIX = "/api/v3";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuthentikClientError extends Error {
  constructor(message, code, { statusCode = null } = {}) {
    super(message);
    this.name = "AuthentikClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function configurationError() {
  return new AuthentikClientError(
    "Authentik is not configured safely.",
    "authentik_config_invalid"
  );
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) throw configurationError();

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw configurationError();
  }

  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.origin === "null"
  ) {
    throw configurationError();
  }

  return parsed.origin;
}

function normalizeToken(value) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /\s/.test(value)
  ) {
    throw configurationError();
  }
  return value;
}

function boundedInteger(value, fallback, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw configurationError();
  }
  return resolved;
}

function requiredText(value, maximum = 254) {
  if (typeof value !== "string") throw configurationError();
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw configurationError();
  return normalized;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw configurationError();
  return value;
}

function booleanValue(value) {
  if (typeof value !== "boolean") throw configurationError();
  return value;
}

function uuid(value) {
  const normalized = requiredText(value, 64);
  if (!UUID_PATTERN.test(normalized)) throw configurationError();
  return normalized;
}

function responseTooLarge() {
  return new AuthentikClientError(
    "Authentik returned an oversized response.",
    "authentik_response_too_large"
  );
}

function invalidResponse() {
  return new AuthentikClientError(
    "Authentik returned an invalid response.",
    "authentik_invalid_response"
  );
}

async function readBoundedText(response, limit) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw responseTooLarge();
  }

  if (!response.body) return "";
  if (typeof response.body.getReader !== "function") throw invalidResponse();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidResponse();
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse();
  }
}

async function readJson(response, limit) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw invalidResponse();
  }

  const text = await readBoundedText(response, limit);
  if (!text) throw invalidResponse();
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

function listResults(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw invalidResponse();
  }
  return payload.results;
}

function objectResult(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidResponse();
  }
  return payload;
}

function ambiguous(kind) {
  return new AuthentikClientError(
    `Authentik returned more than one exact ${kind} match.`,
    `authentik_${kind}_ambiguous`
  );
}

function exactMatch(results, predicate, kind) {
  const matches = results.filter(predicate);
  if (matches.length > 1) throw ambiguous(kind);
  return matches[0] || null;
}

function safeAttributes(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw configurationError();
  return value;
}

function optionalUuidList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw configurationError();
  return value.map(uuid);
}

function compactObject(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export function createAuthentikClient({
  origin,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxResponseBytes
} = {}) {
  const canonicalOrigin = normalizeOrigin(origin);
  const bearerToken = normalizeToken(token);
  const requestTimeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const responseLimit = boundedInteger(
    maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES
  );

  if (typeof fetchImpl !== "function") throw configurationError();

  async function request(path, {
    method = "GET",
    query,
    body,
    expectedStatus,
    responseType = "json"
  } = {}) {
    const url = new URL(`${API_PREFIX}${path}`, canonicalOrigin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: compactObject([
          ["Accept", "application/json"],
          ["Authorization", `Bearer ${bearerToken}`],
          ["Content-Type", body === undefined ? undefined : "application/json"]
        ]),
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (!response || !Number.isInteger(response.status)) throw invalidResponse();

      const allowedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
      if (!allowedStatuses.includes(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        throw new AuthentikClientError(
          "Authentik rejected the request.",
          "authentik_request_failed",
          { statusCode: response.status }
        );
      }

      if (responseType === "empty") {
        await response.body?.cancel?.().catch(() => {});
        return null;
      }
      return await readJson(response, responseLimit);
    } catch (error) {
      if (error instanceof AuthentikClientError) throw error;
      if (controller.signal.aborted) {
        throw new AuthentikClientError(
          "Authentik request timed out.",
          "authentik_timeout"
        );
      }
      throw new AuthentikClientError(
        "Authentik request could not be completed.",
        "authentik_unavailable"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function findUserByEmail(email) {
    const normalizedEmail = requiredText(email).toLowerCase();
    const payload = await request("/core/users/", {
      query: { email: normalizedEmail, page_size: 2 },
      expectedStatus: 200
    });
    return exactMatch(
      listResults(payload),
      user => String(user?.email || "").trim().toLowerCase() === normalizedEmail,
      "user"
    );
  }

  async function findGroupByName(name) {
    const exactName = requiredText(name, 255);
    const payload = await request("/core/groups/", {
      query: { name: exactName, page_size: 2, include_users: false },
      expectedStatus: 200
    });
    return exactMatch(
      listResults(payload),
      group => group?.name === exactName,
      "group"
    );
  }

  async function createUser({
    email,
    name,
    username,
    path,
    attributes,
    groups,
    isActive = true
  }) {
    const normalizedEmail = requiredText(email).toLowerCase();
    const normalizedUsername = requiredText(username || normalizedEmail, 150);
    const payload = compactObject([
      ["username", normalizedUsername],
      ["name", requiredText(name, 255)],
      ["email", normalizedEmail],
      ["is_active", booleanValue(isActive)],
      ["type", "internal"],
      ["path", path === undefined ? undefined : requiredText(path, 255)],
      ["attributes", safeAttributes(attributes)],
      ["groups", optionalUuidList(groups)]
    ]);
    return objectResult(await request("/core/users/", {
      method: "POST",
      body: payload,
      expectedStatus: 201
    }));
  }

  async function createOrLinkUser(options) {
    const normalizedEmail = requiredText(options?.email).toLowerCase();
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) return { user: existing, created: false };

    try {
      const user = await createUser({ ...options, email: normalizedEmail });
      return { user, created: true };
    } catch (error) {
      if (
        error instanceof AuthentikClientError
        && [400, 409].includes(error.statusCode)
      ) {
        const racedUser = await findUserByEmail(normalizedEmail);
        if (racedUser) return { user: racedUser, created: false };
      }
      throw error;
    }
  }

  async function createGroup({ name, attributes, isSuperuser = false }) {
    const payload = compactObject([
      ["name", requiredText(name, 255)],
      ["is_superuser", booleanValue(isSuperuser)],
      ["attributes", safeAttributes(attributes)]
    ]);
    return objectResult(await request("/core/groups/", {
      method: "POST",
      body: payload,
      expectedStatus: 201
    }));
  }

  async function ensureGroup(options) {
    const exactName = requiredText(options?.name, 255);
    const existing = await findGroupByName(exactName);
    if (existing) return { group: existing, created: false };

    try {
      const group = await createGroup({ ...options, name: exactName });
      return { group, created: true };
    } catch (error) {
      if (
        error instanceof AuthentikClientError
        && [400, 409].includes(error.statusCode)
      ) {
        const racedGroup = await findGroupByName(exactName);
        if (racedGroup) return { group: racedGroup, created: false };
      }
      throw error;
    }
  }

  async function changeGroupMembership(action, groupId, userId) {
    await request(`/core/groups/${encodeURIComponent(uuid(groupId))}/${action}/`, {
      method: "POST",
      body: { pk: positiveInteger(userId) },
      expectedStatus: 204,
      responseType: "empty"
    });
  }

  async function addUserToGroup(groupId, userId) {
    await changeGroupMembership("add_user", groupId, userId);
    return { changed: true };
  }

  async function removeUserFromGroup(groupId, userId) {
    await changeGroupMembership("remove_user", groupId, userId);
    return { changed: true };
  }

  async function ensureUserInGroup(user, group) {
    const groupId = uuid(group?.pk);
    const userId = positiveInteger(user?.pk);
    if (
      Array.isArray(user?.groups)
      && user.groups.some(value => String(value).toLowerCase() === groupId.toLowerCase())
    ) {
      return { changed: false };
    }
    return addUserToGroup(groupId, userId);
  }

  async function ensureUserNotInGroup(user, group) {
    const groupId = uuid(group?.pk);
    const userId = positiveInteger(user?.pk);
    if (
      Array.isArray(user?.groups)
      && !user.groups.some(value => String(value).toLowerCase() === groupId.toLowerCase())
    ) {
      return { changed: false };
    }
    return removeUserFromGroup(groupId, userId);
  }

  async function sendRecoveryEmail({ userId, emailStage, tokenDuration }) {
    const body = compactObject([
      ["email_stage", uuid(emailStage)],
      ["token_duration", tokenDuration === undefined
        ? undefined
        : requiredText(tokenDuration, 255)]
    ]);
    await request(`/core/users/${positiveInteger(userId)}/recovery_email/`, {
      method: "POST",
      body,
      expectedStatus: 204,
      responseType: "empty"
    });
    return { sent: true };
  }

  return Object.freeze({
    origin: canonicalOrigin,
    findUserByEmail,
    findGroupByName,
    createUser,
    createOrLinkUser,
    ensureUser: createOrLinkUser,
    createGroup,
    ensureGroup,
    addUserToGroup,
    removeUserFromGroup,
    ensureUserInGroup,
    ensureUserNotInGroup,
    sendRecoveryEmail,
    sendEnrollmentEmail: sendRecoveryEmail
  });
}
