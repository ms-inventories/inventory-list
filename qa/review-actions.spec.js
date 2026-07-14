import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
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

async function createPendingSubmission(request, label) {
  const sessionName = `QA review ${label} ${Date.now()}`;
  const packetLine = `QA-${label.toUpperCase()} ${Date.now()} TEST ITEM`;
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: sessionName, status: "active" }
  }));
  const sessionId = session.session.id;

  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionId}/items`, {
    headers: qaHeaders(qaAdmin),
    data: { packetLine, expectedQty: 1, locationHint: "QA review shelf" }
  }));
  const sessionItemId = item.sessionItem.id;
  await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));

  const proofPhoto = await uploadPhoto(request, `review-${label}-${sessionItemId}`);
  const submission = await responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(qaNco),
    data: {
      status: "found",
      locationText: "QA review shelf",
      note: `Evidence for ${label}`,
      serialNumber: `QA-${label.toUpperCase()}-001`,
      photos: [{ uploadId: proofPhoto.uploadId, kind: "general" }]
    }
  }));

  return {
    label,
    sessionId,
    sessionItemId,
    submissionId: submission.submission.id,
    packetLine
  };
}

async function signInAsPlatoonAdmin(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openReviewQueue(page) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await page.getByRole("button", { name: "Review Queue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review Queue", exact: true })).toBeVisible();
}

async function loadSessionDetail(request, record) {
  return responseJson(await request.get(`${API_URL}/inventory/sessions/${record.sessionId}`, {
    headers: qaHeaders(qaAdmin)
  }));
}

test.describe("review queue decisions", () => {
  test("approve, reject, and more-proof actions update every dependent state", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
    const approved = await createPendingSubmission(request, `approve-${suffix}`);
    const rejected = await createPendingSubmission(request, `reject-${suffix}`);
    const requested = await createPendingSubmission(request, `request-${suffix}`);

    await signInAsPlatoonAdmin(page);
    await openReviewQueue(page);

    const approvedCard = page.locator(".review-card", { hasText: approved.packetLine });
    await expect(approvedCard).toBeVisible();
    await approvedCard.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(`Approved proof for ${approved.packetLine}.`)).toBeVisible();
    await expect(approvedCard).toHaveCount(0);

    const rejectedCard = page.locator(".review-card", { hasText: rejected.packetLine });
    await expect(rejectedCard).toBeVisible();
    await rejectedCard.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText(`Rejected proof for ${rejected.packetLine}.`)).toBeVisible();
    await expect(rejectedCard).toHaveCount(0);

    const requestMessage = `Need a closer serial photo for ${suffix}.`;
    const requestedCard = page.locator(".review-card", { hasText: requested.packetLine });
    await expect(requestedCard).toBeVisible();
    await requestedCard.getByRole("button", { name: "More proof" }).click();
    await requestedCard.getByLabel("Request note").fill(requestMessage);
    await requestedCard.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText(`Proof request sent for ${requested.packetLine}.`)).toBeVisible();
    await expect(requestedCard.getByText(`Requested: ${requestMessage}`)).toBeVisible();

    const approvedDetail = await loadSessionDetail(request, approved);
    const approvedItem = approvedDetail.items.find(item => item.id === approved.sessionItemId);
    expect(approvedItem.status).toBe("approved");
    expect(approvedItem.submissions.find(item => item.id === approved.submissionId)?.reviewState).toBe("approved");
    const savedItems = await responseJson(await request.get(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(savedItems.items.some(item => item.title === approved.packetLine)).toBeFalsy();

    const rejectedDetail = await loadSessionDetail(request, rejected);
    const rejectedItem = rejectedDetail.items.find(item => item.id === rejected.sessionItemId);
    expect(rejectedItem.status).toBe("needs_review");
    expect(rejectedItem.submissions.find(item => item.id === rejected.submissionId)?.reviewState).toBe("rejected");

    const requestedDetail = await loadSessionDetail(request, requested);
    const requestedItem = requestedDetail.items.find(item => item.id === requested.sessionItemId);
    expect(requestedItem.status).toBe("needs_review");
    expect(requestedItem.submissions.find(item => item.id === requested.submissionId)?.reviewState).toBe("request_more_info");
    expect(requestedItem.submissions.find(item => item.id === requested.submissionId)?.reviewNote).toBe(requestMessage);

    const queue = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    const queuedIds = queue.submissions.map(item => item.id);
    expect(queuedIds).not.toContain(approved.submissionId);
    expect(queuedIds).not.toContain(rejected.submissionId);
    expect(queuedIds).toContain(requested.submissionId);

    const sessions = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(sessions.sessions.find(item => item.id === approved.sessionId)?.needsReviewCount).toBe(0);
    expect(sessions.sessions.find(item => item.id === rejected.sessionId)?.needsReviewCount).toBe(1);
    expect(sessions.sessions.find(item => item.id === requested.sessionId)?.needsReviewCount).toBe(1);

    const notifications = await responseJson(await request.get(`${API_URL}/tenant/notifications`, {
      headers: qaHeaders(qaNco)
    }));
    expect(notifications.notifications.some(item => (
      item.type === "proof_request" && item.submissionId === requested.submissionId
    ))).toBeTruthy();
  });

  test("review decisions and proof requests reject duplicate taps without freezing other rows", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `states-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const approved = await createPendingSubmission(request, `approve-${suffix}`);
    const requested = await createPendingSubmission(request, `request-${suffix}`);
    let approvalAttempts = 0;
    let requestAttempts = 0;

    await page.route(`**/api/submissions/${approved.submissionId}/review`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      approvalAttempts += 1;
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.route(`**/api/submissions/${requested.submissionId}/evidence-requests`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      requestAttempts += 1;
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });

    await signInAsPlatoonAdmin(page);
    await openReviewQueue(page);

    const approvedCard = page.locator(".review-card", { hasText: approved.packetLine });
    const requestedCard = page.locator(".review-card", { hasText: requested.packetLine });
    const approveButton = approvedCard.getByRole("button", { name: "Approve" });
    await approveButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => approvalAttempts).toBe(1);
    await expect(approvedCard.getByRole("button", { name: "Approving..." })).toBeDisabled();
    await expect(approvedCard.getByRole("button", { name: "More proof" })).toBeDisabled();
    await expect(approvedCard.getByRole("button", { name: "Reject" })).toBeDisabled();
    await expect(requestedCard.getByRole("button", { name: "Approve" })).toBeEnabled();
    await expect(approvedCard).toHaveCount(0);
    expect(approvalAttempts).toBe(1);

    await requestedCard.getByRole("button", { name: "More proof" }).click();
    const requestNote = requestedCard.getByLabel("Request note");
    await expect(requestedCard.getByRole("button", { name: "Request open" })).toBeDisabled();
    await expect(requestedCard.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(requestedCard.getByRole("button", { name: "Reject" })).toBeDisabled();
    await requestNote.fill(`Need another photo for ${suffix}.`);
    const sendButton = requestedCard.getByRole("button", { name: "Send request" });
    await sendButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => requestAttempts).toBe(1);
    await expect(requestedCard.getByRole("button", { name: "Sending request..." })).toBeDisabled();
    await expect(requestNote).toBeDisabled();
    await expect(requestedCard.getByRole("button", { name: "Serial photo" })).toBeDisabled();
    await expect(requestedCard.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(requestedCard.getByText(/Requested: Need another photo/)).toBeVisible();
    expect(requestAttempts).toBe(1);
  });
});
