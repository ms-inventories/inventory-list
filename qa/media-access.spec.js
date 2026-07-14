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

function qaHeaders(identity) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": "ms"
  };
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
