import assert from "node:assert/strict";
import test from "node:test";
import { assertRenewableOidcScope, DEFAULT_OIDC_SCOPE } from "./assert-auth-config.mjs";

test("the default production OIDC scope supports silent renewal", () => {
  const scopes = assertRenewableOidcScope(DEFAULT_OIDC_SCOPE);
  assert.equal(scopes.has("offline_access"), true);
});

test("a production scope without offline_access fails with deployment guidance", () => {
  assert.throws(
    () => assertRenewableOidcScope("openid profile email groups ak_user_uuid"),
    error => /VITE_OIDC_SCOPE.*offline_access.*Authentik/i.test(error?.message || "")
  );
});

test("scope matching uses complete scope names", () => {
  assert.throws(
    () => assertRenewableOidcScope("openid profile offline_access_extra"),
    /must include offline_access/i
  );
});
