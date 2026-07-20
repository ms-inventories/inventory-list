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
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open review queue", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Review queue", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Review queue", exact: true })).toBeVisible();
}

async function loadSessionDetail(request, record) {
  return responseJson(await request.get(`${API_URL}/inventory/sessions/${record.sessionId}`, {
    headers: qaHeaders(qaAdmin)
  }));
}

test.describe("review queue decisions", () => {
  test("dashboard proof opens one concise review in a modal without duplicating the queue", async ({ page, request }, testInfo) => {
    const suffix = `modal-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const pending = await createPendingSubmission(request, suffix);

    await signInAsPlatoonAdmin(page);
    const dashboardReview = page.getByRole("region", { name: "Dashboard review results" });
    await expect(dashboardReview.getByRole("button", { name: "Open review queue", exact: true })).toHaveCount(0);
    const dashboardRow = dashboardReview.locator(".review-row", { hasText: pending.packetLine });
    const reviewProofButton = dashboardRow.getByRole("button", { name: "Review proof", exact: true });
    await expect(reviewProofButton).toBeVisible();
    await reviewProofButton.click();

    const dialog = page.getByRole("dialog", { name: "Review proof", exact: true });
    await expect(dialog).toBeVisible();
    const reviewCard = dialog.locator(".review-card", { hasText: pending.packetLine });
    await expect(reviewCard).toBeVisible();
    await expect(dialog.locator(".review-card")).toHaveCount(1);
    if (testInfo.project.name === "mobile-chrome") {
      for (const label of ["Submission", "Evidence", "Decision"]) {
        await expect(reviewCard.locator(".queue-cell-label").getByText(label, { exact: true })).toBeVisible();
      }
    }
    await expect(page.locator(".embedded-workspace-panel").filter({ hasText: "Review Queue" })).toHaveCount(0);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();

    await dialog.getByRole("button", { name: "Close review", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(reviewProofButton).toBeFocused();
    await expect(page).toHaveURL(/#\/admin$/);
  });

  test("approve and both rejection return routes update every dependent state", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
    const approved = await createPendingSubmission(request, `approve-${suffix}`);
    const rejected = await createPendingSubmission(request, `reject-${suffix}`);
    const returned = await createPendingSubmission(request, `return-${suffix}`);

    await signInAsPlatoonAdmin(page);
    await openReviewQueue(page);

    const approvedCard = page.locator(".review-card", { hasText: approved.packetLine });
    const rejectedCard = page.locator(".review-card", { hasText: rejected.packetLine });
    const returnedCard = page.locator(".review-card", { hasText: returned.packetLine });
    const reviewDialog = page.getByRole("dialog", { name: "Review queue", exact: true });
    const reviewHeader = reviewDialog.locator(".review-list-table-head");
    await expect(approvedCard).toBeVisible();
    await expect(rejectedCard).toBeVisible();
    await expect(returnedCard).toBeVisible();
    expect(await reviewDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    if (testInfo.project.name === "mobile-chrome") {
      await expect(reviewHeader).toBeHidden();
      for (const card of [approvedCard, rejectedCard, returnedCard]) {
        for (const label of ["Submission", "Evidence", "Decision"]) {
          await expect(card.locator(".queue-cell-label").getByText(label, { exact: true })).toBeVisible();
        }
      }
    } else {
      await expect(reviewHeader).toBeVisible();
      await expect(reviewHeader).toContainText("Submission");
      await expect(reviewHeader).toContainText("Evidence");
      await expect(reviewHeader).toContainText("Decision");
      const [headerTracks, rowTracks] = await Promise.all([
        reviewHeader.evaluate(element => getComputedStyle(element).gridTemplateColumns),
        approvedCard.evaluate(element => getComputedStyle(element).gridTemplateColumns)
      ]);
      expect(rowTracks).toBe(headerTracks);
    }
    await approvedCard.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(`Approved proof for ${approved.packetLine}.`)).toBeVisible();
    await expect(approvedCard).toHaveCount(0);

    await rejectedCard.getByRole("button", { name: "Reject" }).click();
    await expect(rejectedCard.getByLabel("Reason for rejection")).toHaveValue("");
    await rejectedCard.getByLabel("Reason for rejection").fill(`Wrong item for ${suffix}.`);
    await rejectedCard.getByRole("checkbox", { name: /Keep assigned to the submitter/ }).uncheck();
    await rejectedCard.getByRole("button", { name: "Reject with reason" }).click();
    await expect(page.getByText(`Rejected proof for ${rejected.packetLine}.`)).toBeVisible();
    await expect(rejectedCard).toHaveCount(0);

    const returnMessage = `Need a closer item photo for ${suffix}.`;
    await returnedCard.getByRole("button", { name: "Reject" }).click();
    await returnedCard.getByLabel("Reason for rejection").fill(returnMessage);
    await expect(returnedCard.getByRole("checkbox", { name: /Keep assigned to the submitter/ })).toBeChecked();
    await returnedCard.getByRole("button", { name: "Reject with reason" }).click();
    await expect(page.getByText(`Rejected proof for ${returned.packetLine}.`)).toBeVisible();
    await expect(returnedCard).toHaveCount(0);

    const approvedDetail = await loadSessionDetail(request, approved);
    const approvedItem = approvedDetail.items.find(item => item.id === approved.sessionItemId);
    expect(approvedItem.status).toBe("approved");
    expect(approvedItem.submissions.find(item => item.id === approved.submissionId)?.reviewState).toBe("approved");
    expect(approvedItem.inventoryItem?.title).toBe(approved.packetLine);
    const savedItems = await responseJson(await request.get(`${API_URL}/inventory/items`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(savedItems.items.some(item => item.title === approved.packetLine)).toBeTruthy();

    const rejectedDetail = await loadSessionDetail(request, rejected);
    const rejectedItem = rejectedDetail.items.find(item => item.id === rejected.sessionItemId);
    expect(rejectedItem.status).toBe("unchecked");
    expect(rejectedItem.assignedToEmail).toBeFalsy();
    expect(rejectedItem.submissions.find(item => item.id === rejected.submissionId)?.reviewState).toBe("rejected");

    const returnedDetail = await loadSessionDetail(request, returned);
    const returnedItem = returnedDetail.items.find(item => item.id === returned.sessionItemId);
    expect(returnedItem.status).toBe("unchecked");
    expect(returnedItem.assignedToEmail).toBe(qaNco.email);
    expect(returnedItem.submissions.find(item => item.id === returned.submissionId)?.reviewState).toBe("rejected");
    expect(returnedItem.submissions.find(item => item.id === returned.submissionId)?.reviewNote).toBe(returnMessage);

    const queue = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
      headers: qaHeaders(qaAdmin)
    }));
    const queuedIds = queue.submissions.map(item => item.id);
    expect(queuedIds).not.toContain(approved.submissionId);
    expect(queuedIds).not.toContain(rejected.submissionId);
    expect(queuedIds).not.toContain(returned.submissionId);

    const sessions = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(sessions.sessions.find(item => item.id === approved.sessionId)?.needsReviewCount).toBe(0);
    expect(sessions.sessions.find(item => item.id === rejected.sessionId)?.needsReviewCount).toBe(0);
    expect(sessions.sessions.find(item => item.id === returned.sessionId)?.needsReviewCount).toBe(0);

    const notifications = await responseJson(await request.get(`${API_URL}/tenant/notifications`, {
      headers: qaHeaders(qaNco)
    }));
    expect(notifications.notifications.some(item => (
      item.type === "proof_rejected" && item.submissionId === returned.submissionId
    ))).toBeTruthy();
  });

  test("review decisions and rejection returns reject duplicate taps without freezing other rows", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `states-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const approved = await createPendingSubmission(request, `approve-${suffix}`);
    const returned = await createPendingSubmission(request, `return-${suffix}`);
    let approvalAttempts = 0;
    let returnAttempts = 0;

    await page.route(`**/api/submissions/${approved.submissionId}/review`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      approvalAttempts += 1;
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.route(`**/api/submissions/${returned.submissionId}/review`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      returnAttempts += 1;
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await route.continue();
    });

    await signInAsPlatoonAdmin(page);
    await openReviewQueue(page);

    const approvedCard = page.locator(".review-card", { hasText: approved.packetLine });
    const returnedCard = page.locator(".review-card", { hasText: returned.packetLine });
    const approveButton = approvedCard.getByRole("button", { name: "Approve" });
    await approveButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => approvalAttempts).toBe(1);
    await expect(approvedCard.getByRole("button", { name: "Approving..." })).toBeDisabled();
    await expect(approvedCard.getByRole("button", { name: "Reject" })).toBeDisabled();
    await expect(returnedCard.getByRole("button", { name: "Approve" })).toBeEnabled();
    await expect(approvedCard).toHaveCount(0);
    expect(approvalAttempts).toBe(1);

    await returnedCard.getByRole("button", { name: "Reject" }).click();
    const returnNote = returnedCard.getByLabel("Reason for rejection");
    await expect(returnNote).toHaveValue("");
    await expect(returnedCard.getByRole("button", { name: "Reason open" })).toBeDisabled();
    await expect(returnedCard.getByRole("button", { name: "Approve" })).toBeDisabled();
    await returnNote.fill(`Need another photo for ${suffix}.`);
    const sendButton = returnedCard.getByRole("button", { name: "Reject with reason" });
    await sendButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => returnAttempts).toBe(1);
    await expect(returnedCard.getByRole("button", { name: "Approve" })).toBeDisabled();
    await expect(returnedCard.getByRole("button", { name: "Reject" })).toBeDisabled();
    await expect(returnedCard).toHaveCount(0);
    expect(returnAttempts).toBe(1);
  });
});
