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

async function createScenario(request, suffix) {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: `QA proof reliability ${suffix}`, status: "active" }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: qaHeaders(qaAdmin),
    data: { packetLine: `QA-PROOF-${suffix.toUpperCase()} TEST ITEM` }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));
  return { sessionId: session.session.id, sessionItemId: item.sessionItem.id };
}

async function uploadPhoto(request, label) {
  return (await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(qaNco),
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

async function submitProof(request, sessionItemId, note) {
  const label = `proof-${sessionItemId}-${note.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const proofPhoto = await uploadPhoto(request, label);
  return responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(qaNco),
    data: {
      status: "found",
      locationText: "QA shelf",
      note,
      photos: [{ uploadId: proofPhoto.uploadId, kind: "general" }]
    }
  }));
}

test.describe("proof review reliability", () => {
  test("a response follows a rejection kept with its submitter and one approval clears the review queue", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const scenario = await createScenario(request, suffix);

    const first = await submitProof(request, scenario.sessionItemId, "Initial proof");
    await responseJson(await request.patch(`${API_URL}/submissions/${first.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: {
        decision: "rejected",
        note: "Need a clearer serial number.",
        returnAssignment: "submitter"
      }
    }));
    const response = await submitProof(request, scenario.sessionItemId, "Clear serial number response");

    const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin)
    }));
    const submissions = detail.items.find(item => item.id === scenario.sessionItemId).submissions;
    expect(submissions.find(item => item.id === first.submission.id)?.reviewState).toBe("rejected");
    expect(submissions.find(item => item.id === response.submission.id)?.reviewState).toBe("pending");
    expect(submissions.filter(item => item.reviewState === "pending")).toHaveLength(1);

    const queueBeforeApproval = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    const queuedForItem = queueBeforeApproval.submissions.filter(item => item.sessionItem.id === scenario.sessionItemId);
    expect(queuedForItem).toHaveLength(1);
    expect(queuedForItem[0].id).toBe(response.submission.id);

    const staleReview = await request.patch(`${API_URL}/submissions/${first.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved" }
    });
    expect(staleReview.status()).toBe(409);
    expect(await staleReview.json()).toMatchObject({
      code: "conflict",
      error: "This proof has already been reviewed or replaced."
    });

    const staleRejection = await request.patch(`${API_URL}/submissions/${first.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: {
        decision: "rejected",
        note: "This older proof should no longer be actionable.",
        returnAssignment: "unassigned"
      }
    });
    expect(staleRejection.status()).toBe(409);
    expect(await staleRejection.json()).toMatchObject({ code: "conflict" });

    await responseJson(await request.patch(`${API_URL}/submissions/${response.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved" }
    }));

    const repeatedApproval = await request.patch(`${API_URL}/submissions/${response.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved" }
    });
    expect(repeatedApproval.status()).toBe(409);
    expect(await repeatedApproval.json()).toMatchObject({ code: "conflict" });

    const queueAfterApproval = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(queueAfterApproval.submissions.some(item => item.sessionItem.id === scenario.sessionItemId)).toBeFalsy();
  });

  test("accepts ten evidence photos and rejects an eleventh", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const scenario = await createScenario(request, suffix);
    const photos = [];
    for (let index = 0; index < 10; index += 1) {
      photos.push(await uploadPhoto(request, `ten-photo-${suffix}-${index + 1}`));
    }

    const accepted = await responseJson(await request.post(`${API_URL}/session-items/${scenario.sessionItemId}/submissions`, {
      headers: qaHeaders(qaNco),
      data: {
        status: "found",
        photos: photos.map(photo => ({ uploadId: photo.uploadId, kind: "general" }))
      }
    }));

    const queue = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(queue.submissions.find(submission => submission.id === accepted.submission.id)?.photos).toHaveLength(10);

    const result = await request.post(`${API_URL}/session-items/${scenario.sessionItemId}/submissions`, {
      headers: qaHeaders(qaNco),
      data: {
        status: "found",
        photos: Array.from({ length: 11 }, (_, index) => ({
          uploadId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          kind: "general"
        }))
      }
    });

    expect(result.status()).toBe(400);
    expect(await result.json()).toMatchObject({ code: "validation_failed", error: "Validation failed" });

    await responseJson(await request.patch(`${API_URL}/submissions/${accepted.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved" }
    }));
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));
  });

  test("note-only accountability evidence can be approved and saved with zero reference photos", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-note-${Date.now()}`;
    const scenario = await createScenario(request, suffix);

    for (const status of ["found", "not_found", "mismatch"]) {
      const emptyEvidence = await request.post(`${API_URL}/session-items/${scenario.sessionItemId}/submissions`, {
        headers: qaHeaders(qaNco),
        data: { status, note: "  " }
      });
      expect(emptyEvidence.status()).toBe(400);
      expect(await emptyEvidence.json()).toMatchObject({
        code: "invalid_request",
        error: "Add at least one photo or an accountability note with at least 12 characters."
      });
    }

    const note = `Verified with supply; signed out to SGT Smith for maintenance (${suffix}).`;
    const submitted = await responseJson(await request.post(`${API_URL}/session-items/${scenario.sessionItemId}/submissions`, {
      headers: qaHeaders(qaNco),
      data: {
        status: "found",
        locationText: "Maintenance shop",
        serialNumber: "N/A",
        note
      }
    }));

    const queue = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    const queued = queue.submissions.find(submission => submission.id === submitted.submission.id);
    expect(queued).toMatchObject({ note, serialNumber: null, locationText: "Maintenance shop" });
    expect(queued.photos).toEqual([]);
    if (queued.sessionItem.suggestedInventoryItem) {
      await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/inventory-match`, {
        headers: qaHeaders(qaAdmin),
        data: { action: "dismiss" }
      }));
    }

    const approved = await responseJson(await request.patch(`${API_URL}/submissions/${submitted.submission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: {
        decision: "approved",
        saveItem: true,
        savedMediaUploadIds: []
      }
    }));
    expect(approved.savedItem).toMatchObject({ currentLocation: "Maintenance shop", serialNumber: null });
    expect(approved.savedItem.photos).toEqual([]);

    const queueAfterApproval = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(queueAfterApproval.submissions.some(submission => submission.id === submitted.submission.id)).toBeFalsy();

    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));
  });
});
