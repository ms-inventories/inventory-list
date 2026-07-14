import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";
import { config } from "./config.js";
import { withTransaction } from "./db.js";
import {
  kickProvisioningWorker,
  satisfyEnrollmentFromVerifiedLogin
} from "./provisioning.js";

let jwksPromise = null;
let discoveryPromise = null;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const rejectedBearerTokenErrorCodes = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID"
]);

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
  // Reject structurally invalid bearer tokens before contacting the identity
  // provider. Signature and claim validation still happen below via jwtVerify.
  try {
    decodeProtectedHeader(token);
    decodeJwt(token);
  } catch {
    throw new errors.JWTInvalid("Malformed bearer token");
  }

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
  const providerUserUuid = normalizeProviderUserUuid(
    config.oidc.subjectIsUserUuid
      ? subject
      : getIdentityText(payloads, [config.oidc.immutableUserIdClaim])
  );
  const isPlatformAdmin = includesAnyGroup(groups, [config.oidc.platformAdminGroup, "876en-admins"])
    || config.platformAdminEmails.includes(email)
    || config.platformAdminSubjects.includes(normalizedSubject);
  const isFrgAdmin = isPlatformAdmin
    || includesAnyGroup(groups, [config.oidc.frgAdminGroup, "876en-frg-admins"]);

  return {
    subject,
    providerUserUuid,
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
  const providerUserUuid = normalizeProviderUserUuid(
    config.oidc.subjectIsUserUuid
      ? subject
      : getHeaderValue(request, "x-dev-user-uuid")
  );
  const isPlatformAdmin = includesAnyGroup(groups, [config.oidc.platformAdminGroup, "876en-admins"])
    || config.platformAdminEmails.includes(normalizedEmail)
    || config.platformAdminSubjects.includes(normalizedSubject);
  const isFrgAdmin = isPlatformAdmin
    || includesAnyGroup(groups, [config.oidc.frgAdminGroup, "876en-frg-admins"]);

  return {
    subject: String(subject),
    providerUserUuid,
    email: normalizedEmail,
    displayName: String(getHeaderValue(request, "x-dev-name") || email),
    groups,
    isPlatformAdmin,
    isFrgAdmin,
    claims: { dev: true }
  };
}

export async function authenticate(request, verifyToken = verifyBearerToken) {
  const devIdentity = getDevIdentity(request);
  if (devIdentity) return devIdentity;

  const authHeader = getHeaderValue(request, "authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  try {
    return await verifyToken(match[1], getHeaderValue(request, "x-id-token") || "");
  } catch (error) {
    if (rejectedBearerTokenErrorCodes.has(error?.code)) return null;
    throw error;
  }
}

function identityError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = statusCode === 409 ? "identity_conflict" : "identity_incomplete";
  return error;
}

function normalizeProviderUserUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : "";
}

function normalizeIdentityEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function findIdentityUsers(client, subject, email, providerUserUuid) {
  const result = await client.query(
    `
      SELECT id, authentik_subject, email, display_name,
        authentik_user_pk, authentik_user_uuid, authentik_oidc_user_uuid,
        authentik_enrollment_sent_at, authentik_enrollment_job_id
      FROM app_users
      WHERE authentik_subject = $1
        OR lower(email) = $2
        OR (
          $3::uuid IS NOT NULL
          AND (
            authentik_user_uuid = $3::uuid
            OR authentik_oidc_user_uuid = $3::uuid
          )
        )
      ORDER BY id
      FOR UPDATE
    `,
    [subject, email, providerUserUuid || null]
  );
  return result.rows;
}

async function updateIdentityUser(client, userId, {
  subject,
  email,
  displayName,
  providerUserUuid,
  requireUnlinked = false
}) {
  const result = await client.query(
    `
      UPDATE app_users
      SET authentik_subject = $2,
        email = $3,
        display_name = COALESCE($4, display_name),
        authentik_oidc_user_uuid = COALESCE(authentik_oidc_user_uuid, $5::uuid),
        last_seen_at = now()
      WHERE id = $1
        ${requireUnlinked ? "AND authentik_subject IS NULL" : ""}
      RETURNING id, authentik_subject, email, display_name, authentik_user_pk,
        authentik_user_uuid, authentik_oidc_user_uuid,
        authentik_enrollment_sent_at, authentik_enrollment_job_id
    `,
    [userId, subject, email, displayName, providerUserUuid || null]
  );
  return result.rows[0] || null;
}

function assertImmutableIdentity(row, identity) {
  const managementUuid = normalizeProviderUserUuid(row?.authentik_user_uuid);
  const oidcUuid = normalizeProviderUserUuid(row?.authentik_oidc_user_uuid);
  if (!managementUuid && !oidcUuid) return;
  if (!identity.providerUserUuid) {
    throw identityError("Authenticated identity has no immutable user identifier", 422);
  }
  if (
    (managementUuid && managementUuid !== identity.providerUserUuid)
    || (oidcUuid && oidcUuid !== identity.providerUserUuid)
  ) {
    throw identityError("Authenticated identity does not match the provisioned account", 409);
  }
}

async function reconcileIdentityUsers(client, rows, identity) {
  const subjectUser = rows.find(row => row.authentik_subject === identity.subject) || null;
  const immutableUsers = identity.providerUserUuid
    ? rows.filter(row => [row.authentik_user_uuid, row.authentik_oidc_user_uuid]
      .some(value => normalizeProviderUserUuid(value) === identity.providerUserUuid))
    : [];
  if (immutableUsers.length > 1) {
    throw identityError("Authenticated identity matches more than one local account", 409);
  }
  const immutableUser = immutableUsers[0] || null;
  const emailUsers = rows.filter(row => normalizeIdentityEmail(row.email) === identity.email);
  if (emailUsers.length > 1) {
    throw identityError("Authenticated email matches more than one local account", 409);
  }
  const emailUser = emailUsers[0] || null;

  if (subjectUser) {
    assertImmutableIdentity(subjectUser, identity);
    if (immutableUser && immutableUser.id !== subjectUser.id) {
      throw identityError("Authenticated identity conflicts with an existing account", 409);
    }
    if (emailUser && emailUser.id !== subjectUser.id) {
      throw identityError("Authenticated identity conflicts with an existing email account", 409);
    }
    return updateIdentityUser(client, subjectUser.id, identity);
  }

  if (immutableUser) {
    assertImmutableIdentity(immutableUser, identity);
    if (immutableUser.authentik_subject && immutableUser.authentik_subject !== identity.subject) {
      throw identityError("Authenticated identity is already linked to a different subject", 409);
    }
    if (emailUser && emailUser.id !== immutableUser.id) {
      throw identityError("Authenticated identity conflicts with an existing email account", 409);
    }
    const linked = await updateIdentityUser(client, immutableUser.id, {
      ...identity,
      requireUnlinked: !immutableUser.authentik_subject
    });
    if (!linked) throw identityError("Authenticated identity is already linked to a different subject", 409);
    return linked;
  }

  if (emailUser) {
    assertImmutableIdentity(emailUser, identity);
    if (emailUser.authentik_subject && emailUser.authentik_subject !== identity.subject) {
      throw identityError("Authenticated email is already linked to a different identity", 409);
    }

    // A subject-less user is an explicit local invitation placeholder. Link it
    // only after confirming that no different non-null subject owns the email.
    const linked = await updateIdentityUser(client, emailUser.id, { ...identity, requireUnlinked: true });
    if (!linked) throw identityError("Authenticated email is already linked to a different identity", 409);
    return linked;
  }

  return null;
}

async function ensureUserWithClient(identity, client) {
  const normalized = {
    subject: String(identity?.subject || "").trim(),
    email: normalizeIdentityEmail(identity?.email),
    displayName: String(identity?.displayName || "").trim() || null,
    providerUserUuid: normalizeProviderUserUuid(identity?.providerUserUuid)
  };

  if (!normalized.subject) throw identityError("Authenticated user has no subject claim", 422);
  if (!normalized.email) throw identityError("Authenticated user has no email claim", 422);

  const existing = await reconcileIdentityUsers(
    client,
    await findIdentityUsers(
      client,
      normalized.subject,
      normalized.email,
      normalized.providerUserUuid
    ),
    normalized
  );
  if (existing) return existing;

  const inserted = await client.query(
    `
      INSERT INTO app_users (
        authentik_subject, email, display_name, authentik_oidc_user_uuid, last_seen_at
      )
      VALUES ($1, $2, $3, $4::uuid, now())
      ON CONFLICT DO NOTHING
      RETURNING id, authentik_subject, email, display_name, authentik_user_pk,
        authentik_user_uuid, authentik_oidc_user_uuid,
        authentik_enrollment_sent_at, authentik_enrollment_job_id
    `,
    [normalized.subject, normalized.email, normalized.displayName, normalized.providerUserUuid || null]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  // A concurrent login may have inserted the subject or email between the
  // initial lookup and insert. Re-read it under lock and apply the same checks.
  const raced = await reconcileIdentityUsers(
    client,
    await findIdentityUsers(
      client,
      normalized.subject,
      normalized.email,
      normalized.providerUserUuid
    ),
    normalized
  );
  if (raced) return raced;

  throw identityError("Unable to establish authenticated user identity", 409);
}

export async function ensureUser(identity, client = null) {
  if (client) return ensureUserWithClient(identity, client);
  return withTransaction(transactionClient => ensureUserWithClient(identity, transactionClient));
}

export async function authContext(request, reply) {
  const identity = await authenticate(request);
  if (!identity) {
    reply.code(401);
    throw new Error("Authentication required");
  }

  request.authenticatedSubject = identity.subject || "";
  const user = await ensureUser(identity);
  const hasManagementIdentity = Number.isSafeInteger(Number(user.authentik_user_pk))
    && Number(user.authentik_user_pk) > 0
    && UUID_PATTERN.test(String(user.authentik_user_uuid || ""));
  if (hasManagementIdentity && (!user.authentik_enrollment_sent_at || user.authentik_enrollment_job_id)) {
    const enrollment = await satisfyEnrollmentFromVerifiedLogin(user.id);
    if (enrollment.workRequested) kickProvisioningWorker();
  }
  return { identity, user };
}
