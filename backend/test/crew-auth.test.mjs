import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import {
  assertCrewRequestOrigin,
  crewAccessIsInactive,
  crewCodeDigest,
  crewCookieValue,
  crewInviteTokenDigest,
  crewTokenDigest,
  generateCrewCode,
  generateCrewInviteToken,
  hasPrimaryAuthCredentials,
  readCookie
} from "../src/crew-auth.js";

test("temporary crew access expires after 36 hours without activity", () => {
  const now = Date.parse("2026-07-18T18:00:00.000Z");
  assert.equal(crewAccessIsInactive("2026-07-17T06:00:00.001Z", { now, inactivityTtlHours: 36 }), false);
  assert.equal(crewAccessIsInactive("2026-07-17T06:00:00.000Z", { now, inactivityTtlHours: 36 }), true);
  assert.equal(crewAccessIsInactive("not-a-date", { now, inactivityTtlHours: 36 }), true);
});

test("crew codes are exactly four decimal digits and digests are tenant scoped", () => {
  for (let index = 0; index < 200; index += 1) {
    assert.match(generateCrewCode(), /^\d{4}$/);
  }
  const first = crewCodeDigest("tenant-a", "0042");
  assert.notEqual(first, crewCodeDigest("tenant-b", "0042"));
  assert.notEqual(first, crewCodeDigest("tenant-a", "0043"));
  assert.doesNotMatch(first, /0042/);
  assert.equal(crewTokenDigest("token"), crewTokenDigest("token"));
  assert.notEqual(crewTokenDigest("token"), crewTokenDigest("other-token"));
});

test("crew invite tokens carry high entropy and digests are tenant scoped", () => {
  const generated = new Set();
  for (let index = 0; index < 200; index += 1) {
    const token = generateCrewInviteToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    generated.add(token);
  }
  assert.equal(generated.size, 200);

  const token = generateCrewInviteToken();
  const first = crewInviteTokenDigest("tenant-a", token);
  assert.equal(first, crewInviteTokenDigest("tenant-a", token));
  assert.notEqual(first, crewInviteTokenDigest("tenant-b", token));
  assert.notEqual(first, crewInviteTokenDigest("tenant-a", generateCrewInviteToken()));
  assert.doesNotMatch(first, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("crew cookie is host-only, HttpOnly, strict, API scoped, and secure in production", () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const productionCookie = crewCookieValue("secret token", expiresAt, { production: true });
  assert.match(productionCookie, /^inventory_crew_session=secret%20token;/);
  assert.match(productionCookie, /Path=\/api/);
  assert.match(productionCookie, /Max-Age=\d+/);
  assert.match(productionCookie, /HttpOnly/);
  assert.match(productionCookie, /SameSite=Strict/);
  assert.match(productionCookie, /Secure/);
  assert.doesNotMatch(productionCookie, /Domain=/i);

  const developmentCookie = crewCookieValue("token", expiresAt, { production: false });
  assert.doesNotMatch(developmentCookie, /; Secure/);
});

test("cookie parsing is exact and bearer or development identity takes precedence", () => {
  assert.equal(readCookie({ headers: { cookie: "other=1; inventory_crew_session=hello%20crew" } }, "inventory_crew_session"), "hello crew");
  assert.equal(readCookie({ headers: { cookie: "inventory_crew_session_extra=nope" } }, "inventory_crew_session"), "");
  assert.equal(hasPrimaryAuthCredentials({ headers: { authorization: "Bearer primary" } }), true);
  assert.equal(hasPrimaryAuthCredentials({ headers: {} }), false);
});

test("crew mutating requests require the exact tenant origin", () => {
  const local = ["localhost", "127.0.0.1"].includes(config.baseDomain);
  const protocol = local ? "http" : "https";
  const goodOrigin = `${protocol}://ms.${config.baseDomain}${local ? ":5175" : ""}`;
  assert.doesNotThrow(() => assertCrewRequestOrigin({
    method: "POST",
    headers: { origin: goodOrigin }
  }, "ms"));
  assert.throws(() => assertCrewRequestOrigin({
    method: "POST",
    headers: { origin: `${protocol}://other.${config.baseDomain}` }
  }, "ms"), error => error.statusCode === 403);
  assert.throws(() => assertCrewRequestOrigin({
    method: "POST",
    headers: { origin: `${protocol}://nested.ms.${config.baseDomain}${local ? ":5175" : ""}` }
  }, "ms"), error => error.statusCode === 403);
  assert.throws(() => assertCrewRequestOrigin({ method: "POST", headers: {} }, "ms"), error => error.statusCode === 403);
  assert.doesNotThrow(() => assertCrewRequestOrigin({ method: "GET", headers: {} }, "ms"));
});
