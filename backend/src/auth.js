import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import { query } from "./db.js";

let jwksPromise = null;
let discoveryPromise = null;

function getHeaderValue(request, name) {
  return request.headers[name.toLowerCase()];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeGroupName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "[object object]") return [];

  const normalized = new Set([raw]);
  const pathName = raw.split("/").filter(Boolean).pop();
  if (pathName) normalized.add(pathName);

  return [...normalized];
}

function normalizeGroupList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap(part => normalizeGroupList(part)));
  }

  if (typeof value === "string") {
    return uniqueStrings(value
      .split(/[,\s]+/)
      .flatMap(part => normalizeGroupName(part)));
  }

  if (value && typeof value === "object") {
    return uniqueStrings([
      value.name,
      value.group,
      value.path,
      value.slug,
      value.id
    ].flatMap(part => normalizeGroupList(part)));
  }

  return [];
}

function includesGroup(groups, groupName) {
  return groups.includes(String(groupName || "").toLowerCase());
}

function includesAnyGroup(groups, groupNames) {
  return groupNames.some(groupName => includesGroup(groups, groupName));
}

function getPayloadGroups(payload) {
  const claimNames = uniqueStrings([
    config.oidc.groupsClaim,
    "groups",
    "group",
    "roles",
    "role",
    "ak_groups",
    "authentik_groups"
  ]);

  return uniqueStrings(claimNames.flatMap(name => normalizeGroupList(payload?.[name])));
}

function getDiscoveryUrl() {
  if (config.oidc.discoveryUrl) return config.oidc.discoveryUrl;
  const issuer = config.oidc.issuer.replace(/\/+$/, "");
  return `${issuer}/.well-known/openid-configuration`;
}

async function getDiscovery() {
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const response = await fetch(getDiscoveryUrl());
      if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
      const discovery = await response.json();
      if (!discovery.jwks_uri) throw new Error("OIDC discovery did not include jwks_uri");
      return discovery;
    })();
  }

  return discoveryPromise;
}

async function getJwks() {
  if (!jwksPromise) {
    jwksPromise = (async () => {
      const discovery = await getDiscovery();
      return createRemoteJWKSet(new URL(discovery.jwks_uri));
    })();
  }

  return jwksPromise;
}

async function verifyJwt(token) {
  const jwks = await getJwks();
  const verifyOptions = {};
  if (config.oidc.issuer) verifyOptions.issuer = config.oidc.issuer;
  if (config.oidc.audience) verifyOptions.audience = config.oidc.audience;

  const { payload } = await jwtVerify(token, jwks, verifyOptions);
  return payload;
}

async function getUserinfo(token) {
  const discovery = await getDiscovery();
  if (!discovery.userinfo_endpoint) return null;

  const response = await fetch(discovery.userinfo_endpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) return null;
  return response.json();
}

function getIdentityText(payloads, keys) {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload?.[key];
      if (value) return String(value);
    }
  }
  return "";
}

async function getSupplementalIdPayload(accessPayload, idToken) {
  if (!idToken) return null;

  try {
    const idPayload = await verifyJwt(idToken);
    return idPayload.sub && idPayload.sub === accessPayload.sub ? idPayload : null;
  } catch {
    return null;
  }
}

export async function exchangeOidcCode({ code, codeVerifier, redirectUri }) {
  const discovery = await getDiscovery();
  if (!discovery.token_endpoint) throw new Error("OIDC discovery did not include token_endpoint");
  if (!config.oidc.clientId) throw new Error("OIDC_CLIENT_ID is required for token exchange");

  const body = new URLSearchParams({
    client_id: config.oidc.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let tokenSet = null;
  try {
    tokenSet = text ? JSON.parse(text) : {};
  } catch {
    tokenSet = { error: text || "Token exchange failed" };
  }

  if (!response.ok) {
    const error = new Error(tokenSet?.error_description || tokenSet?.error || "Token exchange failed");
    error.statusCode = 400;
    throw error;
  }

  return tokenSet;
}

async function verifyBearerToken(token, idToken = "") {
  const accessPayload = await verifyJwt(token);
  const subject = String(accessPayload.sub || "");
  const normalizedSubject = subject.toLowerCase();
  const idPayload = await getSupplementalIdPayload(accessPayload, idToken);
  let userinfoPayload = null;

  let groups = getPayloadGroups(accessPayload);
  if (!groups.length || !accessPayload.email) {
    userinfoPayload = await getUserinfo(token);
  }

  const payloads = [accessPayload, idPayload, userinfoPayload].filter(Boolean);
  groups = uniqueStrings(payloads.flatMap(payload => getPayloadGroups(payload)));

  const email = getIdentityText(payloads, ["email", "preferred_username"]).toLowerCase();
  const isPlatformAdmin = includesAnyGroup(groups, [config.oidc.platformAdminGroup, "876en-admins"])
    || config.platformAdminEmails.includes(email)
    || config.platformAdminSubjects.includes(normalizedSubject);
  const isFrgAdmin = isPlatformAdmin
    || includesAnyGroup(groups, [config.oidc.frgAdminGroup, "876en-frg-admins"]);

  return {
    subject,
    email,
    displayName: getIdentityText(payloads, ["name", "preferred_username", "email"]),
    groups,
    isPlatformAdmin,
    isFrgAdmin,
    claims: accessPayload
  };
}

function getDevIdentity(request) {
  if (!config.allowDevAuth) return null;

  const subject = getHeaderValue(request, "x-dev-sub");
  const email = getHeaderValue(request, "x-dev-email");
  if (!subject || !email) return null;

  const groups = normalizeGroupList(getHeaderValue(request, "x-dev-groups"));
  const normalizedSubject = String(subject).toLowerCase();
  const normalizedEmail = String(email).toLowerCase();
  const isPlatformAdmin = includesAnyGroup(groups, [config.oidc.platformAdminGroup, "876en-admins"])
    || config.platformAdminEmails.includes(normalizedEmail)
    || config.platformAdminSubjects.includes(normalizedSubject);
  const isFrgAdmin = isPlatformAdmin
    || includesAnyGroup(groups, [config.oidc.frgAdminGroup, "876en-frg-admins"]);

  return {
    subject: String(subject),
    email: normalizedEmail,
    displayName: String(getHeaderValue(request, "x-dev-name") || email),
    groups,
    isPlatformAdmin,
    isFrgAdmin,
    claims: { dev: true }
  };
}

export async function authenticate(request) {
  const devIdentity = getDevIdentity(request);
  if (devIdentity) return devIdentity;

  const authHeader = getHeaderValue(request, "authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return verifyBearerToken(match[1], getHeaderValue(request, "x-id-token") || "");
}

export async function ensureUser(identity) {
  if (!identity?.email) throw new Error("Authenticated user has no email claim");

  const result = await query(
    `
      INSERT INTO app_users (authentik_subject, email, display_name, last_seen_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (email) DO UPDATE SET
        authentik_subject = COALESCE(app_users.authentik_subject, EXCLUDED.authentik_subject),
        display_name = COALESCE(EXCLUDED.display_name, app_users.display_name),
        last_seen_at = now()
      RETURNING id, authentik_subject, email, display_name
    `,
    [identity.subject, identity.email, identity.displayName]
  );

  return result.rows[0];
}

export async function authContext(request, reply) {
  const identity = await authenticate(request);
  if (!identity) {
    reply.code(401);
    throw new Error("Authentication required");
  }

  const user = await ensureUser(identity);
  return { identity, user };
}
