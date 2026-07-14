import assert from "node:assert/strict";
import test from "node:test";
import { errors } from "jose";
import { authenticate, ensureUser } from "../src/auth.js";

const bearerRequest = {
  headers: {
    authorization: "Bearer test-token",
    "x-id-token": "test-id-token"
  }
};

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
        display_name: "Old name"
      }]
    },
    (_text, params) => ({
      rows: [{
        id: params[0],
        authentik_subject: params[1],
        email: params[2],
        display_name: params[3]
      }]
    })
  ]);

  const user = await ensureUser({
    subject: "authentik-subject",
    email: " New@Example.Test ",
    displayName: "New name"
  }, client);

  assert.equal(user.id, "subject-user");
  assert.equal(user.email, "new@example.test");
  assert.deepEqual(client.calls[0].params, ["authentik-subject", "new@example.test"]);
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
