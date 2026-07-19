import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const TENANT_ORIGIN = process.env.QA_TENANT_ORIGIN || "http://ms.localhost:5175";
const PHOTO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function qaHeaders(identity = qaAdmin, tenantSlug = "ms") {
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

function uniqueLin(value) {
  let hash = 0;
  for (const character of String(value)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return `8${hash.toString(36).toUpperCase().padStart(4, "0").slice(-4)}N`;
}

async function createSessionItem(request, { name, packetLine, expectedQty = 4 }) {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(),
    data: { name, status: "active" }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: qaHeaders(),
    data: { packetLine, expectedQty }
  }));
  return { session: session.session, item: item.sessionItem };
}

async function submitAndApprove(request, {
  sessionItemId,
  status,
  locationText,
  note,
  photoCaption,
  approve = true
}) {
  await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
    headers: qaHeaders(),
    data: { memberId: "self" }
  }));
  const photos = [];
  const photoCaptions = Array.isArray(photoCaption) ? photoCaption : photoCaption ? [photoCaption] : [];
  for (const caption of photoCaptions) {
    const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
      headers: qaHeaders(),
      data: {
        fileName: `${caption}.png`,
        mimeType: "image/png",
        dataUrl: PHOTO_DATA_URL,
        caption,
        kind: "general",
        purpose: "evidence"
      }
    }));
    photos.push({
      uploadId: upload.photo.uploadId,
      caption: upload.photo.caption,
      kind: upload.photo.kind
    });
  }
  const submission = await responseJson(await request.post(
    `${API_URL}/session-items/${sessionItemId}/submissions`,
    {
      headers: qaHeaders(),
      data: { status, locationText, note, photos }
    }
  ));
  if (approve) {
    await responseJson(await request.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
      headers: qaHeaders(),
      data: { decision: "approved", saveItem: false }
    }));
  }
  return submission.submission;
}

async function closeSession(request, sessionId) {
  await responseJson(await request.patch(`${API_URL}/inventory/sessions/${sessionId}`, {
    headers: qaHeaders(),
    data: { status: "closed" }
  }));
}

test("equipment library derives approved type history and remembers manual packet links", async ({ request, playwright }, testInfo) => {
  const stamp = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const manualToken = `${testInfo.project.name}-${Date.now().toString(36)}`.toUpperCase();
  const lin = uniqueLin(stamp);
  const createdSessionIds = [];
  let rememberedLinkId = null;
  const foundCaptions = [1, 2, 3, 4].map(index => `library-found-${index}-${stamp}`);
  const mismatchCaption = `library-mismatch-${stamp}`;
  const pendingCaption = `library-pending-${stamp}`;

  try {
    const found = await createSessionItem(request, {
      name: `Equipment library found ${stamp}`,
      packetLine: `000000001 ${lin} EQUIPMENT LIBRARY RADIO ${stamp.toUpperCase()}`,
      expectedQty: 4
    });
    createdSessionIds.push(found.session.id);
    await submitAndApprove(request, {
      sessionItemId: found.item.id,
      status: "found",
      locationText: "Library found cage",
      note: "Found during the approved equipment library baseline.",
      photoCaption: foundCaptions
    });
    await closeSession(request, found.session.id);

    const mismatch = await createSessionItem(request, {
      name: `Equipment library mismatch ${stamp}`,
      packetLine: `000000002 ${lin} EQUIPMENT LIBRARY RADIO ${stamp.toUpperCase()}`,
      expectedQty: 4
    });
    createdSessionIds.push(mismatch.session.id);
    await submitAndApprove(request, {
      sessionItemId: mismatch.item.id,
      status: "mismatch",
      locationText: "Wrong equipment shelf",
      note: "The equipment at this location was a different model.",
      photoCaption: mismatchCaption
    });
    await closeSession(request, mismatch.session.id);

    const missing = await createSessionItem(request, {
      name: `Equipment library missing ${stamp}`,
      packetLine: `000000003 ${lin} EQUIPMENT LIBRARY RADIO ${stamp.toUpperCase()}`,
      expectedQty: 4
    });
    createdSessionIds.push(missing.session.id);
    await submitAndApprove(request, {
      sessionItemId: missing.item.id,
      status: "not_found",
      locationText: "",
      note: "Searched the assigned area and the equipment was not present."
    });
    await closeSession(request, missing.session.id);

    const pending = await createSessionItem(request, {
      name: `Equipment library pending ${stamp}`,
      packetLine: `000000004 ${lin} EQUIPMENT LIBRARY RADIO ${stamp.toUpperCase()}`,
      expectedQty: 4
    });
    createdSessionIds.push(pending.session.id);
    await submitAndApprove(request, {
      sessionItemId: pending.item.id,
      status: "found",
      locationText: "Unapproved equipment shelf",
      note: "This proof remains pending and must not enter approved history.",
      photoCaption: pendingCaption,
      approve: false
    });

    const sourceWording = `UNKNOWN MANUAL LIBRARY WORDING ${manualToken}`;
    const source = await createSessionItem(request, {
      name: `Equipment library unlinked ${stamp}`,
      packetLine: sourceWording,
      expectedQty: 7
    });
    createdSessionIds.push(source.session.id);

    const library = await responseJson(await request.get(`${API_URL}/inventory/equipment-library`, {
      headers: qaHeaders()
    }));
    const entry = library.entries.find(candidate => candidate.lins.includes(lin));
    expect(entry).toBeTruthy();
    expect(entry.key).toMatch(/^eql_[A-Za-z0-9_-]{22}$/);
    expect(entry).toMatchObject({
      latestOutcome: "not_found",
      latestSessionName: `Equipment library missing ${stamp}`,
      lastFound: {
        locationText: "Library found cage",
        sessionName: `Equipment library found ${stamp}`,
        expectedQty: 4
      },
      observationCount: 3,
      sessionCount: 3,
      savedAssetCount: 0
    });
    expect(entry.locations.map(location => location.locationText)).toEqual(["Library found cage"]);
    expect(entry.photos).toHaveLength(3);
    expect(entry.photos.every(photo => foundCaptions.includes(photo.caption))).toBe(true);
    const omittedFoundCaptions = foundCaptions.filter(caption => (
      !entry.photos.some(photo => photo.caption === caption)
    ));
    expect(omittedFoundCaptions).toHaveLength(1);
    expect(entry.photos[0]).toMatchObject({ kind: "general" });
    expect(entry.photoContext).toMatchObject({
      locationText: "Library found cage",
      sessionName: `Equipment library found ${stamp}`
    });
    const serializedEntry = JSON.stringify(entry);
    for (const forbidden of [
      mismatchCaption,
      pendingCaption,
      omittedFoundCaptions[0],
      "storageKey",
      "mediaUploadId",
      "submittedBy",
      "reviewNote",
      '"note"'
    ]) {
      expect(serializedEntry).not.toContain(forbidden);
    }
    const automaticDetail = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${pending.session.id}`,
      { headers: qaHeaders() }
    ));
    const automaticHistory = automaticDetail.items.find(item => item.id === pending.item.id).priorInventoryHistory;
    expect(automaticHistory).toMatchObject({
      status: "not_found",
      locationText: null,
      historyCount: 3,
      lastFound: {
        locationText: "Library found cage",
        sessionName: `Equipment library found ${stamp}`,
        sessionStatus: "closed",
        inventoriedAt: expect.any(String),
        expectedQty: 4
      },
      photos: expect.arrayContaining([expect.objectContaining({ caption: foundCaptions[0] })]),
      photoContext: { locationText: "Library found cage" }
    });
    expect(automaticHistory.photos.map(photo => photo.caption).sort()).toEqual([...foundCaptions].sort());
    expect(JSON.stringify(automaticHistory)).not.toContain(mismatchCaption);
    expect(library.unlinkedActiveRows).toContainEqual({
      id: source.item.id,
      sessionId: source.session.id,
      sessionName: source.session.name,
      packetLine: sourceWording,
      expectedQty: 7
    });

    const contributor = await request.get(`${API_URL}/inventory/equipment-library`, {
      headers: qaHeaders(qaContributor)
    });
    expect(contributor.status()).toBe(403);
    const otherTenant = await responseJson(await request.get(`${API_URL}/inventory/equipment-library`, {
      headers: qaHeaders(qaRoot, "qa-other")
    }));
    expect(otherTenant.entries.some(candidate => candidate.lins.includes(lin))).toBe(false);

    const access = await responseJson(await request.post(
      `${API_URL}/inventory/sessions/${source.session.id}/crew-access`,
      { headers: qaHeaders(), data: { displayName: `Library crew ${stamp}` } }
    ));
    const crew = await playwright.request.newContext();
    try {
      await responseJson(await crew.post(`${API_URL}/crew/consume`, {
        headers: { "X-Tenant-Slug": "ms", Origin: TENANT_ORIGIN },
        data: { code: access.code, inviteToken: access.inviteToken }
      }));
      const crewLibrary = await crew.get(`${API_URL}/inventory/equipment-library`, {
        headers: { "X-Tenant-Slug": "ms" }
      });
      expect([401, 403]).toContain(crewLibrary.status());
    } finally {
      await crew.dispose();
    }

    const createdLink = await responseJson(await request.post(
      `${API_URL}/inventory/equipment-library/links`,
      {
        headers: qaHeaders(),
        data: { sourceSessionItemId: source.item.id, targetEntryKey: entry.key }
      }
    ));
    rememberedLinkId = createdLink.rememberedLink.id;
    expect(createdLink.rememberedLink).toMatchObject({
      sourcePacketLine: sourceWording,
      targetEntryKey: entry.key,
      targetDisplayName: entry.displayName
    });

    const linkedLibrary = await responseJson(await request.get(`${API_URL}/inventory/equipment-library`, {
      headers: qaHeaders()
    }));
    expect(linkedLibrary.rememberedLinks).toContainEqual(expect.objectContaining({
      id: rememberedLinkId,
      sourcePacketLine: sourceWording,
      targetEntryKey: entry.key
    }));
    expect(linkedLibrary.unlinkedActiveRows.some(row => row.id === source.item.id)).toBe(false);

    const sourceDetail = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${source.session.id}`,
      { headers: qaHeaders() }
    ));
    const sourceHistory = sourceDetail.items.find(item => item.id === source.item.id).priorInventoryHistory;
    expect(sourceHistory).toMatchObject({
      status: "not_found",
      locationText: null,
      historyCount: 3,
      lastFound: {
        locationText: "Library found cage",
        sessionName: `Equipment library found ${stamp}`,
        sessionStatus: "closed",
        inventoriedAt: expect.any(String),
        expectedQty: 4
      },
      photos: expect.arrayContaining([expect.objectContaining({ caption: foundCaptions[0] })]),
      photoContext: { locationText: "Library found cage" }
    });
    expect(sourceHistory.photos).toHaveLength(4);
    expect(sourceHistory.photos.map(photo => photo.caption).sort()).toEqual([...foundCaptions].sort());

    const future = await createSessionItem(request, {
      name: `Equipment library future alias ${stamp}`,
      packetLine: sourceWording,
      expectedQty: 9
    });
    createdSessionIds.push(future.session.id);
    const futureDetail = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${future.session.id}`,
      { headers: qaHeaders() }
    ));
    expect(futureDetail.items.find(item => item.id === future.item.id).priorInventoryHistory).toMatchObject({
      status: "not_found",
      locationText: null,
      historyCount: 3,
      lastFound: {
        locationText: "Library found cage",
        sessionName: `Equipment library found ${stamp}`,
        sessionStatus: "closed",
        inventoriedAt: expect.any(String),
        expectedQty: 4
      },
      photos: expect.arrayContaining([expect.objectContaining({ caption: foundCaptions[0] })]),
      photoContext: { locationText: "Library found cage" }
    });

    const removed = await responseJson(await request.delete(
      `${API_URL}/inventory/equipment-library/links/${rememberedLinkId}`,
      { headers: qaHeaders() }
    ));
    expect(removed).toMatchObject({ deleted: true, rememberedLink: { id: rememberedLinkId } });
    rememberedLinkId = null;
    const afterDelete = await responseJson(await request.get(
      `${API_URL}/inventory/sessions/${future.session.id}`,
      { headers: qaHeaders() }
    ));
    expect(afterDelete.items.find(item => item.id === future.item.id).priorInventoryHistory).toBeNull();

    const createdAudit = await responseJson(await request.get(
      `${API_URL}/tenant/audit-events?action=equipment_library_link.created&limit=100`,
      { headers: qaHeaders() }
    ));
    const deletedAudit = await responseJson(await request.get(
      `${API_URL}/tenant/audit-events?action=equipment_library_link.deleted&limit=100`,
      { headers: qaHeaders() }
    ));
    const createdEvent = createdAudit.events.find(event => event.entity?.id === removed.rememberedLink.id);
    const deletedEvent = deletedAudit.events.find(event => event.entity?.id === removed.rememberedLink.id);
    for (const event of [createdEvent, deletedEvent]) {
      expect(event).toMatchObject({
        category: "workflow",
        details: {
          sourcePacketLine: sourceWording,
          targetDisplayName: entry.displayName
        },
        context: {
          sessionId: source.session.id,
          sessionName: source.session.name,
          sessionItemId: source.item.id,
          packetLine: sourceWording
        }
      });
      expect(Object.keys(event.details).sort()).toEqual(["sourcePacketLine", "targetDisplayName"]);
    }
  } finally {
    if (rememberedLinkId) {
      await request.delete(`${API_URL}/inventory/equipment-library/links/${rememberedLinkId}`, {
        headers: qaHeaders()
      });
    }
    for (const sessionId of createdSessionIds.reverse()) {
      await request.delete(`${API_URL}/inventory/sessions/${sessionId}`, { headers: qaHeaders() });
    }
  }
});
