import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalQaTargets } from "../playwright.qa.config.mjs";

test("Playwright QA accepts loopback and localhost subdomain targets", () => {
  assert.doesNotThrow(() => assertLocalQaTargets({
    QA_FRONTEND_URL: "http://localhost:5175",
    QA_ADMIN_URL: "http://admin.localhost:5175/#/admin",
    QA_API_URL: "http://127.0.0.1:5300/api",
    QA_DATABASE_URL: "postgresql://inventory:secret@[::1]:55432/inventory"
  }));
});

test("Playwright QA rejects production and other remote targets", () => {
  for (const [name, value] of [
    ["QA_API_URL", "https://api.876en.org/api"],
    ["QA_TENANT_URL", "https://ms.876en.org/#/admin"],
    ["QA_DATABASE_URL", "postgresql://inventory:secret@database.example.com/inventory"]
  ]) {
    assert.throws(
      () => assertLocalQaTargets({ [name]: value }),
      error => error?.message?.includes(name) && /must target localhost/i.test(error.message)
    );
  }
});

test("Playwright QA rejects malformed target overrides", () => {
  assert.throws(
    () => assertLocalQaTargets({ QA_FRONTEND_URL: "not a URL" }),
    /QA_FRONTEND_URL must be a valid local URL/i
  );
});
