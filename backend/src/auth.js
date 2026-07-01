import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import { query } from "./db.js";

let jwksPromise = null;

function getHeaderValue(request, name) {
  return request.headers[name.toLowerCase()];
}

function normalizeGroupList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map(part => part.trim())
      .filter(Boolean);
  }
  return [];
}

function getDiscoveryUrl() {
  if (config.oidc.discoveryUrl) return config.oidc.discoveryUrl;
  const issuer = config.oidc.issuer.replace(/\/+$/, "");
  return `${issuer}/.well-known/openid-configuration`;
}

async function getJwks() {
  if (!jwksPromise) {
    jwksPromise = (async () => {
      const response = await fetch(getDiscoveryUrl());
      if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
      const discovery = await response.json();
      if (!discovery.jwks_uri) throw new Error("OIDC discovery did not include jwks_uri");
      return createRemoteJWKSet(new URL(discovery.jwks_uri));
    })();
  }

  return jwksPromise;
}

async function verifyBearerToken(token) {
  const jwks = await getJwks();
  const verifyOptions = {};
  if (config.oidc.issuer) verifyOptions.issuer = config.oidc.issuer;
  if (config.oidc.audience) verifyOptions.audience = config.oidc.audience;

  const { payload } = await jwtVerify(token, jwks, verifyOptions);
  const groups = normalizeGroupList(payload[config.oidc.groupsClaim]);

  return {
    subject: String(payload.sub || ""),
    email: String(payload.email || "").toLowerCase(),
    displayName: String(payload.name || payload.preferred_username || payload.email || ""),
    groups,
    isPlatformAdmin: groups.includes(config.oidc.platformAdminGroup),
    claims: payload
  };
}

function getDevIdentity(request) {
  if (!config.allowDevAuth) return null;

  const subject = getHeaderValue(request, "x-dev-sub");
  const email = getHeaderValue(request, "x-dev-email");
  if (!subject || !email) return null;

  const groups = normalizeGroupList(getHeaderValue(request, "x-dev-groups"));

  return {
    subject: String(subject),
    email: String(email).toLowerCase(),
    displayName: String(getHeaderValue(request, "x-dev-name") || email),
    groups,
    isPlatformAdmin: groups.includes(config.oidc.platformAdminGroup),
    claims: { dev: true }
  };
}

export async function authenticate(request) {
  const devIdentity = getDevIdentity(request);
  if (devIdentity) return devIdentity;

  const authHeader = getHeaderValue(request, "authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return verifyBearerToken(match[1]);
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
