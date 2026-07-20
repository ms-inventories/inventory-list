import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

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

function testSuffix(testInfo, label) {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${label}-${project}-${testInfo.workerIndex}-${Date.now()}`;
}

function syntheticPlatformAdmin(suffix) {
  return {
    sub: `qa-claim-root-${suffix}`,
    email: `qa-claim-root-${suffix}@876en.test`,
    name: `QA Claim Root ${suffix}`,
    groups: ["876en-admins"]
  };
}

async function createSessionItem(request, identity, suffix) {
  const sessionData = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity),
    data: { name: `QA claim ${suffix}`, status: "active" }
  }));
  const itemData = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionData.session.id}/items`, {
    headers: qaHeaders(identity),
    data: { packetLine: `QA-CLAIM-${suffix.toUpperCase()}`, expectedQty: 1 }
  }));

  return {
    sessionId: sessionData.session.id,
    sessionItemId: itemData.sessionItem.id
  };
}

async function sessionItem(request, scenario, identity = qaAdmin) {
  const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
    headers: qaHeaders(identity)
  }));
  return detail.items.find(item => item.id === scenario.sessionItemId);
}

async function closeSession(request, scenario, identity) {
  if (!scenario?.sessionId) return;
  try {
    await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(identity),
      data: { status: "closed" }
    });
  } catch (error) {
    if (/Target page, context or browser has been closed|Test ended/i.test(String(error?.message || error))) return;
    throw error;
  }
}

async function seedBrowserIdentity(page, identity) {
  await page.addInitScript(value => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(value));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

async function openReviewQueue(page) {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open review queue", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Review queue", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Review queue", exact: true })).toBeVisible();
}

test.describe("session claim API", () => {
  test("resolves a synthetic platform membership self claim to the authenticated user", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "synthetic");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);
    const me = await responseJson(await request.get(`${API_URL}/me`, {
      headers: qaHeaders(platformAdmin)
    }));

    expect(me.membership.id).toBe("authentik:ms:platform-admin");
    expect(me.membership.user_id).toBe(me.user.id);

    const claim = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(platformAdmin),
      data: { memberId: "self" }
    }));

    expect(claim.assignment.assignedTo).toBe(me.user.id);
    expect(claim.assignment.assignedToEmail).toBe(platformAdmin.email);
    expect(claim.assignment.assignedToName).toBe(platformAdmin.name);

    const saved = await sessionItem(request, scenario, platformAdmin);
    expect(saved.assignedTo).toBe(me.user.id);
    expect(saved.assignedToEmail).toBe(platformAdmin.email);
    await closeSession(request, scenario, platformAdmin);
  });

  test("preserves the first owner when another user tries to self claim", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "conflict");
    const scenario = await createSessionItem(request, qaAdmin, suffix);
    const challenger = syntheticPlatformAdmin(`${suffix}-challenger`);

    const firstClaim = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    expect(firstClaim.assignment.assignedToEmail).toBe(qaNco.email);

    const conflictingClaim = await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(challenger),
      data: { memberId: "self" }
    });
    expect(conflictingClaim.status()).toBe(409);
    expect(await conflictingClaim.json()).toMatchObject({
      code: "conflict",
      error: "This row is already assigned to another user."
    });

    const saved = await sessionItem(request, scenario);
    expect(saved.assignedTo).toBe(firstClaim.assignment.assignedTo);
    expect(saved.assignedToEmail).toBe(qaNco.email);
    await closeSession(request, scenario, qaAdmin);
  });

  test("keeps UUID reassignment admin-only while owners can release their item", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "authorization");
    const scenario = await createSessionItem(request, qaAdmin, suffix);
    const memberData = await responseJson(await request.get(`${API_URL}/tenant/members`, {
      headers: qaHeaders(qaAdmin)
    }));
    const ncoMember = memberData.members.find(member => member.email === qaNco.email);
    const adminMember = memberData.members.find(member => member.email === qaAdmin.email);
    expect(ncoMember?.id).toBeTruthy();
    expect(adminMember?.id).toBeTruthy();

    const assigned = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaAdmin),
      data: { memberId: ncoMember.id }
    }));
    expect(assigned.assignment.assignedToEmail).toBe(qaNco.email);

    const contributorClear = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: null }
    }));
    expect(contributorClear.assignment.assignedTo).toBeNull();
    expect(contributorClear.assignment.assignedToEmail).toBeNull();

    const contributorReassign = await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: adminMember.id }
    });
    expect(contributorReassign.status()).toBe(403);
    expect(await contributorReassign.json()).toMatchObject({ code: "access_denied" });

    const released = await sessionItem(request, scenario);
    expect(released.assignedTo).toBeNull();
    expect(released.assignedToEmail).toBeNull();

    const cleared = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaAdmin),
      data: { memberId: null }
    }));
    expect(cleared.assignment.assignedTo).toBeNull();
    expect(cleared.assignment.assignedToEmail).toBeNull();
    await closeSession(request, scenario, qaAdmin);
  });

  test("synthetic users can claim inline and explicitly continue into proof", async ({ page, request }, testInfo) => {
    const suffix = testSuffix(testInfo, "ui");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);

    try {
      await seedBrowserIdentity(page, platformAdmin);
      await page.goto("http://ms.localhost:5175/#/admin");
      await page.getByRole("heading", { name: "Leader Dashboard" }).waitFor();

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      await selector.selectOption(scenario.sessionId);
      await activeInventory.getByRole("button", { name: "Open session" }).click();

      let row = page.locator(".session-item", { hasText: `QA-CLAIM-${suffix.toUpperCase()}` });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await row.getByRole("button", { name: "Claim item", exact: true }).click();
      await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item claimed. It is now in Mine.");
      await expect(page.getByRole("dialog"), "claiming must not open an item or proof dialog").toHaveCount(0);
      await expect(page.locator(".proof-form")).toHaveCount(0);

      row = page.locator(".session-item", { hasText: `QA-CLAIM-${suffix.toUpperCase()}` });
      await expect(row.getByRole("button", { name: "Add proof", exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Add proof", exact: true }).click();
      const proofDialog = page.getByRole("dialog", { name: `Add proof for QA-CLAIM-${suffix.toUpperCase()}` });
      const proofForm = proofDialog.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      const outcome = proofForm.getByRole("combobox", { name: "Inventory result" });
      await expect(outcome).toHaveValue("found");
      await outcome.selectOption("not_found");
      await expect(outcome).toHaveValue("not_found");
      await expect(proofForm.getByRole("textbox", { name: "Location" })).toBeVisible();
      await expect(proofForm.getByRole("textbox", { name: "Serial number (if serialized)" })).toBeVisible();
      await expect(proofForm.getByRole("textbox", { name: "Note" })).toBeVisible();
      const photoInput = proofForm.getByLabel("Add item photos");
      await expect(photoInput).toBeEnabled();
      await expect(photoInput).toHaveAttribute("multiple", "");
      const dialogBeforePhotos = await proofDialog.boundingBox();
      const photoNames = Array.from({ length: 11 }, (_, index) =>
        `proof-photo-${index}-with-an-intentionally-long-filename-that-must-not-expand-the-proof-dialog.jpg`
      );
      await photoInput.setInputFiles(photoNames.map(name => ({
        name,
        mimeType: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      })));
      const selectedPhotos = proofForm.getByRole("list", { name: "Selected proof photos" });
      await expect(selectedPhotos.getByRole("listitem")).toHaveCount(10);
      await expect(proofForm.getByLabel("Add another item photo")).toBeDisabled();
      for (const name of photoNames.slice(0, 10)) {
        await expect(proofForm.getByText(name, { exact: true })).toBeVisible();
      }
      await expect(proofForm.getByText(photoNames[10], { exact: true })).toHaveCount(0);
      await expect(proofDialog.getByText("You can submit up to 10 photos for review.", { exact: true })).toBeVisible();
      const viewport = page.viewportSize();
      const dialogBox = await proofDialog.boundingBox();
      expect(Math.abs(dialogBox.x - dialogBeforePhotos.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(dialogBox.y - dialogBeforePhotos.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(dialogBox.width - dialogBeforePhotos.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(dialogBox.height - dialogBeforePhotos.height)).toBeLessThanOrEqual(1);
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(dialogBox.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await proofDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      expect(await proofForm.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )).toBeTruthy();
      const workspace = page.getByRole("region", { name: "Inventory workspace" });
      await expect(workspace.getByRole("group", { name: "Work assignment lists" }).getByRole("button", { name: /^Mine\b/ })).toHaveClass(/active/);
      await expect(page.getByText("Validation failed", { exact: true })).toHaveCount(0);

      const saved = await sessionItem(request, scenario, platformAdmin);
      expect(saved.assignedToEmail).toBe(platformAdmin.email);
    } finally {
      await closeSession(request, scenario, platformAdmin);
    }
  });

  test("submits note-only accountability evidence and approves it with no saved photos", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = testSuffix(testInfo, "note-only-ui");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);
    const packetLine = `QA-CLAIM-${suffix.toUpperCase()}`;
    const accountabilityNote = "Verified with supply; signed out to SGT Smith for maintenance.";
    let uploadRequests = 0;
    let submissionRequests = 0;

    page.on("request", browserRequest => {
      const pathname = new URL(browserRequest.url()).pathname;
      if (browserRequest.method() === "POST" && pathname === "/api/uploads/photos") {
        uploadRequests += 1;
      }
      if (
        browserRequest.method() === "POST"
        && pathname === `/api/session-items/${scenario.sessionItemId}/submissions`
      ) {
        submissionRequests += 1;
      }
    });

    try {
      await seedBrowserIdentity(page, platformAdmin);
      await page.goto("http://ms.localhost:5175/#/admin");
      await page.getByRole("heading", { name: "Leader Dashboard" }).waitFor();

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      await activeInventory.getByRole("combobox", { name: "Active inventory" }).selectOption(scenario.sessionId);
      await activeInventory.getByRole("button", { name: "Open session" }).click();

      let row = page.locator(".session-item", { hasText: packetLine });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await row.getByRole("button", { name: "Claim item", exact: true }).click();
      await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item claimed. It is now in Mine.");
      await expect(page.getByRole("dialog"), "claiming must not open a proof form").toHaveCount(0);
      row = page.locator(".session-item", { hasText: packetLine });
      await row.getByRole("button", { name: "Add proof", exact: true }).click();
      const proofDialog = page.getByRole("dialog", { name: `Add proof for ${packetLine}` });
      const proofForm = proofDialog.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      await test.step("reject empty evidence without any API write", async () => {
        await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
        await expect(proofDialog.getByText(
          "Add an item photo, or explain who verified the item and why it is accounted for.",
          { exact: true }
        )).toBeVisible();
        expect(uploadRequests).toBe(0);
        expect(submissionRequests).toBe(0);
      });

      await proofForm.getByLabel("Location", { exact: true }).fill("Maintenance shop");
      await proofForm.getByLabel("Serial number (if serialized)", { exact: true }).fill("N/A");
      await proofForm.getByRole("textbox", { name: /^Note\b/ }).fill(accountabilityNote);

      let submitted;
      await test.step("submit the accountability note without an upload", async () => {
        const submissionRequestPromise = page.waitForRequest(browserRequest => (
          browserRequest.method() === "POST"
          && new URL(browserRequest.url()).pathname === `/api/session-items/${scenario.sessionItemId}/submissions`
        ));
        const submissionResponsePromise = page.waitForResponse(response => (
          response.request().method() === "POST"
          && new URL(response.url()).pathname === `/api/session-items/${scenario.sessionItemId}/submissions`
          && response.ok()
        ));
        await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();

        const submissionRequest = await submissionRequestPromise;
        expect(submissionRequest.postDataJSON()).toMatchObject({
          status: "found",
          locationText: "Maintenance shop",
          note: accountabilityNote,
          photos: []
        });
        expect(submissionRequest.postDataJSON().serialNumber).toBeUndefined();
        submitted = await (await submissionResponsePromise).json();
        await expect(proofDialog).toBeHidden();
        expect(uploadRequests).toBe(0);
        expect(submissionRequests).toBe(1);
      });

      await test.step("approve while saving zero reference photos", async () => {
        await openReviewQueue(page);

        const reviewCard = page.locator(".review-card", { hasText: packetLine });
        await expect(reviewCard).toBeVisible();
        await expect(reviewCard.getByText("Accountability note", { exact: true })).toBeVisible();
        await expect(reviewCard.getByText(accountabilityNote, { exact: true })).toBeVisible();
        await expect(reviewCard.locator(".proof-photo-thumbnail")).toHaveCount(0);

        const evidencePicker = reviewCard.locator(".saved-evidence-picker");
        await evidencePicker.locator("summary").click();
        const updateReferenceRecord = evidencePicker.getByRole("checkbox", {
          name: /Update this item's reference record/
        });
        await updateReferenceRecord.check();
        await expect(evidencePicker.getByText("0/3 selected", { exact: true })).toBeVisible();
        await expect(evidencePicker.locator(".saved-evidence-option")).toHaveCount(0);
        await expect(evidencePicker.getByText(
          "No item photos are available. The approved location and serial, when applicable, can still be carried forward.",
          { exact: true }
        )).toBeVisible();

        const reviewRequestPromise = page.waitForRequest(browserRequest => (
          browserRequest.method() === "PATCH"
          && new URL(browserRequest.url()).pathname === `/api/submissions/${submitted.submission.id}/review`
        ));
        const reviewResponsePromise = page.waitForResponse(response => (
          response.request().method() === "PATCH"
          && new URL(response.url()).pathname === `/api/submissions/${submitted.submission.id}/review`
          && response.ok()
        ));
        await reviewCard.getByRole("button", { name: "Approve", exact: true }).click();

        const reviewRequest = await reviewRequestPromise;
        expect(reviewRequest.postDataJSON()).toMatchObject({
          decision: "approved",
          saveItem: true,
          savedMediaUploadIds: []
        });
        const approved = await (await reviewResponsePromise).json();
        expect(approved.savedItem.photos).toEqual([]);
        await expect(page.getByText(`Approved proof for ${packetLine}.`, { exact: true })).toBeVisible();
        await expect(reviewCard).toHaveCount(0);
      });
    } finally {
      await closeSession(request, scenario, platformAdmin);
    }
  });

  test("treats a nonserialized evidence upload as an item photo", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = testSuffix(testInfo, "nonserialized-photo-ui");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);
    const packetLine = `QA-CLAIM-${suffix.toUpperCase()}`;

    try {
      await seedBrowserIdentity(page, platformAdmin);
      await page.goto("http://ms.localhost:5175/#/admin");
      await page.getByRole("heading", { name: "Leader Dashboard" }).waitFor();

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      await activeInventory.getByRole("combobox", { name: "Active inventory" }).selectOption(scenario.sessionId);
      await activeInventory.getByRole("button", { name: "Open session" }).click();

      let row = page.locator(".session-item", { hasText: packetLine });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await row.getByRole("button", { name: "Claim item", exact: true }).click();
      await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item claimed. It is now in Mine.");
      await expect(page.getByRole("dialog"), "claiming must not open a proof form").toHaveCount(0);
      row = page.locator(".session-item", { hasText: packetLine });
      await row.getByRole("button", { name: "Add proof", exact: true }).click();
      const proofDialog = page.getByRole("dialog", { name: `Add proof for ${packetLine}` });
      const proofForm = proofDialog.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      await proofForm.getByLabel("Serial number (if serialized)", { exact: true }).fill("N/A");
      await proofForm.getByLabel("Add item photos").setInputFiles({
        name: `nonserialized-item-${suffix}.jpg`,
        mimeType: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      });

      const uploadRequestPromise = page.waitForRequest(browserRequest => (
        browserRequest.method() === "POST"
        && new URL(browserRequest.url()).pathname === "/api/uploads/photos"
      ));
      const submissionRequestPromise = page.waitForRequest(browserRequest => (
        browserRequest.method() === "POST"
        && new URL(browserRequest.url()).pathname === `/api/session-items/${scenario.sessionItemId}/submissions`
      ));
      const submissionResponsePromise = page.waitForResponse(response => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/session-items/${scenario.sessionItemId}/submissions`
        && response.ok()
      ));
      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();

      const uploadRequest = await uploadRequestPromise;
      expect(uploadRequest.postDataJSON()).toMatchObject({ kind: "general" });
      const submissionRequest = await submissionRequestPromise;
      const submissionPayload = submissionRequest.postDataJSON();
      expect(submissionPayload.serialNumber).toBeUndefined();
      expect(submissionPayload.photos).toHaveLength(1);
      expect(submissionPayload.photos[0]).toMatchObject({ kind: "general" });
      const submitted = await (await submissionResponsePromise).json();
      await expect(proofDialog).toBeHidden();

      await openReviewQueue(page);
      const reviewCard = page.locator(".review-card", { hasText: packetLine });
      await expect(reviewCard).toBeVisible();
      await expect(reviewCard.getByRole("button", { name: "View Item photo", exact: true })).toBeVisible();
      await expect(reviewCard.getByText("Item photo", { exact: true })).toBeVisible();
      await expect(reviewCard.getByText(/^Serial:/)).toHaveCount(0);

      const reviewResponsePromise = page.waitForResponse(response => (
        response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/submissions/${submitted.submission.id}/review`
        && response.ok()
      ));
      await reviewCard.getByRole("button", { name: "Approve", exact: true }).click();
      await reviewResponsePromise;
      await expect(page.getByText(`Approved proof for ${packetLine}.`, { exact: true })).toBeVisible();
      await expect(reviewCard).toHaveCount(0);
    } finally {
      await closeSession(request, scenario, platformAdmin);
    }
  });
});
