import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const QA_DATABASE_URL = process.env.QA_DATABASE_URL || "postgres://inventory:inventory@localhost:55432/inventory_qa";
const PHOTO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

const qaNco = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function qaHeaders(identity, tenantSlug = "ms") {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": tenantSlug
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

function auditUrl(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const query = search.toString();
  return `${API_URL}/tenant/audit-events${query ? `?${query}` : ""}`;
}

async function createSession(request, name, identity = qaAdmin, tenantSlug = "ms") {
  return (await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { name, status: "active" }
  }))).session;
}

async function uploadPhoto(request, label, identity = qaNco) {
  return (await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(identity),
    data: {
      fileName: `${label}.png`,
      mimeType: "image/png",
      dataUrl: PHOTO_DATA_URL,
      caption: label,
      kind: "general",
      purpose: "evidence"
    }
  }))).photo;
}

test.describe("tenant audit log API", () => {
  test("returns a safe, filterable, cursor-paginated tenant activity feed", async ({ request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const originalSessionName = `QA audit ${suffix}`;
    const renamedSessionName = `QA audit renamed ${suffix}`;
    const session = await createSession(request, originalSessionName);
    await createSession(request, `QA audit page A ${suffix}`);
    await createSession(request, `QA audit page B ${suffix}`);
    const packetLine = `AUDIT-PACKET-${suffix}`;
    const sourceName = `audit-source-${suffix}.txt`;

    const bulk = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.id}/items/bulk`, {
      headers: qaHeaders(qaAdmin),
      data: {
        items: [{ packetLine, expectedQty: 1, locationHint: `Audit shelf ${suffix}` }],
        importBatch: {
          sourceName,
          sourceMimeType: "text/plain",
          extractedText: packetLine
        }
      }
    }));
    const sessionItemId = bulk.sessionItems[0].id;
    const manualPacketLine = `AUDIT-MANUAL-${suffix}`;
    const manualLocationHint = `Manual shelf ${suffix}`;
    const manualItem = (await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.id}/items`, {
      headers: qaHeaders(qaAdmin),
      data: {
        packetLine: manualPacketLine,
        expectedQty: 2,
        locationHint: manualLocationHint
      }
    }))).sessionItem;
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${session.id}`, {
      headers: qaHeaders(qaAdmin),
      data: { name: renamedSessionName }
    }));

    const members = await responseJson(await request.get(`${API_URL}/tenant/members`, {
      headers: qaHeaders(qaAdmin)
    }));
    const ncoMember = members.members.find(member => member.email === qaNco.email);
    expect(ncoMember?.id).toBeTruthy();

    await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
      headers: qaHeaders(qaAdmin),
      data: { memberId: ncoMember.id }
    }));
    const proofPhoto = await uploadPhoto(request, `audit-proof-${suffix}`);
    const submission = (await responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
      headers: qaHeaders(qaNco),
      data: {
        status: "found",
        locationText: `Audit location ${suffix}`,
        serialNumber: `AUDIT-${suffix}`,
        note: `Audit proof ${suffix}`,
        photos: [{ uploadId: proofPhoto.uploadId, kind: "general" }]
      }
    }))).submission;
    await responseJson(await request.patch(`${API_URL}/submissions/${submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved", note: `Approved ${suffix}` }
    }));
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${session.id}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));

    const invitationEmail = `audit-${suffix}@example.com`.toLowerCase();
    await responseJson(await request.post(`${API_URL}/tenant/invitations`, {
      headers: qaHeaders(qaAdmin),
      data: { email: invitationEmail, displayName: `Audit Invite ${suffix}`, role: "viewer" }
    }));

    const response = await request.get(auditUrl({ limit: 100, from: startedAt }), {
      headers: qaHeaders(qaAdmin)
    });
    expect(response.headers()["cache-control"]).toContain("no-store");
    const feed = await responseJson(response);
    expect(feed.events.length).toBeGreaterThanOrEqual(8);
    expect(feed.filterOptions.categories.map(option => option.value)).toEqual([
      "workflow",
      "access",
      "workspace",
      "files",
      "other"
    ]);
    expect(feed.filterOptions.actions).toContain("submission.reviewed");
    expect(feed.filterOptions.entityTypes).toContain("inventory_session");
    expect(feed.filterOptions.actors.some(actor => actor.email === qaAdmin.email)).toBeTruthy();

    const sessionCreated = feed.events.find(event => event.action === "inventory_session.created" && event.entity.id === session.id);
    expect(sessionCreated?.actor.email).toBe(qaAdmin.email);
    expect(sessionCreated?.details).toEqual({ sessionName: originalSessionName, status: "active" });
    expect(sessionCreated?.context).toMatchObject({ sessionId: session.id, sessionName: originalSessionName });

    const imported = feed.events.find(event => event.action === "session_items.bulk_created" && event.entity.id === session.id);
    expect(imported?.details).toEqual({ sessionName: originalSessionName, count: 1, matchedCount: 0, sourceName });
    expect(imported?.details).not.toHaveProperty("importBatchId");
    expect(imported?.context).toMatchObject({ sessionId: session.id, sessionName: originalSessionName });

    const manuallyCreated = feed.events.find(event => event.action === "session_item.created" && event.entity.id === manualItem.id);
    expect(manuallyCreated?.details).toEqual({
      sessionName: originalSessionName,
      packetLine: manualPacketLine,
      expectedQty: 2,
      locationHint: manualLocationHint
    });
    expect(manuallyCreated?.context).toMatchObject({
      sessionId: session.id,
      sessionName: originalSessionName,
      sessionItemId: manualItem.id,
      packetLine: manualPacketLine
    });

    const assigned = feed.events.find(event => event.action === "session_item.assigned" && event.entity.id === sessionItemId);
    expect(assigned?.details).toEqual({ assignedToEmail: qaNco.email, assignedToRole: "contributor" });
    expect(assigned?.details).not.toHaveProperty("assignedTo");
    expect(assigned?.context).toMatchObject({ sessionId: session.id, sessionItemId, packetLine });

    const submitted = feed.events.find(event => event.action === "submission.created" && event.entity.id === submission.id);
    expect(submitted?.actor.email).toBe(qaNco.email);
    expect(submitted?.details).toEqual({ status: "found", photoCount: 1 });
    expect(submitted?.details).not.toHaveProperty("mediaUploadIds");
    expect(submitted?.context).toMatchObject({ sessionId: session.id, sessionItemId, packetLine });

    const reviewed = feed.events.find(event => event.action === "submission.reviewed" && event.entity.id === submission.id);
    expect(reviewed?.details).toEqual({ decision: "approved", note: `Approved ${suffix}` });
    expect(reviewed?.category).toBe("workflow");
    expect(reviewed).not.toHaveProperty("metadata");

    const renamed = feed.events.find(event => (
      event.action === "inventory_session.updated"
      && event.entity.id === session.id
      && !event.details.status
    ));
    expect(renamed?.details).toEqual({ sessionName: renamedSessionName });
    expect(renamed?.context).toMatchObject({ sessionId: session.id, sessionName: renamedSessionName });

    const closed = feed.events.find(event => (
      event.action === "inventory_session.updated"
      && event.entity.id === session.id
      && event.details.status === "closed"
    ));
    expect(closed?.details).toEqual({ sessionName: renamedSessionName, status: "closed" });

    const access = await responseJson(await request.get(auditUrl({
      category: "access",
      from: startedAt
    }), { headers: qaHeaders(qaAdmin) }));
    const invitation = access.events.find(event => event.action === "invitation.created" && event.details.email === invitationEmail);
    expect(invitation?.details).toEqual({ email: invitationEmail, role: "viewer", deliveryRequested: true });

    const ncoEvents = await responseJson(await request.get(auditUrl({
      actor: ncoMember.userId,
      action: "submission.created",
      from: startedAt
    }), { headers: qaHeaders(qaAdmin) }));
    expect(ncoEvents.events.some(event => event.entity.id === submission.id)).toBeTruthy();
    expect(ncoEvents.events.every(event => event.actor?.id === ncoMember.userId)).toBeTruthy();

    const entityEvents = await responseJson(await request.get(auditUrl({
      entityType: "inventory_session",
      entityId: session.id,
      from: startedAt
    }), { headers: qaHeaders(qaAdmin) }));
    expect(entityEvents.events.some(event => event.action === "inventory_session.created")).toBeTruthy();
    expect(entityEvents.events.some(event => event.action === "session_items.bulk_created")).toBeTruthy();
    expect(entityEvents.events.some(event => event.action === "inventory_session.updated")).toBeTruthy();
    expect(entityEvents.events.every(event => event.entity.type === "inventory_session" && event.entity.id === session.id)).toBeTruthy();

    const firstPage = await responseJson(await request.get(auditUrl({
      limit: 2,
      actor: sessionCreated.actor.id,
      action: "inventory_session.created"
    }), { headers: qaHeaders(qaAdmin) }));
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await responseJson(await request.get(auditUrl({
      limit: 2,
      actor: sessionCreated.actor.id,
      action: "inventory_session.created",
      cursor: firstPage.nextCursor
    }), { headers: qaHeaders(qaAdmin) }));
    const firstIds = new Set(firstPage.events.map(event => event.id));
    expect(secondPage.events.every(event => !firstIds.has(event.id))).toBeTruthy();
    expect(new Date(secondPage.events[0].createdAt).getTime()).toBeLessThanOrEqual(
      new Date(firstPage.events[firstPage.events.length - 1].createdAt).getTime()
    );
  });

  test("denies contributors, rejects invalid filters, and isolates tenant/global activity", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const foreignSession = await createSession(request, `Foreign audit ${suffix}`, qaRoot, "qa-other");

    expect((await request.get(auditUrl(), { headers: qaHeaders(qaNco) })).status()).toBe(403);

    const msFeed = await responseJson(await request.get(auditUrl({
      entityType: "inventory_session",
      entityId: foreignSession.id
    }), { headers: qaHeaders(qaAdmin) }));
    expect(msFeed.events).toHaveLength(0);

    const foreignFeed = await responseJson(await request.get(auditUrl({
      entityType: "inventory_session",
      entityId: foreignSession.id
    }), { headers: qaHeaders(qaRoot, "qa-other") }));
    expect(foreignFeed.events.some(event => event.action === "inventory_session.created")).toBeTruthy();
    expect(foreignFeed.events[0].context.sessionId).toBe(foreignSession.id);

    const globalOnly = await responseJson(await request.get(auditUrl({
      action: "newsletter.issue.test_sent"
    }), { headers: qaHeaders(qaAdmin) }));
    expect(globalOnly.events).toHaveLength(0);

    const invalidQueries = [
      { limit: 101 },
      { cursor: "not-a-cursor" },
      { actor: "not-a-user" },
      { action: "invalid action" },
      { entityType: "bad/type" },
      { category: "secrets" },
      { from: "2026-07-11T10:00:00.000Z", to: "2026-07-10T10:00:00.000Z" },
      { unexpected: "value" }
    ];
    for (const params of invalidQueries) {
      const response = await request.get(auditUrl(params), { headers: qaHeaders(qaAdmin) });
      expect(response.status(), JSON.stringify(params)).toBe(400);
      expect((await response.json()).code).toBe("validation_failed");
    }
  });

  test("matches category prefixes literally instead of treating underscores as wildcards", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${Date.now()}`;
    const action = `memberx.fixture_${suffix}`;
    const database = new Client({ connectionString: QA_DATABASE_URL });
    let fixtureId = "";

    await database.connect();
    try {
      const inserted = await database.query(
        `
          INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
          SELECT tenant.id, NULL, $2, 'fixture', NULL, $3::jsonb
          FROM tenants tenant
          WHERE tenant.slug = $1
          RETURNING id
        `,
        ["ms", action, JSON.stringify({ storageKey: "must-not-be-returned" })]
      );
      fixtureId = inserted.rows[0]?.id || "";
      expect(fixtureId).toBeTruthy();

      const otherFeed = await responseJson(await request.get(auditUrl({
        category: "other",
        action
      }), { headers: qaHeaders(qaAdmin) }));
      const fixture = otherFeed.events.find(event => event.id === fixtureId);
      expect(fixture).toMatchObject({
        action,
        category: "other",
        actor: null,
        details: {}
      });
      expect(fixture).not.toHaveProperty("metadata");

      const accessFeed = await responseJson(await request.get(auditUrl({
        category: "access",
        action
      }), { headers: qaHeaders(qaAdmin) }));
      expect(accessFeed.events.some(event => event.id === fixtureId)).toBeFalsy();
    } finally {
      if (fixtureId) await database.query("DELETE FROM audit_events WHERE id = $1", [fixtureId]);
      await database.end();
    }
  });
});
