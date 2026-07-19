import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const TENANT_ORIGIN = process.env.QA_TENANT_ORIGIN || "http://ms.localhost:5175";
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

function qaHeaders(identity) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": "ms"
  };
}

function mixedPositionLin(value, first = "7", last = "N") {
  let hash = 0;
  for (const character of String(value)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return `${first}${hash.toString(36).toUpperCase().padStart(4, "0").slice(-4)}${last}`;
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function expectMediaDenied(response) {
  expect(response.status()).toBe(403);
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  const body = await response.json();
  expect(body.error).toBe("Media access denied.");
  expect(body.code).toBe("access_denied");
  expect(body.requestId).toBeTruthy();
  expect(response.headers()["x-request-id"]).toBe(body.requestId);
}

function assertProtectedMediaUrl(value) {
  const url = new URL(value, API_URL);
  expect(url.pathname).toMatch(/^\/media\/tenants\/ms\//);
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
  return url;
}

test.describe("tenant media access", () => {
  test("crew media sessions allow matching approved history and deny unrelated prior photos", async ({ playwright }, testInfo) => {
    const admin = await playwright.request.newContext();
    const contributor = await playwright.request.newContext();
    const crew = await playwright.request.newContext();

    try {
      const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
      const matchingLin = mixedPositionLin(suffix);
      const unrelatedLin = mixedPositionLin(suffix, "8", "P");
      const source = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA crew prior media source ${suffix}`, status: "active" }
      }));
      const priorPhotos = new Map();

      for (const [lin, label] of [[matchingLin, "matching"], [unrelatedLin, "unrelated"]]) {
        const item = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${source.session.id}/items`, {
          headers: qaHeaders(qaAdmin),
          data: { packetLine: `000000001 ${lin} PRIOR MEDIA ${label.toUpperCase()}`, expectedQty: 4 }
        }));
        await responseJson(await contributor.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
          headers: qaHeaders(qaNco),
          data: { memberId: "self" }
        }));
        const upload = await responseJson(await contributor.post(`${API_URL}/uploads/photos`, {
          headers: qaHeaders(qaNco),
          data: {
            fileName: `crew-prior-${label}-${suffix}.jpg`,
            mimeType: "image/jpeg",
            dataUrl: PHOTO_DATA_URL,
            caption: `Crew prior ${label}`,
            kind: "general"
          }
        }));
        const submission = await responseJson(await contributor.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
          headers: qaHeaders(qaNco),
          data: {
            status: "found",
            locationText: `${label} history shelf`,
            photos: [{
              uploadId: upload.photo.uploadId,
              caption: upload.photo.caption,
              kind: upload.photo.kind
            }]
          }
        }));
        await responseJson(await admin.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
          headers: qaHeaders(qaAdmin),
          data: { decision: "approved", saveItem: false }
        }));
        priorPhotos.set(label, upload.photo);
      }
      const invalidItem = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${source.session.id}/items`, {
        headers: qaHeaders(qaAdmin),
        data: { packetLine: `000000002 ${matchingLin} PRIOR MEDIA NOT FOUND`, expectedQty: 4 }
      }));
      await responseJson(await contributor.patch(`${API_URL}/session-items/${invalidItem.sessionItem.id}/assignment`, {
        headers: qaHeaders(qaNco),
        data: { memberId: "self" }
      }));
      const invalidUpload = await responseJson(await contributor.post(`${API_URL}/uploads/photos`, {
        headers: qaHeaders(qaNco),
        data: {
          fileName: `crew-prior-not-found-${suffix}.jpg`,
          mimeType: "image/jpeg",
          dataUrl: PHOTO_DATA_URL,
          caption: "Crew prior not found",
          kind: "general"
        }
      }));
      const invalidSubmission = await responseJson(await contributor.post(
        `${API_URL}/session-items/${invalidItem.sessionItem.id}/submissions`,
        {
          headers: qaHeaders(qaNco),
          data: {
            status: "not_found",
            note: "This approved outcome must not become a reference photo.",
            photos: [{
              uploadId: invalidUpload.photo.uploadId,
              caption: invalidUpload.photo.caption,
              kind: invalidUpload.photo.kind
            }]
          }
        }
      ));
      await responseJson(await admin.patch(`${API_URL}/submissions/${invalidSubmission.submission.id}/review`, {
        headers: qaHeaders(qaAdmin),
        data: { decision: "approved", saveItem: false }
      }));
      await responseJson(await admin.patch(`${API_URL}/inventory/sessions/${source.session.id}`, {
        headers: qaHeaders(qaAdmin),
        data: { status: "closed" }
      }));

      const active = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA crew prior media active ${suffix}`, status: "active" }
      }));
      const activeItem = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${active.session.id}/items`, {
        headers: qaHeaders(qaAdmin),
        data: { packetLine: `000000099 ${matchingLin} PRIOR MEDIA MATCHING`, expectedQty: 6 }
      }));
      const access = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${active.session.id}/crew-access`, {
        headers: qaHeaders(qaAdmin),
        data: { displayName: `Prior media crew ${suffix}` }
      }));
      await responseJson(await crew.post(`${API_URL}/crew/consume`, {
        headers: { "X-Tenant-Slug": "ms", Origin: TENANT_ORIGIN },
        data: { code: access.code, inviteToken: access.inviteToken }
      }));

      const detailResponse = await crew.get(`${API_URL}/inventory/sessions/${active.session.id}`, {
        headers: { "X-Tenant-Slug": "ms" }
      });
      const detail = await responseJson(detailResponse);
      const row = detail.items.find(item => item.id === activeItem.sessionItem.id);
      expect(row.priorInventoryHistory).toMatchObject({
        sessionName: `QA crew prior media source ${suffix}`,
        historyCount: 2,
        lastFound: { locationText: "matching history shelf" },
        photoContext: { locationText: "matching history shelf" }
      });
      expect(row.priorInventoryHistory.photos[0].url).toBe(priorPhotos.get("matching").url);
      expect(detailResponse.headers()["set-cookie"]).toContain("inventory_media_ms=");

      const matchingPhotoUrl = assertProtectedMediaUrl(priorPhotos.get("matching").url);
      const matchingResponse = await crew.get(matchingPhotoUrl.toString());
      expect(matchingResponse.status()).toBe(200);
      expect(matchingResponse.headers()["content-type"]).toMatch(/^image\/jpeg/);
      expect((await matchingResponse.body()).length).toBeGreaterThan(1000);

      const unrelatedPhotoUrl = assertProtectedMediaUrl(priorPhotos.get("unrelated").url);
      await expectMediaDenied(await crew.get(unrelatedPhotoUrl.toString()));
      const invalidPhotoUrl = assertProtectedMediaUrl(invalidUpload.photo.url);
      await expectMediaDenied(await crew.get(invalidPhotoUrl.toString()));
    } finally {
      await Promise.all([admin.dispose(), contributor.dispose(), crew.dispose()]);
    }
  });

  test("remembered equipment links authorize only their protected history photos while the source inventory is active", async ({ playwright }, testInfo) => {
    const admin = await playwright.request.newContext();
    const contributor = await playwright.request.newContext();
    const crew = await playwright.request.newContext();

    try {
      const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
      const matchingLin = mixedPositionLin(`alias-${suffix}`);
      const unrelatedLin = mixedPositionLin(`unrelated-alias-${suffix}`, "8", "P");
      const historySession = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA remembered media history ${suffix}`, status: "active" }
      }));
      const historyPhotos = new Map();

      for (const [lin, label] of [[matchingLin, "matching"], [unrelatedLin, "unrelated"]]) {
        const item = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${historySession.session.id}/items`, {
          headers: qaHeaders(qaAdmin),
          data: { packetLine: `000000001 ${lin} REMEMBERED MEDIA ${label.toUpperCase()}`, expectedQty: 1 }
        }));
        await responseJson(await contributor.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
          headers: qaHeaders(qaNco),
          data: { memberId: "self" }
        }));
        const upload = await responseJson(await contributor.post(`${API_URL}/uploads/photos`, {
          headers: qaHeaders(qaNco),
          data: {
            fileName: `remembered-media-${label}-${suffix}.jpg`,
            mimeType: "image/jpeg",
            dataUrl: PHOTO_DATA_URL,
            caption: `Remembered media ${label}`,
            kind: "general"
          }
        }));
        const submission = await responseJson(await contributor.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
          headers: qaHeaders(qaNco),
          data: {
            status: "found",
            locationText: `${label} remembered shelf`,
            photos: [{
              uploadId: upload.photo.uploadId,
              caption: upload.photo.caption,
              kind: upload.photo.kind
            }]
          }
        }));
        await responseJson(await admin.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
          headers: qaHeaders(qaAdmin),
          data: {
            decision: "approved",
            saveItem: true,
            savedMediaUploadIds: [upload.photo.uploadId]
          }
        }));
        historyPhotos.set(label, upload.photo);
      }

      for (const status of ["not_found", "mismatch"]) {
        const item = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${historySession.session.id}/items`, {
          headers: qaHeaders(qaAdmin),
          data: { packetLine: `000000002 ${matchingLin} REMEMBERED MEDIA ${status.toUpperCase()}`, expectedQty: 1 }
        }));
        await responseJson(await admin.patch(`${API_URL}/session-items/${item.sessionItem.id}/inventory-match`, {
          headers: qaHeaders(qaAdmin),
          data: { action: "dismiss" }
        }));
        await responseJson(await contributor.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
          headers: qaHeaders(qaNco),
          data: { memberId: "self" }
        }));
        const upload = await responseJson(await contributor.post(`${API_URL}/uploads/photos`, {
          headers: qaHeaders(qaNco),
          data: {
            fileName: `remembered-media-${status}-${suffix}.jpg`,
            mimeType: "image/jpeg",
            dataUrl: PHOTO_DATA_URL,
            caption: `Remembered media ${status}`,
            kind: "general"
          }
        }));
        const submission = await responseJson(await contributor.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
          headers: qaHeaders(qaNco),
          data: {
            status,
            note: `Approved ${status} evidence must not become reusable equipment history.`,
            photos: [{
              uploadId: upload.photo.uploadId,
              caption: upload.photo.caption,
              kind: upload.photo.kind
            }]
          }
        }));
        await responseJson(await admin.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
          headers: qaHeaders(qaAdmin),
          data: { decision: "approved", saveItem: false }
        }));
        historyPhotos.set(status, upload.photo);
      }
      await responseJson(await admin.patch(`${API_URL}/inventory/sessions/${historySession.session.id}`, {
        headers: qaHeaders(qaAdmin),
        data: { status: "closed" }
      }));

      const active = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA remembered media active ${suffix}`, status: "active" }
      }));
      const sourceWording = `UNMATCHED REMEMBERED MEDIA WORDING ${suffix.toUpperCase()}`;
      const activeItem = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${active.session.id}/items`, {
        headers: qaHeaders(qaAdmin),
        data: { packetLine: sourceWording, expectedQty: 1 }
      }));
      const matchingPhotoUrl = assertProtectedMediaUrl(historyPhotos.get("matching").url);
      const unrelatedPhotoUrl = assertProtectedMediaUrl(historyPhotos.get("unrelated").url);

      const invalidOutcomePhotoUrls = ["not_found", "mismatch"].map(status => (
        assertProtectedMediaUrl(historyPhotos.get(status).url)
      ));

      await expectMediaDenied(await contributor.get(matchingPhotoUrl.toString()));
      await expectMediaDenied(await contributor.get(unrelatedPhotoUrl.toString()));

      const library = await responseJson(await admin.get(`${API_URL}/inventory/equipment-library`, {
        headers: qaHeaders(qaAdmin)
      }));
      const target = library.entries.find(entry => entry.lins.includes(matchingLin));
      expect(target).toBeTruthy();
      const remembered = await responseJson(await admin.post(`${API_URL}/inventory/equipment-library/links`, {
        headers: qaHeaders(qaAdmin),
        data: {
          sourceSessionItemId: activeItem.sessionItem.id,
          targetEntryKey: target.key
        }
      }));

      const contributorPhoto = await contributor.get(matchingPhotoUrl.toString());
      expect(contributorPhoto.status()).toBe(200);
      expect(contributorPhoto.headers()["content-type"]).toMatch(/^image\/jpeg/);
      await expectMediaDenied(await contributor.get(unrelatedPhotoUrl.toString()));

      const access = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${active.session.id}/crew-access`, {
        headers: qaHeaders(qaAdmin),
        data: { displayName: `Remembered media crew ${suffix}` }
      }));
      await responseJson(await crew.post(`${API_URL}/crew/consume`, {
        headers: { "X-Tenant-Slug": "ms", Origin: TENANT_ORIGIN },
        data: { code: access.code, inviteToken: access.inviteToken }
      }));
      const detailResponse = await crew.get(`${API_URL}/inventory/sessions/${active.session.id}`, {
        headers: { "X-Tenant-Slug": "ms" }
      });
      const detail = await responseJson(detailResponse);
      const activeRow = detail.items.find(item => item.id === activeItem.sessionItem.id);
      expect(activeRow.priorInventoryHistory).toMatchObject({
        photos: [expect.objectContaining({ url: historyPhotos.get("matching").url })],
        photoContext: { locationText: "matching remembered shelf" }
      });
      expect((await crew.get(matchingPhotoUrl.toString())).status()).toBe(200);
      await expectMediaDenied(await crew.get(unrelatedPhotoUrl.toString()));

      for (const invalidOutcomePhotoUrl of invalidOutcomePhotoUrls) {
        await expectMediaDenied(await crew.get(invalidOutcomePhotoUrl.toString()));
      }

      await responseJson(await admin.patch(`${API_URL}/inventory/sessions/${active.session.id}`, {
        headers: qaHeaders(qaAdmin),
        data: { status: "closed" }
      }));
      await expectMediaDenied(await contributor.get(matchingPhotoUrl.toString()));
      await expectMediaDenied(await crew.get(matchingPhotoUrl.toString()));

      await responseJson(await admin.delete(
        `${API_URL}/inventory/equipment-library/links/${remembered.rememberedLink.id}`,
        { headers: qaHeaders(qaAdmin) }
      ));
    } finally {
      await Promise.all([admin.dispose(), contributor.dispose(), crew.dispose()]);
    }
  });

  test("requires a tenant-scoped HttpOnly session and enforces record and role access", async ({ playwright }, testInfo) => {
    const admin = await playwright.request.newContext();
    const contributor = await playwright.request.newContext();
    const anonymous = await playwright.request.newContext();

    try {
      const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
      const session = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA protected media ${suffix}`, status: "active" }
      }));
      const item = await responseJson(await admin.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
        headers: qaHeaders(qaAdmin),
        data: { packetLine: `QA-PROTECTED-MEDIA-${suffix.toUpperCase()}` }
      }));
      await responseJson(await contributor.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
        headers: qaHeaders(qaNco),
        data: { memberId: "self" }
      }));

      const uploadResponse = await contributor.post(`${API_URL}/uploads/photos`, {
        headers: qaHeaders(qaNco),
        data: {
          fileName: `media-${suffix}.jpg`,
          mimeType: "image/jpeg",
          dataUrl: PHOTO_DATA_URL,
          caption: "Protected media QA",
          kind: "general"
        }
      });
      const upload = await responseJson(uploadResponse);
      expect(upload.photo.uploadId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(upload.photo.storageKey).toBeUndefined();
      const setCookie = uploadResponse.headers()["set-cookie"];
      expect(setCookie).toContain("inventory_media_ms=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/media/tenants/ms");
      expect(setCookie).toContain("Max-Age=300");

      const proofSubmission = await responseJson(await contributor.post(`${API_URL}/session-items/${item.sessionItem.id}/submissions`, {
        headers: qaHeaders(qaNco),
        data: {
          status: "found",
          note: "Protected evidence",
          photos: [{
            uploadId: upload.photo.uploadId,
            caption: upload.photo.caption,
            kind: upload.photo.kind
          }]
        }
      }));
      const savedProof = await responseJson(await admin.patch(
        `${API_URL}/submissions/${proofSubmission.submission.id}/review`,
        {
          headers: qaHeaders(qaAdmin),
          data: {
            decision: "approved",
            saveItem: true,
            savedMediaUploadIds: [upload.photo.uploadId]
          }
        }
      ));
      expect(savedProof.savedItem?.id).toBeTruthy();

      const photoUrl = assertProtectedMediaUrl(upload.photo.url);
      await expectMediaDenied(await anonymous.get(photoUrl.toString(), {
        headers: { Origin: "http://ms.localhost:5175" }
      }));

      const contributorPhoto = await contributor.get(photoUrl.toString());
      expect(contributorPhoto.status()).toBe(200);
      expect(contributorPhoto.headers()["access-control-allow-origin"]).toBeUndefined();
      expect(contributorPhoto.headers()["content-type"]).toMatch(/^image\/jpeg/);
      expect(contributorPhoto.headers()["cache-control"]).toContain("private");
      expect(contributorPhoto.headers()["cache-control"]).toContain("no-store");
      expect(contributorPhoto.headers()["referrer-policy"]).toBe("no-referrer");
      expect(contributorPhoto.headers()["x-content-type-options"]).toBe("nosniff");
      expect((await contributorPhoto.body()).length).toBeGreaterThan(1000);

      const adminPhoto = await admin.get(photoUrl.toString());
      expect(adminPhoto.status()).toBe(200);

      const otherTenantUrl = new URL(photoUrl);
      otherTenantUrl.pathname = otherTenantUrl.pathname.replace("/tenants/ms/", "/tenants/other/");
      await expectMediaDenied(await contributor.get(otherTenantUrl.toString()));

      const unlinkedUrl = new URL(photoUrl);
      unlinkedUrl.pathname = unlinkedUrl.pathname.replace(/[^/]+$/, "unlinked-file.jpg");
      await expectMediaDenied(await contributor.get(unlinkedUrl.toString()));

      const referenceUpload = await responseJson(await admin.post(`${API_URL}/uploads/photos`, {
        headers: qaHeaders(qaAdmin),
        data: {
          fileName: `reference-${suffix}.jpg`,
          mimeType: "image/jpeg",
          dataUrl: PHOTO_DATA_URL,
          caption: "Known item reference",
          kind: "general",
          purpose: "inventory_reference"
        }
      }));
      const referenceUrl = assertProtectedMediaUrl(referenceUpload.photo.url);
      await expectMediaDenied(await admin.get(referenceUrl.toString()));

      const referenceItem = await responseJson(await admin.post(`${API_URL}/inventory/items`, {
        headers: qaHeaders(qaAdmin),
        data: {
          title: `Protected reference ${suffix}`,
          metadata: { imageUrl: referenceUpload.photo.url },
          mediaUploadIds: [referenceUpload.photo.uploadId]
        }
      }));
      expect((await admin.get(referenceUrl.toString())).status()).toBe(200);
      await expectMediaDenied(await contributor.get(referenceUrl.toString()));

      await responseJson(await admin.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
        headers: qaHeaders(qaAdmin),
        data: {
          packetLine: `QA-CONFIRMED-REFERENCE-${suffix.toUpperCase()}`,
          inventoryItemId: referenceItem.item.id
        }
      }));
      expect((await contributor.get(referenceUrl.toString())).status()).toBe(200);
      await expectMediaDenied(await anonymous.get(referenceUrl.toString()));

      const packetLine = `QA-PROTECTED-SOURCE-${suffix.toUpperCase()}`;
      const sourceBuffer = Buffer.from(`${packetLine}\n`, "utf8");
      await responseJson(await admin.post(`${API_URL}/inventory/sessions/${session.session.id}/items/bulk`, {
        headers: qaHeaders(qaAdmin),
        data: {
          items: [{ packetLine }],
          importBatch: {
            sourceName: `protected-source-${suffix}.txt`,
            sourceMimeType: "text/plain",
            extractedText: sourceBuffer.toString("utf8"),
            sourceFile: {
              fileName: `protected-source-${suffix}.txt`,
              mimeType: "text/plain",
              size: sourceBuffer.length,
              dataUrl: `data:text/plain;base64,${sourceBuffer.toString("base64")}`
            }
          }
        }
      }));
      const detail = await responseJson(await admin.get(`${API_URL}/inventory/sessions/${session.session.id}`, {
        headers: qaHeaders(qaAdmin)
      }));
      const sourceUrl = assertProtectedMediaUrl(detail.importBatches[0].sourceUrl);
      await expectMediaDenied(await anonymous.get(sourceUrl.toString()));
      await expectMediaDenied(await contributor.get(sourceUrl.toString()));

      const adminSource = await admin.get(sourceUrl.toString());
      expect(adminSource.status()).toBe(200);
      expect(adminSource.headers()["content-type"]).toMatch(/^text\/plain/);
      expect(adminSource.headers()["content-disposition"]).toContain("attachment");
      expect(adminSource.headers()["content-disposition"]).toContain(`protected-source-${suffix}.txt`);
      expect(await adminSource.text()).toBe(`${packetLine}\n`);

      await responseJson(await admin.patch(`${API_URL}/inventory/sessions/${session.session.id}`, {
        headers: qaHeaders(qaAdmin),
        data: { status: "closed" }
      }));
      await expectMediaDenied(await contributor.get(photoUrl.toString()));
      await expectMediaDenied(await contributor.get(referenceUrl.toString()));

      const followUp = await responseJson(await admin.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaAdmin),
        data: { name: `QA protected media follow-up ${suffix}`, status: "active" }
      }));
      for (const [savedItemId, label] of [
        [savedProof.savedItem.id, "proof"],
        [referenceItem.item.id, "reference"]
      ]) {
        await responseJson(await admin.post(`${API_URL}/inventory/sessions/${followUp.session.id}/items`, {
          headers: qaHeaders(qaAdmin),
          data: {
            packetLine: `QA-CONFIRMED-${label.toUpperCase()}-${suffix.toUpperCase()}`,
            inventoryItemId: savedItemId
          }
        }));
      }
      expect((await contributor.get(photoUrl.toString())).status()).toBe(200);
      expect((await contributor.get(referenceUrl.toString())).status()).toBe(200);

      const state = await contributor.storageState();
      const mediaCookie = state.cookies.find(cookie => cookie.name === "inventory_media_ms");
      expect(mediaCookie?.httpOnly).toBeTruthy();
      expect(mediaCookie?.sameSite).toBe("Strict");
      const tamperedCookie = `${mediaCookie.value.slice(0, -1)}${mediaCookie.value.endsWith("A") ? "B" : "A"}`;
      const forged = await playwright.request.newContext({
        extraHTTPHeaders: { Cookie: `inventory_media_ms=${tamperedCookie}` }
      });
      try {
        await expectMediaDenied(await forged.get(photoUrl.toString()));
      } finally {
        await forged.dispose();
      }
    } finally {
      await Promise.all([admin.dispose(), contributor.dispose(), anonymous.dispose()]);
    }
  });
});
