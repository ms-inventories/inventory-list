import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PHOTO_DATA_URL = `data:image/jpeg;base64,${fs.readFileSync(path.resolve("assets/dagr.jpg")).toString("base64")}`;

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

const qaScout = {
  sub: "qa-scout",
  email: "qa-scout@876en.test",
  name: "QA Scout",
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
    ...(tenantSlug ? { "X-Tenant-Slug": tenantSlug } : {})
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function expectFailure(response, status, code) {
  expect(response.status()).toBe(status);
  const body = await response.json();
  expect(body.code).toBe(code);
  expect(body.requestId).toBeTruthy();
  return body;
}

async function uploadPhoto(request, identity, suffix, purpose = "evidence") {
  const response = await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(identity),
    data: {
      fileName: `${suffix}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: PHOTO_DATA_URL,
      caption: suffix,
      kind: "general",
      purpose
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body.photo.uploadId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.photo.storageKey).toBeUndefined();
  expect(body.photo.purpose).toBe(purpose);
  expect(body.photo.expiresAt).toBeTruthy();
  return body.photo;
}

async function submitPhoto(request, identity, sessionItemId, uploadId, tenantSlug = "ms") {
  return request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: {
      status: "found",
      note: "Upload integrity QA",
      photos: [{ uploadId, caption: "Integrity proof", kind: "general" }]
    }
  });
}

async function createSessionItems(request, identity, suffix, count, tenantSlug = "ms") {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { name: `QA upload integrity ${suffix}`, status: "active" }
  }));
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
      headers: qaHeaders(identity, tenantSlug),
      data: { packetLine: `QA-UPLOAD-${suffix.toUpperCase()}-${index + 1}` }
    }));
    items.push(item.sessionItem);
  }
  return { session: session.session, items };
}

test.describe("upload attachment integrity", () => {
  test("binds opaque uploads once and rejects copied, foreign, mismatched, and concurrent reuse", async ({ request, playwright }, testInfo) => {
    test.setTimeout(90_000);
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const { items } = await createSessionItems(request, qaAdmin, suffix, 8);

    const ownerUpload = await uploadPhoto(request, qaNco, `owner-${suffix}`);
    const copiedByScout = await submitPhoto(request, qaScout, items[0].id, ownerUpload.uploadId);
    await expectFailure(copiedByScout, 403, "access_denied");
    expect((await submitPhoto(request, qaNco, items[0].id, ownerUpload.uploadId)).status()).toBe(201);

    await expectFailure(
      await submitPhoto(request, qaNco, items[1].id, ownerUpload.uploadId),
      409,
      "conflict"
    );
    await expectFailure(
      await submitPhoto(request, qaAdmin, items[1].id, ownerUpload.uploadId),
      409,
      "conflict"
    );
    await expectFailure(
      await submitPhoto(request, qaNco, items[1].id, "00000000-0000-4000-8000-000000000000"),
      400,
      "invalid_request"
    );
    await expectFailure(
      await request.post(`${API_URL}/session-items/${items[1].id}/submissions`, {
        headers: qaHeaders(qaNco),
        data: {
          status: "found",
          photos: [{ storageKey: new URL(ownerUpload.url, API_URL).pathname.replace(/^\/media\//, "") }]
        }
      }),
      400,
      "validation_failed"
    );

    const duplicateUpload = await uploadPhoto(request, qaNco, `duplicate-${suffix}`);
    await expectFailure(
      await request.post(`${API_URL}/session-items/${items[1].id}/submissions`, {
        headers: qaHeaders(qaNco),
        data: {
          status: "found",
          photos: [
            { uploadId: duplicateUpload.uploadId },
            { uploadId: duplicateUpload.uploadId }
          ]
        }
      }),
      400,
      "invalid_request"
    );
    expect((await submitPhoto(request, qaNco, items[1].id, duplicateUpload.uploadId)).status()).toBe(201);

    const referenceUpload = await uploadPhoto(request, qaAdmin, `reference-${suffix}`, "inventory_reference");
    await expectFailure(
      await submitPhoto(request, qaAdmin, items[2].id, referenceUpload.uploadId),
      400,
      "invalid_request"
    );
    const referenceItem = await responseJson(await request.post(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaAdmin),
      data: {
        title: `Integrity reference ${suffix}`,
        metadata: { imageUrl: referenceUpload.url },
        mediaUploadIds: [referenceUpload.uploadId]
      }
    }));
    expect(referenceItem.item.id).toBeTruthy();
    expect((await request.get(new URL(referenceUpload.url, API_URL).toString())).status()).toBe(200);

    const anonymous = await playwright.request.newContext();
    try {
      expect((await anonymous.get(new URL(referenceUpload.url, API_URL).toString())).status()).toBe(403);
    } finally {
      await anonymous.dispose();
    }

    await expectFailure(
      await request.post(`${API_URL}/inventory/items`, {
        headers: qaHeaders(qaAdmin),
        data: {
          title: `Forged metadata ${suffix}`,
          metadata: { imageUrl: ownerUpload.url }
        }
      }),
      400,
      "invalid_request"
    );
    await expectFailure(
      await request.post(`${API_URL}/inventory/items`, {
        headers: qaHeaders(qaAdmin),
        data: {
          title: `Reused reference ${suffix}`,
          metadata: { imageUrl: referenceUpload.url },
          mediaUploadIds: [referenceUpload.uploadId]
        }
      }),
      409,
      "conflict"
    );

    const evidenceForPurposeCheck = await uploadPhoto(request, qaNco, `purpose-${suffix}`);
    await expectFailure(
      await request.post(`${API_URL}/inventory/items`, {
        headers: qaHeaders(qaAdmin),
        data: {
          title: `Wrong purpose ${suffix}`,
          metadata: { imageUrl: evidenceForPurposeCheck.url },
          mediaUploadIds: [evidenceForPurposeCheck.uploadId]
        }
      }),
      400,
      "invalid_request"
    );
    expect((await submitPhoto(request, qaNco, items[2].id, evidenceForPurposeCheck.uploadId)).status()).toBe(201);

    const concurrentUpload = await uploadPhoto(request, qaNco, `concurrent-${suffix}`);
    const concurrentResponses = await Promise.all([
      submitPhoto(request, qaNco, items[3].id, concurrentUpload.uploadId),
      submitPhoto(request, qaNco, items[4].id, concurrentUpload.uploadId)
    ]);
    expect(concurrentResponses.map(response => response.status()).sort()).toEqual([201, 409]);

    const adminOverrideUpload = await uploadPhoto(request, qaScout, `override-${suffix}`);
    expect((await submitPhoto(request, qaAdmin, items[5].id, adminOverrideUpload.uploadId)).status()).toBe(201);

    const crossTenantUpload = await uploadPhoto(request, qaNco, `cross-tenant-${suffix}`);
    const otherSlug = "qa-other";
    const other = await createSessionItems(request, qaRoot, suffix, 1, otherSlug);
    await expectFailure(
      await submitPhoto(request, qaRoot, other.items[0].id, crossTenantUpload.uploadId, otherSlug),
      400,
      "invalid_request"
    );
    expect((await submitPhoto(request, qaNco, items[6].id, crossTenantUpload.uploadId)).status()).toBe(201);
  });
});
