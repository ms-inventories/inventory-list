import crypto from "node:crypto";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { tenantSlugFromHost } from "./tenant.js";

export const crewCookieName = "inventory_crew_session";

function secretKey() {
  try {
    const key = Buffer.from(String(config.crewAccess.secret || ""), "base64url");
    return key.length >= 32 ? key : Buffer.from(String(config.crewAccess.secret || ""));
  } catch {
    return Buffer.from(String(config.crewAccess.secret || ""));
  }
}

function keyedDigest(label, value) {
  return crypto
    .createHmac("sha256", secretKey())
    .update(`${label}\0${String(value || "")}`)
    .digest("base64url");
}

function digestMatches(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function crewCodeDigest(tenantId, code) {
  return keyedDigest("crew-code-v1", `${tenantId}:${code}`);
}

export function crewInviteTokenDigest(tenantId, token) {
  return keyedDigest("crew-invite-token-v1", `${tenantId}:${token}`);
}

export function crewTokenDigest(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

export function generateCrewCode() {
  return crypto.randomInt(0, 10_000).toString().padStart(4, "0");
}

export function generateCrewInviteToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hasPrimaryAuthCredentials(request) {
  const authorization = String(request.headers.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) return true;
  return Boolean(config.allowDevAuth && request.headers["x-dev-sub"]);
}

export function readCookie(request, name) {
  const header = String(request.headers.cookie || "");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function appendSetCookie(response, value) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current
    ? [...(Array.isArray(current) ? current : [current]), value]
    : value);
}

export function crewCookieValue(token, expiresAt, { production = config.env === "production" } = {}) {
  const secondsRemaining = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const attributes = [
    `${crewCookieName}=${encodeURIComponent(token)}`,
    "Path=/api",
    `Max-Age=${secondsRemaining}`,
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (production) attributes.push("Secure");
  return attributes.join("; ");
}

export function issueCrewCookie(response, token, expiresAt) {
  appendSetCookie(response, crewCookieValue(token, expiresAt));
}

export function clearCrewCookie(response, { production = config.env === "production" } = {}) {
  const attributes = [
    `${crewCookieName}=`,
    "Path=/api",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (production) attributes.push("Secure");
  appendSetCookie(response, attributes.join("; "));
}

export function crewRequestError(message, statusCode, publicCode = "request_failed") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicCode = publicCode;
  return error;
}

function crewOriginMatchesTenant(origin, expectedTenantSlug) {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const baseDomain = config.baseDomain.toLowerCase();
    const allowedProtocol = url.protocol === "https:"
      || (["localhost", "127.0.0.1"].includes(baseDomain) && url.protocol === "http:");
    if (!allowedProtocol) return false;
    const tenantSlug = String(expectedTenantSlug || "").trim().toLowerCase();
    return Boolean(tenantSlug) && hostname === `${tenantSlug}.${baseDomain}`;
  } catch {
    return false;
  }
}

export function assertCrewRequestOrigin(request, expectedTenantSlug) {
  const origin = String(request.headers.origin || "").trim();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(String(request.method || "GET").toUpperCase());
  if (!origin && !mutating) return;
  if (!origin || !crewOriginMatchesTenant(origin, expectedTenantSlug)) {
    throw crewRequestError("Crew access is not valid for this site.", 403, "access_denied");
  }
}

function fingerprintForRequest(request) {
  const address = String(request.ip || request.socket?.remoteAddress || "unknown").slice(0, 160);
  const agent = String(request.headers["user-agent"] || "unknown").slice(0, 300);
  return keyedDigest("crew-login-fingerprint-v1", `${address}\n${agent}`);
}

function tenantRateFingerprint(tenantId) {
  return keyedDigest("crew-login-tenant-v1", tenantId);
}

async function cleanupStaleRateBuckets(client, tenantId, tenantBucketDigest) {
  await client.query(
    `
      DELETE FROM session_crew_login_attempts
      WHERE tenant_id = $1
        AND fingerprint_digest <> $2
        AND updated_at < now() - ($3::int * interval '1 minute')
    `,
    [tenantId, tenantBucketDigest, config.crewAccess.failureWindowMinutes * 2]
  );
}

async function lockRateBucket(client, tenantId, fingerprintDigest, limit) {
  await client.query(
    `
      INSERT INTO session_crew_login_attempts (tenant_id, fingerprint_digest)
      VALUES ($1, $2)
      ON CONFLICT (tenant_id, fingerprint_digest) DO NOTHING
    `,
    [tenantId, fingerprintDigest]
  );
  const result = await client.query(
    `
      SELECT *,
        GREATEST(0, ceil(extract(epoch FROM (locked_until - now()))))::int AS retry_after
      FROM session_crew_login_attempts
      WHERE tenant_id = $1 AND fingerprint_digest = $2
      FOR UPDATE
    `,
    [tenantId, fingerprintDigest]
  );
  let row = result.rows[0];
  const windowMilliseconds = config.crewAccess.failureWindowMinutes * 60 * 1000;
  if (new Date(row.window_started_at).getTime() <= Date.now() - windowMilliseconds) {
    const reset = await client.query(
      `
        UPDATE session_crew_login_attempts
        SET window_started_at = now(), failure_count = 0, locked_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND fingerprint_digest = $2
        RETURNING *, 0::int AS retry_after
      `,
      [tenantId, fingerprintDigest]
    );
    row = reset.rows[0];
  }
  return {
    fingerprintDigest,
    limit,
    locked: Boolean(row.locked_until && new Date(row.locked_until).getTime() > Date.now()),
    retryAfter: Math.max(1, Number(row.retry_after || config.crewAccess.failureWindowMinutes * 60))
  };
}

async function recordRateFailure(client, tenantId, bucket) {
  const result = await client.query(
    `
      UPDATE session_crew_login_attempts
      SET failure_count = failure_count + 1,
        locked_until = CASE
          WHEN failure_count + 1 >= $3
            THEN now() + ($4::int * interval '1 minute')
          ELSE locked_until
        END,
        updated_at = now()
      WHERE tenant_id = $1 AND fingerprint_digest = $2
      RETURNING failure_count,
        GREATEST(0, ceil(extract(epoch FROM (locked_until - now()))))::int AS retry_after
    `,
    [tenantId, bucket.fingerprintDigest, bucket.limit, config.crewAccess.failureWindowMinutes]
  );
  return {
    locked: Number(result.rows[0]?.failure_count || 0) >= bucket.limit,
    retryAfter: Math.max(1, Number(result.rows[0]?.retry_after || config.crewAccess.failureWindowMinutes * 60))
  };
}

export async function expireCrewAccess(client, tenantId = null) {
  const params = tenantId ? [tenantId] : [];
  const tenantFilter = tenantId ? "AND tenant_id = $1" : "";
  await client.query(
    `
      DELETE FROM session_crew_code_reservations
      WHERE expires_at <= now()
        ${tenantFilter}
    `,
    params
  );
  const expired = await client.query(
    `
      UPDATE session_crew_grants
      SET status = 'expired', revoke_reason = 'expired'
      WHERE status IN ('pending', 'consumed')
        AND expires_at <= now()
        ${tenantFilter}
      RETURNING id, tenant_id, session_id, consumed_by
    `,
    params
  );
  if (expired.rows.length) {
    await client.query(
      `
        UPDATE session_crew_auth_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE grant_id = ANY($1::uuid[])
      `,
      [expired.rows.map(row => row.id)]
    );
    for (const row of expired.rows) {
      if (!row.consumed_by) continue;
      await releaseCrewClaims(client, {
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        userId: row.consumed_by,
        reason: "expired"
      });
    }
  }
  return expired.rows.length;
}

export async function createCrewGrant(client, { tenantId, sessionId, displayName, createdBy }) {
  await expireCrewAccess(client, tenantId);
  const countResult = await client.query(
    `
      SELECT count(*)::int AS count
      FROM session_crew_grants
      WHERE session_id = $1
        AND status IN ('pending', 'consumed')
        AND expires_at > now()
    `,
    [sessionId]
  );
  if (Number(countResult.rows[0]?.count || 0) >= config.crewAccess.maxActiveGrantsPerSession) {
    throw crewRequestError("This session already has the maximum number of active crew passes.", 409, "crew_access_limit");
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = generateCrewCode();
    const codeDigest = crewCodeDigest(tenantId, code);
    const inviteToken = generateCrewInviteToken();
    const inviteTokenDigest = crewInviteTokenDigest(tenantId, inviteToken);
    const reservationResult = await client.query(
      `
        INSERT INTO session_crew_code_reservations (tenant_id, code_digest, expires_at)
        VALUES ($1, $2, now() + ($3::int * interval '1 hour'))
        ON CONFLICT (tenant_id, code_digest) DO NOTHING
        RETURNING expires_at
      `,
      [tenantId, codeDigest, config.crewAccess.grantTtlHours]
    );
    if (!reservationResult.rows[0]) continue;

    const result = await client.query(
      `
        INSERT INTO session_crew_grants
          (tenant_id, session_id, display_name, code_digest, invite_token_digest, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        tenantId,
        sessionId,
        displayName,
        codeDigest,
        inviteTokenDigest,
        createdBy,
        reservationResult.rows[0].expires_at
      ]
    );
    if (result.rows[0]) return { grant: result.rows[0], code, inviteToken };
    await client.query(
      "DELETE FROM session_crew_code_reservations WHERE tenant_id = $1 AND code_digest = $2",
      [tenantId, codeDigest]
    );
  }
  throw crewRequestError("A crew code could not be generated. Try again.", 503, "crew_code_unavailable");
}

export async function consumeCrewCode({ request, response, tenant, code, inviteToken }) {
  assertCrewRequestOrigin(request, tenant.slug);
  const normalizedCode = String(code || "").trim();
  const normalizedInviteToken = String(inviteToken || "").trim();
  const fingerprintDigest = fingerprintForRequest(request);
  const result = await withTransaction(async client => {
    await expireCrewAccess(client, tenant.id);
    const tenantBucketDigest = tenantRateFingerprint(tenant.id);
    await cleanupStaleRateBuckets(client, tenant.id, tenantBucketDigest);
    const tenantBucket = await lockRateBucket(
      client,
      tenant.id,
      tenantBucketDigest,
      config.crewAccess.maxTenantFailuresPerWindow
    );
    if (tenantBucket.locked) {
      return { rateLimited: true, retryAfter: tenantBucket.retryAfter };
    }
    const fingerprintBucket = await lockRateBucket(
      client,
      tenant.id,
      fingerprintDigest,
      config.crewAccess.maxFailuresPerWindow
    );
    if (fingerprintBucket.locked) {
      return { rateLimited: true, retryAfter: fingerprintBucket.retryAfter };
    }
    const buckets = [tenantBucket, fingerprintBucket];

    let grant = null;
    if (/^\d{4}$/.test(normalizedCode) && /^[A-Za-z0-9_-]{43}$/.test(normalizedInviteToken)) {
      const grantResult = await client.query(
        `
          SELECT crew_grant.*, inventory_session.name AS session_name,
            inventory_session.status AS session_status
          FROM session_crew_grants crew_grant
          JOIN inventory_sessions inventory_session ON inventory_session.id = crew_grant.session_id
          WHERE crew_grant.tenant_id = $1
            AND crew_grant.invite_token_digest = $2
            AND crew_grant.status = 'pending'
            AND crew_grant.expires_at > now()
            AND inventory_session.status = 'active'
          FOR UPDATE OF crew_grant, inventory_session
        `,
        [
          tenant.id,
          crewInviteTokenDigest(tenant.id, normalizedInviteToken)
        ]
      );
      const candidate = grantResult.rows[0] || null;
      if (candidate && digestMatches(candidate.code_digest, crewCodeDigest(tenant.id, normalizedCode))) {
        grant = candidate;
      } else if (candidate) {
        const failed = await client.query(
          `
            UPDATE session_crew_grants
            SET invite_failure_count = invite_failure_count + 1,
              status = CASE
                WHEN invite_failure_count + 1 >= $2 THEN 'revoked'
                ELSE status
              END,
              revoked_at = CASE
                WHEN invite_failure_count + 1 >= $2 THEN COALESCE(revoked_at, now())
                ELSE revoked_at
              END,
              revoke_reason = CASE
                WHEN invite_failure_count + 1 >= $2 THEN 'attempt_limit'
                ELSE revoke_reason
              END
            WHERE id = $1 AND status = 'pending'
            RETURNING invite_failure_count, status
          `,
          [candidate.id, config.crewAccess.maxFailuresPerGrant]
        );
        if (failed.rows[0]?.status === "revoked") {
          await client.query(
            `
              INSERT INTO audit_events (tenant_id, action, entity_type, entity_id, metadata)
              VALUES ($1, 'crew_access.attempt_limit', 'session_crew_grant', $2, $3::jsonb)
            `,
            [
              tenant.id,
              candidate.id,
              JSON.stringify({
                sessionId: candidate.session_id,
                failedAttemptCount: Number(failed.rows[0].invite_failure_count || 0)
              })
            ]
          );
        }
      }
    }

    if (!grant) {
      let lockResult = null;
      for (const bucket of buckets) {
        const recorded = await recordRateFailure(client, tenant.id, bucket);
        if (recorded.locked && (!lockResult || recorded.retryAfter > lockResult.retryAfter)) lockResult = recorded;
      }
      return lockResult
        ? { rateLimited: true, retryAfter: lockResult.retryAfter }
        : { invalid: true };
    }

    const userResult = await client.query(
      `
        INSERT INTO app_users (email, display_name, account_type, last_seen_at)
        VALUES (NULL, $1, 'session_crew', now())
        RETURNING id, email, display_name, account_type
      `,
      [grant.display_name]
    );
    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString("base64url");
    const authResult = await client.query(
      `
        INSERT INTO session_crew_auth_sessions
          (grant_id, tenant_id, session_id, user_id, token_digest, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [grant.id, tenant.id, grant.session_id, user.id, crewTokenDigest(token), grant.expires_at]
    );
    await client.query(
      `
        UPDATE session_crew_grants
        SET status = 'consumed', consumed_by = $2, consumed_at = now()
        WHERE id = $1 AND status = 'pending'
      `,
      [grant.id, user.id]
    );
    await client.query(
      `
        INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, 'crew_access.consumed', 'session_crew_grant', $3, $4::jsonb)
      `,
      [tenant.id, user.id, grant.id, JSON.stringify({ sessionId: grant.session_id, displayName: grant.display_name })]
    );
    await client.query(
      "DELETE FROM session_crew_login_attempts WHERE tenant_id = $1 AND fingerprint_digest = $2",
      [tenant.id, fingerprintDigest]
    );

    return { grant, user, authSession: authResult.rows[0], token };
  });

  if (result.rateLimited) {
    response.setHeader("Retry-After", String(result.retryAfter));
    throw crewRequestError("Too many code attempts. Wait before trying again.", 429, "crew_code_rate_limited");
  }
  if (result.invalid) {
    throw crewRequestError("That code is invalid or has expired.", 401, "invalid_crew_code");
  }

  issueCrewCookie(response, result.token, result.authSession.expires_at);
  return result;
}

export async function lockActiveCrewAccess(client, {
  authSessionId,
  tenantId,
  sessionId,
  userId,
  lockAuthSessionForUpdate = false
}) {
  if (!authSessionId || !tenantId || !sessionId || !userId) {
    throw crewRequestError("This crew access has ended.", 401, "crew_access_ended");
  }
  const lockClause = lockAuthSessionForUpdate
    ? "FOR UPDATE OF auth_session"
    : "FOR SHARE OF auth_session, crew_grant, inventory_session";
  const result = await client.query(
    `
      SELECT auth_session.id
      FROM session_crew_auth_sessions auth_session
      JOIN session_crew_grants crew_grant
        ON crew_grant.id = auth_session.grant_id
        AND crew_grant.tenant_id = auth_session.tenant_id
        AND crew_grant.session_id = auth_session.session_id
        AND crew_grant.consumed_by = auth_session.user_id
      JOIN inventory_sessions inventory_session
        ON inventory_session.id = auth_session.session_id
        AND inventory_session.tenant_id = auth_session.tenant_id
      WHERE auth_session.id = $1
        AND auth_session.tenant_id = $2
        AND auth_session.session_id = $3
        AND auth_session.user_id = $4
        AND auth_session.revoked_at IS NULL
        AND auth_session.expires_at > now()
        AND crew_grant.status = 'consumed'
        AND crew_grant.expires_at > now()
        AND inventory_session.status = 'active'
      ${lockClause}
    `,
    [authSessionId, tenantId, sessionId, userId]
  );
  if (!result.rows[0]) {
    throw crewRequestError("This crew access has ended.", 401, "crew_access_ended");
  }
  return result.rows[0];
}

async function retireDetectedExpiredCrewAccess(row) {
  await withTransaction(async client => {
    const current = await client.query(
      `
        SELECT auth_session.id AS auth_session_id,
          auth_session.tenant_id,
          auth_session.session_id,
          auth_session.user_id,
          auth_session.expires_at AS auth_expires_at,
          crew_grant.id AS grant_id,
          crew_grant.status AS grant_status,
          crew_grant.expires_at AS grant_expires_at
        FROM session_crew_auth_sessions auth_session
        JOIN session_crew_grants crew_grant
          ON crew_grant.id = auth_session.grant_id
          AND crew_grant.tenant_id = auth_session.tenant_id
          AND crew_grant.session_id = auth_session.session_id
          AND crew_grant.consumed_by = auth_session.user_id
        WHERE auth_session.id = $1
          AND auth_session.tenant_id = $2
          AND auth_session.session_id = $3
          AND auth_session.user_id = $4
        FOR UPDATE OF auth_session, crew_grant
      `,
      [row.auth_session_id, row.tenant_id, row.session_id, row.user_id]
    );
    const access = current.rows[0];
    if (!access) return;
    const expired = access.grant_status === "expired"
      || new Date(access.auth_expires_at).getTime() <= Date.now()
      || new Date(access.grant_expires_at).getTime() <= Date.now();
    if (!expired) return;

    const retiredGrant = await client.query(
      `
        UPDATE session_crew_grants
        SET status = 'expired', revoke_reason = 'expired'
        WHERE id = $1 AND status IN ('pending', 'consumed')
        RETURNING id
      `,
      [access.grant_id]
    );
    const retiredAuth = await client.query(
      `
        UPDATE session_crew_auth_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id
      `,
      [access.auth_session_id]
    );
    const releasedClaimCount = await releaseCrewClaims(client, {
      tenantId: access.tenant_id,
      sessionId: access.session_id,
      userId: access.user_id,
      reason: "expired"
    });
    if (retiredGrant.rows[0] || retiredAuth.rows[0]) {
      await client.query(
        `
          INSERT INTO audit_events (tenant_id, action, entity_type, entity_id, metadata)
          VALUES ($1, 'crew_access.expired', 'session_crew_grant', $2, $3::jsonb)
        `,
        [
          access.tenant_id,
          access.grant_id,
          JSON.stringify({ sessionId: access.session_id, releasedClaimCount })
        ]
      );
    }
  });
}

export async function authenticateCrewRequest(request) {
  const token = readCookie(request, crewCookieName);
  if (!token) return null;
  const result = await query(
    `
      SELECT auth_session.id AS auth_session_id,
        auth_session.tenant_id,
        auth_session.session_id,
        auth_session.expires_at AS auth_expires_at,
        auth_session.revoked_at AS auth_revoked_at,
        crew_grant.id AS grant_id,
        crew_grant.status AS grant_status,
        crew_grant.expires_at AS grant_expires_at,
        tenant.slug AS tenant_slug,
        tenant.name AS tenant_name,
        inventory_session.name AS session_name,
        inventory_session.status AS session_status,
        app_user.id AS user_id,
        app_user.email,
        app_user.display_name,
        app_user.account_type
      FROM session_crew_auth_sessions auth_session
      JOIN session_crew_grants crew_grant
        ON crew_grant.id = auth_session.grant_id
        AND crew_grant.tenant_id = auth_session.tenant_id
        AND crew_grant.session_id = auth_session.session_id
        AND crew_grant.consumed_by = auth_session.user_id
      JOIN tenants tenant ON tenant.id = auth_session.tenant_id
      JOIN inventory_sessions inventory_session
        ON inventory_session.id = auth_session.session_id
        AND inventory_session.tenant_id = auth_session.tenant_id
      JOIN app_users app_user ON app_user.id = auth_session.user_id
      WHERE auth_session.token_digest = $1
      LIMIT 1
    `,
    [crewTokenDigest(token)]
  );
  const row = result.rows[0];
  if (!row) return null;

  const requestTenantSlug = tenantSlugFromHost(request);
  if (requestTenantSlug && requestTenantSlug !== row.tenant_slug) {
    throw crewRequestError("Crew access belongs to a different platoon.", 403, "access_denied");
  }
  assertCrewRequestOrigin(request, row.tenant_slug);

  const ended = row.auth_revoked_at
    || new Date(row.auth_expires_at).getTime() <= Date.now()
    || row.grant_status !== "consumed"
    || new Date(row.grant_expires_at).getTime() <= Date.now()
    || row.session_status !== "active";
  if (ended) {
    const expired = row.grant_status === "expired"
      || new Date(row.auth_expires_at).getTime() <= Date.now()
      || new Date(row.grant_expires_at).getTime() <= Date.now();
    if (expired) await retireDetectedExpiredCrewAccess(row);
    throw crewRequestError("This crew access has ended.", 401, "crew_access_ended");
  }

  await query(
    `
      UPDATE session_crew_auth_sessions
      SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'
    `,
    [row.auth_session_id]
  );

  return {
    authKind: "crew",
    identity: {
      subject: `crew:${row.grant_id}`,
      email: "",
      displayName: row.display_name,
      groups: [],
      isPlatformAdmin: false,
      isFrgAdmin: false,
      claims: { crew: true }
    },
    user: {
      id: row.user_id,
      email: null,
      display_name: row.display_name,
      account_type: row.account_type
    },
    crew: {
      grantId: row.grant_id,
      authSessionId: row.auth_session_id,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      sessionId: row.session_id,
      sessionName: row.session_name,
      expiresAt: row.auth_expires_at
    }
  };
}

export async function revokeCrewAuthSession(request, response) {
  const token = readCookie(request, crewCookieName);
  if (token) {
    await withTransaction(async client => {
      const current = await client.query(
        `
          SELECT auth_session.id AS auth_session_id,
            auth_session.tenant_id,
            auth_session.session_id,
            auth_session.user_id,
            crew_grant.id AS grant_id,
            crew_grant.status AS grant_status,
            tenant.slug
          FROM session_crew_auth_sessions auth_session
          JOIN session_crew_grants crew_grant
            ON crew_grant.id = auth_session.grant_id
            AND crew_grant.tenant_id = auth_session.tenant_id
            AND crew_grant.session_id = auth_session.session_id
            AND crew_grant.consumed_by = auth_session.user_id
          JOIN tenants tenant ON tenant.id = auth_session.tenant_id
          WHERE auth_session.token_digest = $1
          LIMIT 1
          FOR UPDATE OF auth_session, crew_grant
        `,
        [crewTokenDigest(token)]
      );
      const session = current.rows[0];
      if (!session) return;
      assertCrewRequestOrigin(request, session.slug);

      const releasedClaimCount = await releaseCrewClaims(client, {
        tenantId: session.tenant_id,
        sessionId: session.session_id,
        userId: session.user_id,
        actorUserId: session.user_id,
        reason: "crew_logout"
      });
      if (session.grant_status === "consumed") {
        await client.query(
          `
            UPDATE session_crew_grants
            SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
              revoked_by = COALESCE(revoked_by, $2), revoke_reason = 'crew_logout'
            WHERE id = $1 AND status = 'consumed'
          `,
          [session.grant_id, session.user_id]
        );
      }
      await client.query(
        `
          UPDATE session_crew_auth_sessions
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1
        `,
        [session.auth_session_id]
      );
      await client.query(
        `
          INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, $2, 'crew_access.logged_out', 'session_crew_grant', $3, $4::jsonb)
        `,
        [
          session.tenant_id,
          session.user_id,
          session.grant_id,
          JSON.stringify({ sessionId: session.session_id, releasedClaimCount })
        ]
      );
    });
  }
  clearCrewCookie(response);
}

export async function releaseCrewClaims(client, {
  tenantId,
  sessionId,
  userId,
  actorUserId = null,
  reason = "crew_access_ended"
}) {
  if (!tenantId || !sessionId || !userId) return 0;
  const released = await client.query(
    `
      UPDATE inventory_session_items session_item
      SET assigned_to = NULL,
        assigned_by = NULL,
        assigned_at = NULL,
        updated_at = now()
      FROM inventory_sessions inventory_session
      WHERE session_item.session_id = inventory_session.id
        AND inventory_session.tenant_id = $1
        AND inventory_session.id = $2
        AND session_item.assigned_to = $3
        AND session_item.status = 'unchecked'
        AND NOT EXISTS (
          SELECT 1
          FROM item_submissions submission
          WHERE submission.session_item_id = session_item.id
        )
      RETURNING session_item.id
    `,
    [tenantId, sessionId, userId]
  );
  if (released.rows.length) {
    await client.query(
      `
        INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, 'crew_access.claims_released', 'inventory_session', $3, $4::jsonb)
      `,
      [
        tenantId,
        actorUserId,
        sessionId,
        JSON.stringify({ crewUserId: userId, reason, releasedClaimCount: released.rows.length })
      ]
    );
  }
  return released.rows.length;
}

export async function revokeCrewAccessForSession(client, { tenantId, sessionId, actorUserId = null, reason = "session_closed" }) {
  const grants = await client.query(
    `
      UPDATE session_crew_grants
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()),
        revoked_by = COALESCE(revoked_by, $3), revoke_reason = $4
      WHERE tenant_id = $1 AND session_id = $2
        AND status IN ('pending', 'consumed')
      RETURNING id, consumed_by
    `,
    [tenantId, sessionId, actorUserId, reason]
  );
  if (grants.rows.length) {
    await client.query(
      `
        UPDATE session_crew_auth_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE grant_id = ANY($1::uuid[])
      `,
      [grants.rows.map(row => row.id)]
    );
  }
  const crewUsers = await client.query(
    `
      SELECT DISTINCT consumed_by
      FROM session_crew_grants
      WHERE tenant_id = $1 AND session_id = $2 AND consumed_by IS NOT NULL
    `,
    [tenantId, sessionId]
  );
  for (const row of crewUsers.rows) {
    await releaseCrewClaims(client, {
      tenantId,
      sessionId,
      userId: row.consumed_by,
      actorUserId,
      reason
    });
  }
  return grants.rows.length;
}

export async function crewMediaAccessIsActive({ authSessionId, tenantId, sessionId }) {
  if (!authSessionId || !tenantId || !sessionId) return false;
  const result = await query(
    `
      SELECT 1
      FROM session_crew_auth_sessions auth_session
      JOIN session_crew_grants crew_grant
        ON crew_grant.id = auth_session.grant_id
        AND crew_grant.tenant_id = auth_session.tenant_id
        AND crew_grant.session_id = auth_session.session_id
        AND crew_grant.consumed_by = auth_session.user_id
      JOIN inventory_sessions inventory_session
        ON inventory_session.id = auth_session.session_id
        AND inventory_session.tenant_id = auth_session.tenant_id
      WHERE auth_session.id = $1
        AND auth_session.tenant_id = $2
        AND auth_session.session_id = $3
        AND auth_session.revoked_at IS NULL
        AND auth_session.expires_at > now()
        AND crew_grant.status = 'consumed'
        AND crew_grant.expires_at > now()
        AND inventory_session.status = 'active'
      LIMIT 1
    `,
    [authSessionId, tenantId, sessionId]
  );
  return Boolean(result.rows[0]);
}
