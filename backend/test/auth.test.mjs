import assert from "node:assert/strict";
import test from "node:test";
import { errors } from "jose";
import {
  authenticate,
  classifyOidcRefreshFailure,
  ensureUser,
  oidcRefreshCookieName,
  oidcRefreshCookieValue,
  refreshOidcTokens
} from "../src/auth.js";
import { config } from "../src/config.js";

const bearerRequest = {
  headers: {
    authorization: "Bearer test-token",
    "x-id-token": "test-id-token"
  }
};

test("OIDC renewal cookie is API-scoped, HttpOnly, same-site, and host-only", () => {
  const cookie = oidcRefreshCookieValue("rotating refresh token", {
    production: true,
    maxAgeDays: 30
  });
  assert.match(cookie, new RegExp(`^${oidcRefreshCookieName}=rotating%20refresh%20token;`));
  assert.match(cookie, /Path=\/api\/auth\/oidc\/refresh/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

const rejectedTokenErrors = [
  new errors.JOSEAlgNotAllowed("algorithm not allowed"),
  new errors.JWSInvalid("malformed JWS"),
  new errors.JWSSignatureVerificationFailed(),
  new errors.JWKSNoMatchingKey(),
  new errors.JWTClaimValidationFailed("unexpected issuer", {}, "iss", "check_failed"),
  new errors.JWTExpired("token expired", {}, "exp", "check_failed"),
  new errors.JWTInvalid("malformed JWT")
];

test("invalid or expired bearer tokens authenticate as unauthenticated", async () => {
  for (const tokenError of rejectedTokenErrors) {
    const result = await authenticate(bearerRequest, async () => {
      throw tokenError;
    });

    assert.equal(result, null, tokenError.code);
  }
});

test("malformed bearer tokens are rejected before OIDC discovery", async () => {
  const result = await authenticate({
    headers: {
      authorization: "Bearer malformed"
    }
  });

  assert.equal(result, null);
});

test("verified bearer identity is returned unchanged", async () => {
  const identity = { subject: "test-subject", email: "test@example.com" };
  const result = await authenticate(bearerRequest, async (accessToken, idToken) => {
    assert.equal(accessToken, "test-token");
    assert.equal(idToken, "test-id-token");
    return identity;
  });

  assert.equal(result, identity);
});

test("JWKS, discovery, and network failures remain server errors", async () => {
  const providerErrors = [
    new errors.JWKSInvalid("invalid JWKS response"),
    new errors.JWKSMultipleMatchingKeys(),
    new errors.JWKSTimeout(),
    new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    new Error("OIDC discovery failed (503)")
  ];

  for (const providerError of providerErrors) {
    await assert.rejects(
      authenticate(bearerRequest, async () => {
        throw providerError;
      }),
      error => error === providerError,
      providerError.code || providerError.message
    );
  }
});

test("OIDC refresh exchanges the rotating token without a browser redirect", async () => {
  const originalFetch = globalThis.fetch;
  const originalDiscoveryUrl = config.oidc.discoveryUrl;
  const originalClientId = config.oidc.clientId;
  const calls = [];
  config.oidc.discoveryUrl = "https://auth.example.test/application/o/inventory/.well-known/openid-configuration";
  config.oidc.clientId = "inventory-web";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        jwks_uri: "https://auth.example.test/application/o/inventory/jwks/",
        token_endpoint: "https://auth.example.test/application/o/token/"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      access_token: "renewed-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const [tokenSet, concurrentTokenSet] = await Promise.all([
      refreshOidcTokens({ refreshToken: "original-refresh" }),
      refreshOidcTokens({ refreshToken: "original-refresh" })
    ]);
    assert.equal(tokenSet.access_token, "renewed-access");
    assert.equal(concurrentTokenSet.refresh_token, "rotated-refresh");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://auth.example.test/application/o/token/");
    const body = new URLSearchParams(String(calls[1].options.body));
    assert.equal(body.get("client_id"), "inventory-web");
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "original-refresh");
  } finally {
    globalThis.fetch = originalFetch;
    config.oidc.discoveryUrl = originalDiscoveryUrl;
    config.oidc.clientId = originalClientId;
  }
});

test("OIDC refresh failures preserve renewable sessions during provider outages", () => {
  assert.deepEqual(classifyOidcRefreshFailure(400, "invalid_grant"), {
    statusCode: 401,
    publicCode: "oidc_refresh_rejected",
    message: "The renewable sign-in session is no longer valid.",
    clearRefreshCookie: true
  });
  assert.deepEqual(classifyOidcRefreshFailure(401, ""), {
    statusCode: 401,
    publicCode: "oidc_refresh_rejected",
    message: "The renewable sign-in session is no longer valid.",
    clearRefreshCookie: true
  });
  for (const status of [429, 500, 503]) {
    const failure = classifyOidcRefreshFailure(status, "temporarily_unavailable");
    assert.equal(failure.publicCode, "oidc_refresh_unavailable");
    assert.equal(failure.clearRefreshCookie, false);
    assert.ok(failure.statusCode >= 500);
  }
});

function scriptedClient(responses) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const response = responses.shift();
      assert.ok(response, `Unexpected query: ${text}`);
      return typeof response === "function" ? response(text, params) : response;
    }
  };
}

test("ensureUser resolves an existing subject before changing its email", async () => {
  const client = scriptedClient([
    {
      rows: [{
        id: "subject-user",
        authentik_subject: "authentik-subject",
        email: "old@example.test",
        display_name: "Old name",
        authentik_user_pk: 42,
        authentik_user_uuid: "db7a5d19-32f5-4d86-a7c8-87951129ad05",
        authentik_enrollment_sent_at: "2026-07-14T12:00:00Z",
        authentik_enrollment_job_id: null
      }]
    },
    (_text, params) => ({
      rows: [{
        id: params[0],
        authentik_subject: params[1],
        email: params[2],
        display_name: params[3],
        authentik_user_pk: 42,
        authentik_user_uuid: "db7a5d19-32f5-4d86-a7c8-87951129ad05",
        authentik_enrollment_sent_at: "2026-07-14T12:00:00Z",
        authentik_enrollment_job_id: null
      }]
    })
  ]);

  const user = await ensureUser({
    subject: "authentik-subject",
    email: " New@Example.Test ",
    displayName: "New name",
    providerUserUuid: "db7a5d19-32f5-4d86-a7c8-87951129ad05"
  }, client);

  assert.equal(user.id, "subject-user");
  assert.equal(user.email, "new@example.test");
  assert.equal(user.authentik_enrollment_sent_at, "2026-07-14T12:00:00Z");
  assert.equal(user.authentik_enrollment_job_id, null);
  assert.deepEqual(client.calls[0].params, [
    "authentik-subject",
    "new@example.test",
    "db7a5d19-32f5-4d86-a7c8-87951129ad05"
  ]);
  assert.match(client.calls[0].text, /ORDER BY id\s+FOR UPDATE/i);
});

test("ensureUser links an invited email placeholder with no identity subject", async () => {
  const client = scriptedClient([
    {
      rows: [{
        id: "invited-user",
        authentik_subject: null,
        email: "invitee@example.test",
        display_name: "Invitee"
      }]
    },
    {
      rows: [{
        id: "invited-user",
        authentik_subject: "new-subject",
        email: "invitee@example.test",
        display_name: "Invitee"
      }]
    }
  ]);

  const user = await ensureUser({
    subject: "new-subject",
    email: "invitee@example.test",
    displayName: "Invitee"
  }, client);

  assert.equal(user.authentik_subject, "new-subject");
  assert.match(client.calls[1].text, /authentik_subject IS NULL/);
});

test("ensureUser rejects email reuse when the OIDC UUID differs from the provisioned account", async () => {
  const provisionedUuid = "db7a5d19-32f5-4d86-a7c8-87951129ad05";
  const differentUuid = "91e8139a-c2ff-4dc1-b423-016a6738a877";
  const client = scriptedClient([{
    rows: [{
      id: "invited-user",
      authentik_subject: null,
      email: "invitee@example.test",
      display_name: "Invitee",
      authentik_user_uuid: provisionedUuid,
      authentik_oidc_user_uuid: null
    }]
  }]);

  await assert.rejects(
    ensureUser({
      subject: "replacement-subject",
      email: "invitee@example.test",
      displayName: "Replacement",
      providerUserUuid: differentUuid
    }, client),
    error => error?.statusCode === 409 && error?.code === "identity_conflict"
  );
  assert.equal(client.calls.length, 1);
});

test("ensureUser links by immutable UUID when the Authentik email changed", async () => {
  const providerUserUuid = "db7a5d19-32f5-4d86-a7c8-87951129ad05";
  const client = scriptedClient([
    {
      rows: [{
        id: "provisioned-user",
        authentik_subject: null,
        email: "old@example.test",
        display_name: "Existing name",
        authentik_user_uuid: providerUserUuid,
        authentik_oidc_user_uuid: null
      }]
    },
    {
      rows: [{
        id: "provisioned-user",
        authentik_subject: "stable-subject",
        email: "new@example.test",
        display_name: "Existing name",
        authentik_oidc_user_uuid: providerUserUuid
      }]
    }
  ]);

  const user = await ensureUser({
    subject: "stable-subject",
    email: "new@example.test",
    displayName: "New token name",
    providerUserUuid
  }, client);

  assert.equal(user.id, "provisioned-user");
  assert.deepEqual(
    client.calls[0].params,
    ["stable-subject", "new@example.test", providerUserUuid]
  );
  assert.equal(client.calls[1].params[4], providerUserUuid);
});

test("ensureUser fails closed when an email belongs to a different non-null subject", async () => {
  const client = scriptedClient([{
    rows: [{
      id: "other-user",
      authentik_subject: "other-subject",
      email: "shared@example.test",
      display_name: "Other"
    }]
  }]);

  await assert.rejects(
    ensureUser({
      subject: "attacker-subject",
      email: "SHARED@example.test",
      displayName: "Attacker"
    }, client),
    error => error?.statusCode === 409 && error?.code === "identity_conflict"
  );
  assert.equal(client.calls.length, 1);
});

test("ensureUser fails closed when subject and email resolve to different local users", async () => {
  const client = scriptedClient([{
    rows: [
      {
        id: "subject-user",
        authentik_subject: "known-subject",
        email: "old@example.test",
        display_name: "Known"
      },
      {
        id: "email-user",
        authentik_subject: null,
        email: "target@example.test",
        display_name: "Target"
      }
    ]
  }]);

  await assert.rejects(
    ensureUser({
      subject: "known-subject",
      email: "target@example.test",
      displayName: "Known"
    }, client),
    error => error?.statusCode === 409 && error?.code === "identity_conflict"
  );
});

test("ensureUser fails closed when legacy case variants duplicate an email", async () => {
  const client = scriptedClient([{
    rows: [
      {
        id: "upper-email-user",
        authentik_subject: null,
        email: "Invitee@Example.Test",
        display_name: "Invitee one"
      },
      {
        id: "lower-email-user",
        authentik_subject: null,
        email: "invitee@example.test",
        display_name: "Invitee two"
      }
    ]
  }]);

  await assert.rejects(
    ensureUser({
      subject: "new-subject",
      email: "invitee@example.test",
      displayName: "Invitee"
    }, client),
    error => error?.statusCode === 409 && error?.code === "identity_conflict"
  );
  assert.equal(client.calls.length, 1);
});
