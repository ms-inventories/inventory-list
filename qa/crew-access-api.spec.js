import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const QA_DATABASE_URL = process.env.QA_DATABASE_URL || "postgres://inventory:inventory@localhost:55432/inventory_qa";
const TENANT_ORIGIN = process.env.QA_TENANT_ORIGIN || "http://ms.localhost:5175";
const PHOTO_DATA_URL = `data:image/jpeg;base64,${fs.readFileSync(path.resolve("assets/dagr.jpg")).toString("base64")}`;

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};
const qaContributor = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

function identityHeaders(identity) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": "ms"
  };
}

const adminHeaders = () => identityHeaders(qaAdmin);

function crewHeaders({ mutate = false } = {}) {
  return {
    "X-Tenant-Slug": "ms",
    ...(mutate ? { Origin: TENANT_ORIGIN } : {})
  };
}

function crewCredentials(access) {
  return { code: access.code, inviteToken: access.inviteToken };
}

function differentInviteToken(inviteToken) {
  return `${inviteToken.startsWith("A") ? "B" : "A"}${inviteToken.slice(1)}`;
}

async function json(response) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

test("one-time crew access is session scoped and closing revokes it immediately", async ({ request, playwright }, testInfo) => {
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const firstItem = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-FIRST-${suffix}` }
  }));
  const secondItem = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-SECOND-${suffix}` }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Crew ${suffix}` }
  }));
  expect(access.code).toMatch(/^\d{4}$/);
  expect(access.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const listedAccess = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders()
  }));
  const listedGrant = listedAccess.crew.find(entry => entry.id === access.access.id);
  expect(listedGrant).not.toHaveProperty("code");
  expect(listedGrant).not.toHaveProperty("inviteToken");
  expect(listedGrant).not.toHaveProperty("inviteTokenDigest");

  const contributorUnclaimed = await request.post(`${API_URL}/session-items/${secondItem.sessionItem.id}/submissions`, {
    headers: identityHeaders(qaContributor),
    data: { status: "found", locationText: "Should not save" }
  });
  expect(contributorUnclaimed.status()).toBe(409);
  expect(await contributorUnclaimed.json()).toMatchObject({
    code: "conflict",
    error: "Claim this item before submitting proof."
  });

  const crew = await playwright.request.newContext();
  try {
    const missingToken = await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: { code: access.code }
    });
    expect(missingToken.status()).toBe(401);
    const missingTokenBody = await missingToken.json();
    expect(missingTokenBody).toMatchObject({ code: "invalid_crew_code" });

    const wrongToken = await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: { code: access.code, inviteToken: differentInviteToken(access.inviteToken) }
    });
    expect(wrongToken.status()).toBe(401);
    const wrongTokenBody = await wrongToken.json();
    expect(wrongTokenBody).toMatchObject({
      code: missingTokenBody.code,
      error: missingTokenBody.error
    });

    const consumedResponse = await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    });
    const consumed = await json(consumedResponse);
    expect(consumed).toMatchObject({ authKind: "crew", session: { id: session.session.id } });
    const setCookie = consumedResponse.headers()["set-cookie"];
    expect(setCookie).toContain("inventory_crew_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api");

    const me = await json(await crew.get(`${API_URL}/me`, { headers: crewHeaders() }));
    expect(me).toMatchObject({
      authKind: "crew",
      user: { email: null, display_name: `Crew ${suffix}` },
      crew: { sessionId: session.session.id }
    });
    expect(me.membership.role).toBe("crew");

    const sessions = await json(await crew.get(`${API_URL}/inventory/sessions`, { headers: crewHeaders() }));
    expect(sessions.sessions.map(entry => entry.id)).toEqual([session.session.id]);

    const unclaimedProof = await crew.post(`${API_URL}/session-items/${secondItem.sessionItem.id}/submissions`, {
      headers: crewHeaders({ mutate: true }),
      data: { status: "found", locationText: "Should not save" }
    });
    expect(unclaimedProof.status()).toBe(409);
    expect(await unclaimedProof.json()).toMatchObject({ code: "conflict" });

    for (const itemId of [firstItem.sessionItem.id, secondItem.sessionItem.id]) {
      const claimed = await json(await crew.patch(`${API_URL}/session-items/${itemId}/assignment`, {
        headers: crewHeaders({ mutate: true }),
        data: { memberId: "self" }
      }));
      expect(claimed.assignment.assignedTo).toBe(me.user.id);
    }

    const upload = await json(await crew.post(`${API_URL}/uploads/photos`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        fileName: `crew-${suffix}.jpg`,
        mimeType: "image/jpeg",
        dataUrl: PHOTO_DATA_URL,
        kind: "location"
      }
    }));
    const crewProof = await json(await crew.post(`${API_URL}/session-items/${firstItem.sessionItem.id}/submissions`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        status: "found",
        locationText: "QA cage",
        serialNumber: "CREW-QA-1",
        photos: [{ uploadId: upload.photo.uploadId, kind: "location" }]
      }
    }));
    await json(await request.patch(`${API_URL}/submissions/${crewProof.submission.id}/review`, {
      headers: adminHeaders(),
      data: { decision: "approved", saveItem: false }
    }));
    const mediaUrl = new URL(upload.photo.url, API_URL).toString();
    expect((await crew.get(mediaUrl)).status()).toBe(200);
    const membersDenied = await crew.get(`${API_URL}/tenant/members`, { headers: crewHeaders() });
    expect(membersDenied.status()).toBe(401);

    const closed = await json(await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    }));
    expect(closed.crewAccessRevoked).toBe(1);
    const ended = await crew.get(`${API_URL}/me`, { headers: crewHeaders() });
    expect(ended.status()).toBe(401);
    expect(await ended.json()).toMatchObject({ code: "crew_access_ended" });
    expect((await crew.get(mediaUrl)).status()).toBe(403);

    const closedDetail = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders()
    }));
    const preservedItem = closedDetail.items.find(item => item.id === firstItem.sessionItem.id);
    const releasedItem = closedDetail.items.find(item => item.id === secondItem.sessionItem.id);
    expect(preservedItem).toMatchObject({ status: "approved", assignedTo: me.user.id });
    expect(preservedItem.submissions).toHaveLength(1);
    expect(releasedItem).toMatchObject({ status: "unchecked", assignedTo: null });
  } finally {
    await crew.dispose();
  }

  const reused = await playwright.request.newContext();
  try {
    const response = await reused.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_crew_code" });
  } finally {
    await reused.dispose();
  }
});

test("a one-time crew code has exactly one concurrent winner", async ({ request, playwright }, testInfo) => {
  const suffix = `race-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Race ${suffix}` }
  }));
  const first = await playwright.request.newContext();
  const second = await playwright.request.newContext();
  try {
    const responses = await Promise.all([first, second].map(client => client.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    })));
    expect(responses.map(response => response.status()).sort()).toEqual([200, 401]);
  } finally {
    await first.dispose();
    await second.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("crew codes remain reserved after revoke and session deletion", async ({ request }, testInfo) => {
  const suffix = `reservation-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Reserved ${suffix}` }
  }));
  const database = new Client({ connectionString: QA_DATABASE_URL });
  let reservation = null;

  await database.connect();
  try {
    const before = await database.query(
      `
        SELECT reservation.tenant_id, reservation.code_digest, reservation.expires_at
        FROM session_crew_code_reservations reservation
        JOIN session_crew_grants crew_grant
          ON crew_grant.tenant_id = reservation.tenant_id
          AND crew_grant.code_digest = reservation.code_digest
        WHERE crew_grant.id = $1
      `,
      [access.access.id]
    );
    reservation = before.rows[0];
    expect(reservation).toBeTruthy();

    await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access/${access.access.id}/revoke`, {
      headers: adminHeaders()
    }));
    await json(await request.delete(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders()
    }));

    const after = await database.query(
      `
        SELECT expires_at
        FROM session_crew_code_reservations
        WHERE tenant_id = $1 AND code_digest = $2
      `,
      [reservation.tenant_id, reservation.code_digest]
    );
    expect(after.rows).toHaveLength(1);
    expect(new Date(after.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  } finally {
    if (reservation) {
      await database.query(
        "DELETE FROM session_crew_code_reservations WHERE tenant_id = $1 AND code_digest = $2",
        [reservation.tenant_id, reservation.code_digest]
      );
    }
    await database.end();
  }
});

test("legacy pending grants without an invite token fail closed", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Legacy database compatibility only needs one browser project.");
  const suffix = `legacy-token-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Legacy ${suffix}` }
  }));
  const database = new Client({ connectionString: QA_DATABASE_URL });
  const crew = await playwright.request.newContext();

  await database.connect();
  try {
    await database.query(
      "UPDATE session_crew_grants SET invite_token_digest = NULL WHERE id = $1",
      [access.access.id]
    );
    const response = await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_crew_code" });
  } finally {
    await crew.dispose();
    await database.end();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("an invite is retired after its lifetime PIN attempt limit", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Invite attempt-limit coverage only needs one API project.");
  const suffix = `invite-limit-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Limited ${suffix}` }
  }));
  const wrongCode = ((Number(access.code) + 1) % 10_000).toString().padStart(4, "0");
  const attacker = await playwright.request.newContext();
  const retry = await playwright.request.newContext();
  const database = new Client({ connectionString: QA_DATABASE_URL });

  await database.connect();
  try {
    await database.query(
      "DELETE FROM session_crew_login_attempts WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'ms')"
    );
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await attacker.post(`${API_URL}/crew/consume`, {
        headers: { ...crewHeaders({ mutate: true }), "User-Agent": `crew-limit-attacker-${suffix}` },
        data: { code: wrongCode, inviteToken: access.inviteToken }
      });
      expect(response.status()).toBe(attempt === 5 ? 429 : 401);
    }
    const listed = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
      headers: adminHeaders()
    }));
    expect(listed.crew.find(entry => entry.id === access.access.id)).toMatchObject({
      status: "revoked",
      revokeReason: "attempt_limit"
    });
    const correctAfterLimit = await retry.post(`${API_URL}/crew/consume`, {
      headers: { ...crewHeaders({ mutate: true }), "User-Agent": `crew-limit-retry-${suffix}` },
      data: crewCredentials(access)
    });
    expect(correctAfterLimit.status()).toBe(401);
    expect(await correctAfterLimit.json()).toMatchObject({ code: "invalid_crew_code" });
  } finally {
    await database.end();
    await attacker.dispose();
    await retry.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("expired crew access releases untouched claims on detection and leader session refresh", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Expiry lifecycle coverage only needs one API project.");
  const suffix = `expiry-${testInfo.workerIndex}-${Date.now()}`;
  const database = new Client({ connectionString: QA_DATABASE_URL });
  const crewClients = [];
  const sessionIds = [];

  async function createClaimedCrew(label) {
    const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
      headers: adminHeaders(),
      data: { name: `QA crew ${label} ${suffix}`, status: "active" }
    }));
    sessionIds.push(session.session.id);
    const item = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
      headers: adminHeaders(),
      data: { packetLine: `QA-CREW-${label}-${suffix}` }
    }));
    const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
      headers: adminHeaders(),
      data: { displayName: `Expired ${label} ${suffix}` }
    }));
    const crew = await playwright.request.newContext();
    crewClients.push(crew);
    await json(await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    }));
    await json(await crew.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
      headers: crewHeaders({ mutate: true }),
      data: { memberId: "self" }
    }));
    await database.query(
      `
        UPDATE session_crew_grants
        SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE id = $1
      `,
      [access.access.id]
    );
    await database.query(
      `
        UPDATE session_crew_auth_sessions
        SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE grant_id = $1
      `,
      [access.access.id]
    );
    return { session, item, access, crew };
  }

  async function expectRetired(entry) {
    const stored = await database.query(
      `
        SELECT crew_grant.status, crew_grant.revoke_reason, auth_session.revoked_at,
          session_item.assigned_to
        FROM session_crew_grants crew_grant
        JOIN session_crew_auth_sessions auth_session ON auth_session.grant_id = crew_grant.id
        JOIN inventory_session_items session_item ON session_item.id = $2
        WHERE crew_grant.id = $1
      `,
      [entry.access.access.id, entry.item.sessionItem.id]
    );
    expect(stored.rows[0]).toMatchObject({
      status: "expired",
      revoke_reason: "expired",
      assigned_to: null
    });
    expect(stored.rows[0].revoked_at).toBeTruthy();
  }

  await database.connect();
  try {
    const detected = await createClaimedCrew("detected");
    const ended = await detected.crew.get(`${API_URL}/me`, { headers: crewHeaders() });
    expect(ended.status()).toBe(401);
    expect(await ended.json()).toMatchObject({ code: "crew_access_ended" });
    await expectRetired(detected);
    const expiryAudit = await database.query(
      "SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'crew_access.expired'",
      [detected.access.access.id]
    );
    expect(expiryAudit.rows).toHaveLength(1);

    const swept = await createClaimedCrew("leader-refresh");
    await json(await request.get(`${API_URL}/inventory/sessions`, { headers: adminHeaders() }));
    await expectRetired(swept);
  } finally {
    await database.end();
    for (const crew of crewClients) await crew.dispose();
    for (const sessionId of sessionIds) {
      await request.patch(`${API_URL}/inventory/sessions/${sessionId}`, {
        headers: adminHeaders(),
        data: { status: "closed" }
      });
    }
  }
});

test("leader revoke releases untouched claims but preserves submitted work", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Crew claim lifecycle coverage only needs one browser project.");
  const suffix = `release-revoke-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const submittedItem = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-SUBMITTED-${suffix}` }
  }));
  const untouchedItem = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-UNTOUCHED-${suffix}` }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Revoked ${suffix}` }
  }));
  const crew = await playwright.request.newContext();

  try {
    const consumed = await json(await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    }));
    for (const itemId of [submittedItem.sessionItem.id, untouchedItem.sessionItem.id]) {
      await json(await crew.patch(`${API_URL}/session-items/${itemId}/assignment`, {
        headers: crewHeaders({ mutate: true }),
        data: { memberId: "self" }
      }));
    }
    await json(await crew.post(`${API_URL}/session-items/${submittedItem.sessionItem.id}/submissions`, {
      headers: crewHeaders({ mutate: true }),
      data: { status: "not_found", locationText: "QA submitted location" }
    }));

    const revoked = await json(await request.post(
      `${API_URL}/inventory/sessions/${session.session.id}/crew-access/${access.access.id}/revoke`,
      { headers: adminHeaders() }
    ));
    expect(revoked.access).toMatchObject({ status: "revoked", revokeReason: "leader_revoked" });

    const detail = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders()
    }));
    const preserved = detail.items.find(item => item.id === submittedItem.sessionItem.id);
    const released = detail.items.find(item => item.id === untouchedItem.sessionItem.id);
    expect(preserved).toMatchObject({ status: "needs_review", assignedTo: consumed.user.id });
    expect(preserved.submissions).toHaveLength(1);
    expect(released).toMatchObject({ status: "unchecked", assignedTo: null });

    const ended = await crew.get(`${API_URL}/me`, { headers: crewHeaders() });
    expect(ended.status()).toBe(401);
    expect(await ended.json()).toMatchObject({ code: "crew_access_ended" });
  } finally {
    await crew.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("crew logout retires its pass and releases untouched claims", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Crew claim lifecycle coverage only needs one browser project.");
  const suffix = `release-logout-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const item = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-LOGOUT-${suffix}` }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Logout ${suffix}` }
  }));
  const crew = await playwright.request.newContext();

  try {
    await json(await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    }));
    await json(await crew.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
      headers: crewHeaders({ mutate: true }),
      data: { memberId: "self" }
    }));

    const activeBeforeLogout = await json(await request.get(
      `${API_URL}/inventory/sessions/${session.session.id}/crew-access`,
      { headers: adminHeaders() }
    ));
    for (let index = activeBeforeLogout.crew.length; index < activeBeforeLogout.limit; index += 1) {
      await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
        headers: adminHeaders(),
        data: { displayName: `Capacity ${index} ${suffix}` }
      }));
    }
    const atCapacity = await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
      headers: adminHeaders(),
      data: { displayName: `Capacity blocked ${suffix}` }
    });
    expect(atCapacity.status()).toBe(409);

    const logoutResponse = await crew.post(`${API_URL}/crew/logout`, {
      headers: crewHeaders({ mutate: true })
    });
    await json(logoutResponse);
    expect(logoutResponse.headers()["set-cookie"]).toContain("Max-Age=0");

    const ended = await crew.get(`${API_URL}/me`, { headers: crewHeaders() });
    expect(ended.status()).toBe(401);

    const detail = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders()
    }));
    expect(detail.items.find(entry => entry.id === item.sessionItem.id)).toMatchObject({
      status: "unchecked",
      assignedTo: null
    });
    const crewAccess = await json(await request.get(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
      headers: adminHeaders()
    }));
    expect(crewAccess.crew.find(entry => entry.id === access.access.id)).toMatchObject({
      status: "revoked",
      revokeReason: "crew_logout"
    });
    const replacement = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
      headers: adminHeaders(),
      data: { displayName: `Capacity replacement ${suffix}` }
    }));
    expect(replacement).toMatchObject({
      access: { status: "pending" }
    });
    expect(replacement.code).toMatch(/^\d{4}$/);
    expect(replacement.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  } finally {
    await crew.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("a locked tenant rate bucket does not create attacker-controlled fingerprint rows", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Database cardinality check only needs one browser project.");
  const slug = `rate-${testInfo.workerIndex}-${Date.now()}`;
  const origin = `https://${slug}.localhost`;
  const database = new Client({ connectionString: QA_DATABASE_URL });
  let tenantId = "";

  await database.connect();
  try {
    const tenant = await database.query(
      "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
      [slug, `Rate limit ${slug}`]
    );
    tenantId = tenant.rows[0].id;

    const seed = await request.post(`${API_URL}/crew/consume`, {
      headers: { "X-Tenant-Slug": slug, Origin: origin, "User-Agent": "crew-rate-seed" },
      data: { code: "9999", inviteToken: "A".repeat(43) }
    });
    expect(seed.status()).toBe(401);
    await database.query(
      "UPDATE session_crew_login_attempts SET locked_until = now() + interval '5 minutes' WHERE tenant_id = $1",
      [tenantId]
    );
    const before = await database.query(
      "SELECT count(*)::int AS count FROM session_crew_login_attempts WHERE tenant_id = $1",
      [tenantId]
    );
    expect(before.rows[0].count).toBe(2);

    for (let index = 0; index < 8; index += 1) {
      const response = await request.post(`${API_URL}/crew/consume`, {
        headers: { "X-Tenant-Slug": slug, Origin: origin, "User-Agent": `crew-rate-attacker-${index}` },
        data: { code: "9999", inviteToken: "A".repeat(43) }
      });
      expect(response.status()).toBe(429);
    }

    const after = await database.query(
      "SELECT count(*)::int AS count FROM session_crew_login_attempts WHERE tenant_id = $1",
      [tenantId]
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  } finally {
    if (tenantId) await database.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await database.end();
  }
});

test("revocation cannot complete in the middle of an authorized crew mutation", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The transaction interleaving only needs one browser project.");
  const suffix = `revoke-race-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const item = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-${suffix}` }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Blocked ${suffix}` }
  }));
  const crew = await playwright.request.newContext();
  const database = new Client({ connectionString: QA_DATABASE_URL });
  const advisoryKey = 870_000_000 + (Date.now() % 10_000_000);
  let advisoryLockOpen = false;

  await database.connect();
  try {
    await json(await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    }));
    await database.query(`
      CREATE TABLE IF NOT EXISTS qa_crew_assignment_pauses (
        session_item_id uuid PRIMARY KEY,
        lock_key bigint NOT NULL
      )
    `);
    await database.query(`
      CREATE OR REPLACE FUNCTION qa_pause_crew_assignment()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE pause_key bigint;
      BEGIN
        SELECT lock_key INTO pause_key
        FROM qa_crew_assignment_pauses
        WHERE session_item_id = NEW.id;
        IF pause_key IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(pause_key);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.query("DROP TRIGGER IF EXISTS qa_pause_crew_assignment_trigger ON inventory_session_items");
    await database.query(`
      CREATE TRIGGER qa_pause_crew_assignment_trigger
      BEFORE UPDATE OF assigned_to ON inventory_session_items
      FOR EACH ROW EXECUTE FUNCTION qa_pause_crew_assignment()
    `);
    await database.query(
      "INSERT INTO qa_crew_assignment_pauses (session_item_id, lock_key) VALUES ($1, $2)",
      [item.sessionItem.id, advisoryKey]
    );
    await database.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
    advisoryLockOpen = true;

    const assignmentPromise = crew.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
      headers: crewHeaders({ mutate: true }),
      data: { memberId: "self" },
      timeout: 10_000
    });
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await database.query(
        `
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%UPDATE inventory_session_items%'
          LIMIT 1
        `
      );
      if (activity.rows[0]) {
        blocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(blocked).toBeTruthy();

    let revokeResolved = false;
    const revokePromise = request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access/${access.access.id}/revoke`, {
      headers: adminHeaders()
    }).then(response => {
      revokeResolved = true;
      return response;
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(revokeResolved).toBeFalsy();

    await database.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
    advisoryLockOpen = false;

    const assignment = await assignmentPromise;
    expect(assignment.status()).toBe(200);
    await json(await revokePromise);
    const stored = await database.query(
      "SELECT assigned_to FROM inventory_session_items WHERE id = $1",
      [item.sessionItem.id]
    );
    expect(stored.rows[0].assigned_to).toBeNull();
    const ended = await crew.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
      headers: crewHeaders({ mutate: true }),
      data: { memberId: null }
    });
    expect(ended.status()).toBe(401);
    expect(await ended.json()).toMatchObject({ code: "crew_access_ended" });
  } finally {
    if (advisoryLockOpen) await database.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
    await database.query("DELETE FROM qa_crew_assignment_pauses WHERE session_item_id = $1", [item.sessionItem.id]).catch(() => {});
    await database.query("DROP TRIGGER IF EXISTS qa_pause_crew_assignment_trigger ON inventory_session_items").catch(() => {});
    await database.query("DROP FUNCTION IF EXISTS qa_pause_crew_assignment()").catch(() => {});
    await database.query("DROP TABLE IF EXISTS qa_crew_assignment_pauses").catch(() => {});
    await database.end();
    await crew.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});

test("crew staging quota is released by discard or attachment", async ({ request, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Upload quota check only needs one browser project.");
  const suffix = `quota-${testInfo.workerIndex}-${Date.now()}`;
  const session = await json(await request.post(`${API_URL}/inventory/sessions`, {
    headers: adminHeaders(),
    data: { name: `QA crew ${suffix}`, status: "active" }
  }));
  const item = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: adminHeaders(),
    data: { packetLine: `QA-CREW-${suffix}` }
  }));
  const access = await json(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/crew-access`, {
    headers: adminHeaders(),
    data: { displayName: `Quota ${suffix}` }
  }));
  const crew = await playwright.request.newContext();
  const database = new Client({ connectionString: QA_DATABASE_URL });

  await database.connect();
  try {
    await json(await crew.post(`${API_URL}/crew/consume`, {
      headers: crewHeaders({ mutate: true }),
      data: crewCredentials(access)
    }));
    await json(await crew.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
      headers: crewHeaders({ mutate: true }),
      data: { memberId: "self" }
    }));
    const uploads = [];
    for (let index = 0; index < 4; index += 1) {
      const upload = await json(await crew.post(`${API_URL}/uploads/photos`, {
        headers: crewHeaders({ mutate: true }),
        data: {
          fileName: `crew-quota-${index}.jpg`,
          mimeType: "image/jpeg",
          dataUrl: PHOTO_DATA_URL,
          kind: "general"
        }
      }));
      uploads.push(upload.photo);
    }
    const overQuota = await crew.post(`${API_URL}/uploads/photos`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        fileName: "crew-quota-rejected.jpg",
        mimeType: "image/jpeg",
        dataUrl: PHOTO_DATA_URL,
        kind: "general"
      }
    });
    expect(overQuota.status()).toBe(409);
    expect(await overQuota.json()).toMatchObject({ code: "crew_upload_quota" });

    const missingOriginDiscard = await crew.delete(`${API_URL}/uploads/photos/${uploads[3].uploadId}`, {
      headers: crewHeaders()
    });
    expect(missingOriginDiscard.status()).toBe(403);
    const foreignDiscard = await request.delete(`${API_URL}/uploads/photos/${uploads[3].uploadId}`, {
      headers: identityHeaders(qaContributor)
    });
    expect(foreignDiscard.status()).toBe(403);

    const discard = await json(await crew.delete(`${API_URL}/uploads/photos/${uploads[3].uploadId}`, {
      headers: crewHeaders({ mutate: true })
    }));
    expect(discard).toEqual({ discarded: true, uploadId: uploads[3].uploadId });
    const discardedRow = await database.query("SELECT id FROM media_uploads WHERE id = $1", [uploads[3].uploadId]);
    expect(discardedRow.rows).toHaveLength(0);
    const discardAudit = await database.query(
      "SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'media_upload.discarded'",
      [uploads[3].uploadId]
    );
    expect(discardAudit.rows).toHaveLength(1);
    const replacement = await json(await crew.post(`${API_URL}/uploads/photos`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        fileName: "crew-quota-replacement.jpg",
        mimeType: "image/jpeg",
        dataUrl: PHOTO_DATA_URL,
        kind: "general"
      }
    }));
    expect(replacement.photo.uploadId).toBeTruthy();

    await json(await crew.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        status: "found",
        photos: uploads.slice(0, 3).map(photo => ({ uploadId: photo.uploadId, kind: "general" }))
      }
    }));
    const attachedDiscard = await crew.delete(`${API_URL}/uploads/photos/${uploads[0].uploadId}`, {
      headers: crewHeaders({ mutate: true })
    });
    expect(attachedDiscard.status()).toBe(409);
    const released = await crew.post(`${API_URL}/uploads/photos`, {
      headers: crewHeaders({ mutate: true }),
      data: {
        fileName: "crew-quota-released.jpg",
        mimeType: "image/jpeg",
        dataUrl: PHOTO_DATA_URL,
        kind: "general"
      }
    });
    expect(released.status()).toBe(201);
  } finally {
    await database.end();
    await crew.dispose();
    await request.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
      headers: adminHeaders(),
      data: { status: "closed" }
    });
  }
});
