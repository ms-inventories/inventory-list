import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
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

async function createSessionItem(request, {
  identity = qaAdmin,
  tenantSlug = "ms",
  name,
  packetLine,
  expectedQty = 1,
  inventoryItemId
}) {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { name, status: "active" }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { packetLine, expectedQty, ...(inventoryItemId ? { inventoryItemId } : {}) }
  }));
  return { sessionId: session.session.id, sessionItemId: item.sessionItem.id };
}

async function createBulkSessionItem(request, {
  identity = qaAdmin,
  tenantSlug = "ms",
  name,
  packetLine,
  expectedQty = 1
}) {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { name, status: "active" }
  }));
  const result = await responseJson(await request.post(
    `${API_URL}/inventory/sessions/${session.session.id}/items/bulk`,
    {
      headers: qaHeaders(identity, tenantSlug),
      data: { items: [{ packetLine, expectedQty }] }
    }
  ));
  expect(result.sessionItems).toHaveLength(1);
  return {
    sessionId: session.session.id,
    sessionItemId: result.sessionItems[0].id,
    possibleMatchCount: result.possibleMatchCount
  };
}

async function uploadPhoto(request, { identity, tenantSlug = "ms", label, purpose = "evidence" }) {
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(identity, tenantSlug),
    data: {
      fileName: `${label}.png`,
      mimeType: "image/png",
      dataUrl: PHOTO_DATA_URL,
      caption: label,
      kind: "general",
      purpose
    }
  }));
  return upload.photo;
}

async function submitFound(request, {
  identity,
  tenantSlug = "ms",
  sessionItemId,
  location,
  serialNumber,
  photos
}) {
  return responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: {
      status: "found",
      locationText: location,
      serialNumber,
      photos: photos.map(photo => ({
        uploadId: photo.uploadId,
        caption: photo.caption,
        kind: photo.kind
      }))
    }
  }));
}

test.describe("verified item reuse API", () => {
  test("leaders confirm prior matches and atomically choose saved proof photos", async ({ request }, testInfo) => {
    const stamp = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const lin = `R${String(Date.now() % 100000).padStart(5, "0")}`;
    const packetLine = `${lin} VERIFIED REUSE ${stamp.toUpperCase()}`;

    const first = await createSessionItem(request, {
      name: `QA reuse first ${stamp}`,
      packetLine
    });
    await responseJson(await request.patch(`${API_URL}/session-items/${first.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    const firstPhotos = await Promise.all([
      uploadPhoto(request, { identity: qaNco, label: `reuse-first-a-${stamp}` }),
      uploadPhoto(request, { identity: qaNco, label: `reuse-first-b-${stamp}` })
    ]);
    const firstSubmission = await submitFound(request, {
      identity: qaNco,
      sessionItemId: first.sessionItemId,
      location: "QA vault shelf one",
      serialNumber: `SERIAL-${stamp}`,
      photos: firstPhotos
    });

    const prematureClose = await request.patch(`${API_URL}/inventory/sessions/${first.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    });
    expect(prematureClose.status()).toBe(409);

    const firstReview = await responseJson(await request.patch(
      `${API_URL}/submissions/${firstSubmission.submission.id}/review`,
      {
        headers: qaHeaders(qaAdmin),
        data: {
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: [firstPhotos[0].uploadId]
        }
      }
    ));
    expect(firstReview.savedItem).toMatchObject({
      currentLocation: "QA vault shelf one",
      serialNumber: `SERIAL-${stamp}`
    });
    expect(firstReview.savedItem.photos).toHaveLength(1);
    expect(firstReview.savedItem.photos[0]).toMatchObject({
      mediaUploadId: firstPhotos[0].uploadId,
      kind: "general"
    });
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${first.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));

    const second = await createBulkSessionItem(request, {
      name: `QA reuse second ${stamp}`,
      packetLine
    });
    expect(second.possibleMatchCount).toBe(1);
    const adminSuggestion = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${second.sessionId}`,
      { headers: qaHeaders(qaAdmin) }
    ));
    const suggestedRow = adminSuggestion.items.find(item => item.id === second.sessionItemId);
    expect(suggestedRow.inventoryItem).toBeNull();
    expect(suggestedRow.suggestedInventoryItem).toMatchObject({
      id: firstReview.savedItem.id,
      currentLocation: "QA vault shelf one"
    });
    expect(suggestedRow.suggestedInventoryItem.photos).toHaveLength(1);

    const contributorView = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${second.sessionId}`,
      { headers: qaHeaders(qaNco) }
    ));
    const contributorRow = contributorView.items.find(item => item.id === second.sessionItemId);
    expect(contributorRow.inventoryItem).toBeNull();
    expect(contributorRow.suggestedInventoryItem).toBeNull();

    const contributorInventoryList = await request.get(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaNco)
    });
    expect(contributorInventoryList.status()).toBe(403);

    const contributorConfirm = await request.patch(
      `${API_URL}/session-items/${second.sessionItemId}/inventory-match`,
      { headers: qaHeaders(qaNco), data: { action: "confirm" } }
    );
    expect(contributorConfirm.status()).toBe(403);

    await responseJson(await request.patch(`${API_URL}/session-items/${second.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    const secondPhotos = await Promise.all([1, 2, 3].map(index => uploadPhoto(request, {
      identity: qaNco,
      label: `reuse-second-${index}-${stamp}`
    })));
    const secondSubmission = await submitFound(request, {
      identity: qaNco,
      sessionItemId: second.sessionItemId,
      location: "QA vault shelf two",
      serialNumber: `SERIAL-${stamp}`,
      photos: secondPhotos
    });

    const unresolvedApproval = await request.patch(
      `${API_URL}/submissions/${secondSubmission.submission.id}/review`,
      { headers: qaHeaders(qaAdmin), data: { decision: "approved" } }
    );
    expect(unresolvedApproval.status()).toBe(409);

    const confirmed = await responseJson(await request.patch(
      `${API_URL}/session-items/${second.sessionItemId}/inventory-match`,
      { headers: qaHeaders(qaAdmin), data: { action: "confirm" } }
    ));
    expect(confirmed.inventoryItem.id).toBe(firstReview.savedItem.id);
    expect(confirmed.inventoryItem.photos[0].mediaUploadId).toBe(firstPhotos[0].uploadId);

    const other = await createSessionItem(request, {
      identity: qaRoot,
      tenantSlug: "qa-other",
      name: `QA other reuse ${stamp}`,
      packetLine: `X${lin.slice(1)} OTHER TENANT ${stamp}`
    });
    const otherPhoto = await uploadPhoto(request, {
      identity: qaRoot,
      tenantSlug: "qa-other",
      label: `reuse-other-${stamp}`
    });
    await submitFound(request, {
      identity: qaRoot,
      tenantSlug: "qa-other",
      sessionItemId: other.sessionItemId,
      location: "Other tenant shelf",
      serialNumber: `OTHER-${stamp}`,
      photos: [otherPhoto]
    });
    const otherInventoryItem = await responseJson(await request.post(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaRoot, "qa-other"),
      data: { title: `Other tenant saved item ${stamp}` }
    }));
    const foreignItemLink = await request.post(`${API_URL}/inventory/sessions/${second.sessionId}/items`, {
      headers: qaHeaders(qaAdmin),
      data: {
        packetLine: `FOREIGN ITEM LINK ${stamp}`,
        inventoryItemId: otherInventoryItem.item.id
      }
    });
    expect(foreignItemLink.status()).toBe(400);

    const foreignPhotoApproval = await request.patch(
      `${API_URL}/submissions/${secondSubmission.submission.id}/review`,
      {
        headers: qaHeaders(qaAdmin),
        data: {
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: [otherPhoto.uploadId]
        }
      }
    );
    expect(foreignPhotoApproval.status()).toBe(400);

    const tooManySavedPhotos = await request.patch(
      `${API_URL}/submissions/${secondSubmission.submission.id}/review`,
      {
        headers: qaHeaders(qaAdmin),
        data: {
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: [
            firstPhotos[0].uploadId,
            ...secondPhotos.map(photo => photo.uploadId)
          ]
        }
      }
    );
    expect(tooManySavedPhotos.status()).toBe(400);
    expect(await tooManySavedPhotos.json()).toMatchObject({
      code: "validation_failed",
      error: "Validation failed"
    });

    const chosenSavedPhotos = [
      firstPhotos[0].uploadId,
      secondPhotos[1].uploadId,
      secondPhotos[2].uploadId
    ];

    const finalReview = await responseJson(await request.patch(
      `${API_URL}/submissions/${secondSubmission.submission.id}/review`,
      {
        headers: qaHeaders(qaAdmin),
        data: {
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: chosenSavedPhotos
        }
      }
    ));
    expect(finalReview.savedItem).toMatchObject({
      id: firstReview.savedItem.id,
      currentLocation: "QA vault shelf two",
      serialNumber: `SERIAL-${stamp}`
    });
    expect(finalReview.savedItem.photos.map(photo => photo.mediaUploadId)).toEqual(chosenSavedPhotos);

    const finalDetail = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${second.sessionId}`,
      { headers: qaHeaders(qaNco) }
    ));
    const finalRow = finalDetail.items.find(item => item.id === second.sessionItemId);
    expect(finalRow.suggestedInventoryItem).toBeNull();
    expect(finalRow.inventoryItem.currentLocation).toBe("QA vault shelf two");
    expect(finalRow.inventoryItem.photos.map(photo => photo.mediaUploadId)).toEqual(chosenSavedPhotos);
  });

  test("grouped packet quantities cannot be saved as one verified asset", async ({ request }, testInfo) => {
    const stamp = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const grouped = await createSessionItem(request, {
      name: `QA grouped reuse ${stamp}`,
      packetLine: `G54321 GROUPED REUSE ${stamp.toUpperCase()}`,
      expectedQty: 2
    });
    await responseJson(await request.patch(`${API_URL}/session-items/${grouped.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    const missingPhoto = await request.post(
      `${API_URL}/session-items/${grouped.sessionItemId}/submissions`,
      {
        headers: qaHeaders(qaNco),
        data: {
          status: "found",
          locationText: "Grouped shelf",
          serialNumber: `GROUPED-${stamp}`
        }
      }
    );
    expect(missingPhoto.status()).toBe(400);
    expect(await missingPhoto.json()).toMatchObject({
      code: "invalid_request",
      error: "Add at least one photo or an accountability note with at least 12 characters."
    });

    const groupedPhoto = await uploadPhoto(request, {
      identity: qaNco,
      label: `reuse-grouped-${stamp}`
    });
    const submission = await submitFound(request, {
      identity: qaNco,
      sessionItemId: grouped.sessionItemId,
      location: "Grouped shelf",
      serialNumber: `GROUPED-${stamp}`,
      photos: [groupedPhoto]
    });
    const save = await request.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved", saveItem: true }
    });
    expect(save.status()).toBe(409);

    await responseJson(await request.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved" }
    }));
  });

  test("deselected legacy photo metadata does not restore an old reference", async ({ request }, testInfo) => {
    const stamp = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const oldPhoto = await uploadPhoto(request, {
      identity: qaAdmin,
      label: `reuse-legacy-${stamp}`,
      purpose: "inventory_reference"
    });
    const created = await responseJson(await request.post(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaAdmin),
      data: {
        title: `Legacy reference ${stamp}`,
        metadata: {
          imageUrl: oldPhoto.url,
          fields: [
            { label: "Photo", value: oldPhoto.url },
            { label: "Warehouse note", value: "Keep this note" }
          ],
          source: "qa-legacy"
        },
        mediaUploadIds: [oldPhoto.uploadId]
      }
    }));

    const scenario = await createSessionItem(request, {
      name: `QA legacy cleanup ${stamp}`,
      packetLine: `L54321 LEGACY CLEANUP ${stamp.toUpperCase()}`,
      inventoryItemId: created.item.id
    });
    await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    const newPhoto = await uploadPhoto(request, {
      identity: qaNco,
      label: `reuse-current-${stamp}`
    });
    const submission = await submitFound(request, {
      identity: qaNco,
      sessionItemId: scenario.sessionItemId,
      location: "QA cleaned shelf",
      serialNumber: `CLEAN-${stamp}`,
      photos: [newPhoto]
    });
    const review = await responseJson(await request.patch(
      `${API_URL}/submissions/${submission.submission.id}/review`,
      {
        headers: qaHeaders(qaAdmin),
        data: {
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: [newPhoto.uploadId]
        }
      }
    ));

    expect(review.savedItem.photos.map(photo => photo.mediaUploadId)).toEqual([newPhoto.uploadId]);
    expect(review.savedItem.metadata).toEqual({
      fields: [{ label: "Warehouse note", value: "Keep this note" }],
      source: "qa-legacy"
    });
  });
});
