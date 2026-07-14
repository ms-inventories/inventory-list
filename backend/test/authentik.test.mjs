import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthentikClientError,
  createAuthentikClient
} from "../src/authentik.js";

const origin = "https://auth.example.test";
const token = "test-service-token";
const groupId = "2c04b8a4-4e31-4d8a-87fe-33a8f4a898bc";
const emailStage = "61aa7317-087f-4ed0-b446-485b6934b145";

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function mockFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, options);
    if (!next) throw new Error("Unexpected mocked Authentik request");
    return next;
  };
  return { fetchImpl, calls };
}

function client(fetchImpl, options = {}) {
  return createAuthentikClient({ origin, token, fetchImpl, ...options });
}

function assertClientError(code, statusCode = null) {
  return error => {
    assert.ok(error instanceof AuthentikClientError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}

test("configuration requires a canonical HTTPS origin, token, and bounded options", () => {
  const noopFetch = async () => empty();

  for (const unsafeOrigin of [
    "http://auth.example.test",
    "https://user:password@auth.example.test",
    "https://auth.example.test/api",
    "https://auth.example.test?next=elsewhere",
    "not a url"
  ]) {
    assert.throws(
      () => createAuthentikClient({ origin: unsafeOrigin, token, fetchImpl: noopFetch }),
      assertClientError("authentik_config_invalid")
    );
  }

  assert.throws(
    () => createAuthentikClient({ origin, token: "", fetchImpl: noopFetch }),
    assertClientError("authentik_config_invalid")
  );
  assert.throws(
    () => createAuthentikClient({ origin, token: "line\nbreak", fetchImpl: noopFetch }),
    assertClientError("authentik_config_invalid")
  );
  assert.throws(
    () => createAuthentikClient({ origin, token, fetchImpl: noopFetch, timeoutMs: 30_001 }),
    assertClientError("authentik_config_invalid")
  );
  assert.throws(
    () => createAuthentikClient({ origin, token, fetchImpl: noopFetch, maxResponseBytes: 1_048_577 }),
    assertClientError("authentik_config_invalid")
  );

  const configured = createAuthentikClient({
    origin: "https://AUTH.EXAMPLE.TEST/",
    token,
    fetchImpl: noopFetch
  });
  assert.equal(configured.origin, origin);
  assert.equal("token" in configured, false);
});

test("exact email lookup uses the Authentik filter and distinguishes zero, one, and ambiguous matches", async () => {
  const user = { pk: 42, email: "Person@Example.Test", groups: [] };
  const { fetchImpl, calls } = mockFetch(
    json({ results: [] }),
    json({ results: [user] }),
    json({ results: [user, { ...user, pk: 43 }] })
  );
  const authentik = client(fetchImpl);

  assert.equal(await authentik.findUserByEmail("missing@example.test"), null);
  assert.deepEqual(await authentik.findUserByEmail(" person@example.test "), user);
  await assert.rejects(
    authentik.findUserByEmail("PERSON@example.test"),
    assertClientError("authentik_user_ambiguous")
  );

  const url = calls[1].url;
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/api/v3/core/users/");
  assert.equal(url.searchParams.get("email"), "person@example.test");
  assert.equal(url.searchParams.get("page_size"), "2");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
});

test("group lookup accepts only the exact requested name and rejects duplicates", async () => {
  const exact = { pk: groupId, name: "876en-ms", users: [] };
  const { fetchImpl, calls } = mockFetch(
    json({ results: [{ ...exact, name: "876en-ms-admin" }] }),
    json({ results: [exact] }),
    json({ results: [exact, { ...exact, pk: "49591068-0f64-4a9d-a1bd-d2c9ebcd40dc" }] })
  );
  const authentik = client(fetchImpl);

  assert.equal(await authentik.findGroupByName("876en-ms"), null);
  assert.deepEqual(await authentik.findGroupByName("876en-ms"), exact);
  await assert.rejects(
    authentik.findGroupByName("876en-ms"),
    assertClientError("authentik_group_ambiguous")
  );

  assert.equal(calls[0].url.pathname, "/api/v3/core/groups/");
  assert.equal(calls[0].url.searchParams.get("name"), "876en-ms");
  assert.equal(calls[0].url.searchParams.get("include_users"), "false");
});

test("createOrLinkUser reuses an exact identity and creates a missing internal user", async () => {
  const existing = { pk: 9, email: "existing@example.test", groups: [] };
  const existingMock = mockFetch(json({ results: [existing] }));
  const linked = await client(existingMock.fetchImpl).createOrLinkUser({
    email: existing.email,
    name: "Existing Person"
  });
  assert.deepEqual(linked, { user: existing, created: false });
  assert.equal(existingMock.calls.length, 1);

  const created = {
    pk: 10,
    email: "new@example.test",
    name: "New Person",
    groups: []
  };
  const createMock = mockFetch(json({ results: [] }), json(created, 201));
  const result = await client(createMock.fetchImpl).ensureUser({
    email: "New@Example.Test",
    name: "New Person",
    path: "users/inventory",
    attributes: { inventory_managed: true }
  });

  assert.deepEqual(result, { user: created, created: true });
  assert.equal(createMock.calls[1].url.pathname, "/api/v3/core/users/");
  assert.equal(createMock.calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(createMock.calls[1].options.body), {
    username: "new@example.test",
    name: "New Person",
    email: "new@example.test",
    is_active: true,
    type: "internal",
    path: "users/inventory",
    attributes: { inventory_managed: true }
  });
});

test("createOrLinkUser recovers idempotently when a concurrent create wins", async () => {
  const raced = { pk: 71, email: "race@example.test", groups: [] };
  const { fetchImpl, calls } = mockFetch(
    json({ results: [] }),
    json({ detail: "already exists", access_token: "must-not-leak" }, 409),
    json({ results: [raced] })
  );

  const result = await client(fetchImpl).createOrLinkUser({
    email: raced.email,
    name: "Race Winner"
  });

  assert.deepEqual(result, { user: raced, created: false });
  assert.equal(calls.length, 3);
});

test("create payload flags must be actual booleans", async () => {
  const authentik = client(async () => {
    throw new Error("validation should happen before fetch");
  });
  await assert.rejects(
    authentik.createUser({
      email: "person@example.test",
      name: "Person",
      isActive: "false"
    }),
    assertClientError("authentik_config_invalid")
  );
  await assert.rejects(
    authentik.createGroup({ name: "876en-ms", isSuperuser: "false" }),
    assertClientError("authentik_config_invalid")
  );
});

test("ensureGroup is idempotent and recovers from a concurrent create", async () => {
  const group = { pk: groupId, name: "876en-ms", users: [] };
  const existingMock = mockFetch(json({ results: [group] }));
  assert.deepEqual(
    await client(existingMock.fetchImpl).ensureGroup({ name: group.name }),
    { group, created: false }
  );

  const raceMock = mockFetch(
    json({ results: [] }),
    json({ detail: "duplicate" }, 400),
    json({ results: [group] })
  );
  assert.deepEqual(
    await client(raceMock.fetchImpl).ensureGroup({
      name: group.name,
      attributes: { inventory_managed: true }
    }),
    { group, created: false }
  );
  assert.equal(raceMock.calls[1].options.method, "POST");
});

test("group membership actions match the 2026.5.3 API and wrappers avoid redundant calls", async () => {
  const { fetchImpl, calls } = mockFetch(empty(), empty());
  const authentik = client(fetchImpl);
  const user = { pk: 42, groups: [] };
  const group = { pk: groupId };

  assert.deepEqual(await authentik.ensureUserInGroup(user, group), { changed: true });
  assert.deepEqual(
    await authentik.ensureUserInGroup({ ...user, groups: [groupId] }, group),
    { changed: false }
  );
  assert.deepEqual(await authentik.removeUserFromGroup(groupId, 42), { changed: true });
  assert.deepEqual(
    await authentik.ensureUserNotInGroup({ ...user, groups: [] }, group),
    { changed: false }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, `/api/v3/core/groups/${groupId}/add_user/`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { pk: 42 });
  assert.equal(calls[1].url.pathname, `/api/v3/core/groups/${groupId}/remove_user/`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { pk: 42 });
});

test("enrollment email uses Authentik recovery_email with the installed schema body", async () => {
  const { fetchImpl, calls } = mockFetch(empty(), empty());
  const authentik = client(fetchImpl);

  assert.deepEqual(await authentik.sendEnrollmentEmail({
    userId: 42,
    emailStage,
    tokenDuration: "days=7"
  }), { sent: true });
  assert.deepEqual(await authentik.sendRecoveryEmail({
    userId: 43,
    emailStage
  }), { sent: true });

  assert.equal(calls[0].url.pathname, "/api/v3/core/users/42/recovery_email/");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email_stage: emailStage,
    token_duration: "days=7"
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    email_stage: emailStage
  });
});

test("JSON responses are stream-bounded and malformed responses fail closed", async () => {
  const oversized = json({ results: [{ email: "large@example.test", value: "x".repeat(100) }] });
  const malformed = new Response("not json", {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  const wrongType = new Response("<html></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
  const { fetchImpl } = mockFetch(oversized, malformed, wrongType);
  const authentik = client(fetchImpl, { maxResponseBytes: 48 });

  await assert.rejects(
    authentik.findUserByEmail("large@example.test"),
    assertClientError("authentik_response_too_large")
  );
  await assert.rejects(
    authentik.findUserByEmail("malformed@example.test"),
    assertClientError("authentik_invalid_response")
  );
  await assert.rejects(
    authentik.findUserByEmail("wrong@example.test"),
    assertClientError("authentik_invalid_response")
  );
});

test("timeouts, transport failures, and HTTP failures expose no upstream secrets", async () => {
  const timeoutFetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true
    });
  });
  await assert.rejects(
    client(timeoutFetch, { timeoutMs: 5 }).findUserByEmail("person@example.test"),
    assertClientError("authentik_timeout")
  );

  const stalledBodyFetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
      signal.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  await assert.rejects(
    client(stalledBodyFetch, { timeoutMs: 5 }).findUserByEmail("person@example.test"),
    assertClientError("authentik_timeout")
  );

  const transportSecret = "upstream-super-secret";
  await assert.rejects(
    client(async () => {
      throw new Error(`fetch failed with ${transportSecret} and ${token}`);
    }).findUserByEmail("person@example.test"),
    error => {
      assertClientError("authentik_unavailable")(error);
      assert.doesNotMatch(error.message, new RegExp(`${transportSecret}|${token}`));
      assert.equal(error.cause, undefined);
      return true;
    }
  );

  const responseSecret = "response-private-token";
  await assert.rejects(
    client(async () => json({ detail: responseSecret, token }, 403))
      .findUserByEmail("person@example.test"),
    error => {
      assertClientError("authentik_request_failed", 403)(error);
      assert.doesNotMatch(error.message, new RegExp(`${responseSecret}|${token}`));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});
