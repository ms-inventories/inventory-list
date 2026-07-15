import { expect, test } from "@playwright/test";
import { Client } from "pg";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const QA_DATABASE_URL = process.env.QA_DATABASE_URL || "postgres://inventory:inventory@localhost:55432/inventory_qa";
const PHOTO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function rootHeaders(tenantSlug = "") {
  return {
    "X-Dev-Sub": qaRoot.sub,
    "X-Dev-Email": qaRoot.email,
    "X-Dev-Name": qaRoot.name,
    "X-Dev-Groups": qaRoot.groups.join(","),
    ...(tenantSlug ? { "X-Tenant-Slug": tenantSlug } : {})
  };
}

async function responseJson(response) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

test("platform reset removes a confirmed workspace, its records, and staged media", async ({ request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const slug = `reset-${suffix}`.slice(0, 63).replace(/-+$/, "");
  const created = await responseJson(await request.post(`${API_URL}/platform/tenants`, {
    headers: rootHeaders(),
    data: { name: `Reset ${suffix}`, slug }
  }));
  const tenantId = created.tenant.id;

  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: rootHeaders(slug),
    data: { name: `Reset session ${suffix}`, status: "active" }
  }));
  const photo = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: rootHeaders(slug),
    data: {
      fileName: `reset-${suffix}.png`,
      mimeType: "image/png",
      dataUrl: PHOTO_DATA_URL,
      purpose: "evidence"
    }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: rootHeaders(slug),
    data: { packetLine: `RESET-ITEM-${suffix}` }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
    headers: rootHeaders(slug),
    data: { memberId: "self" }
  }));
  const submission = await responseJson(await request.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
    headers: rootHeaders(slug),
    data: {
      status: "found",
      locationText: "Reset test shelf",
      photos: [{ uploadId: photo.photo.uploadId, kind: "general" }]
    }
  }));

  const refused = await request.delete(`${API_URL}/platform/tenants/${tenantId}`, {
    headers: rootHeaders(),
    data: { confirmSlug: `${slug}-wrong` }
  });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "tenant_reset_confirmation_failed" });

  const reset = await responseJson(await request.delete(`${API_URL}/platform/tenants/${tenantId}`, {
    headers: rootHeaders(),
    data: { confirmSlug: slug }
  }));
  expect(reset.reset).toMatchObject({
    tenant: { id: tenantId, slug },
    removed: { sessions: 1, media_uploads: 1 },
    storageCleanup: "complete"
  });

  const listed = await responseJson(await request.get(`${API_URL}/platform/tenants`, {
    headers: rootHeaders()
  }));
  expect(listed.tenants.some(tenant => tenant.id === tenantId || tenant.slug === slug)).toBe(false);

  const database = new Client({ connectionString: QA_DATABASE_URL });
  await database.connect();
  try {
    expect((await database.query("SELECT id FROM tenants WHERE id = $1", [tenantId])).rowCount).toBe(0);
    expect((await database.query("SELECT id FROM inventory_sessions WHERE id = $1", [session.session.id])).rowCount).toBe(0);
    expect((await database.query("SELECT id FROM media_uploads WHERE id = $1", [photo.photo.uploadId])).rowCount).toBe(0);
    expect((await database.query("SELECT id FROM item_submissions WHERE id = $1", [submission.submission.id])).rowCount).toBe(0);
  } finally {
    await database.end();
  }
});
