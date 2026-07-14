import assert from "node:assert/strict";
import test from "node:test";
import { errors } from "jose";
import { authenticate } from "../src/auth.js";

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
