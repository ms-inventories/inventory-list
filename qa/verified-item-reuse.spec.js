import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PHOTO_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const PHOTO_DATA_URL = `data:image/png;base64,${PHOTO_BUFFER.toString("base64")}`;

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

function qaHeaders() {
  return {
    "X-Dev-Sub": qaAdmin.sub,
    "X-Dev-Email": qaAdmin.email,
    "X-Dev-Name": qaAdmin.name,
    "X-Dev-Groups": qaAdmin.groups.join(","),
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

async function createSessionItem(request, { name, packetLine }) {
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(),
    data: { name, status: "active" }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: qaHeaders(),
    data: { packetLine, expectedQty: 1 }
  }));
  return {
    sessionId: session.session.id,
    sessionName: session.session.name,
    sessionItemId: item.sessionItem.id
  };
}

async function uploadEvidence(request, label) {
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(),
    data: {
      fileName: `${label}.png`,
      mimeType: "image/png",
      dataUrl: PHOTO_DATA_URL,
      caption: label,
      kind: "general",
      purpose: "evidence"
    }
  }));
  return upload.photo;
}

async function seedVerifiedRecord(request, { packetLine, suffix }) {
  const first = await createSessionItem(request, {
    name: `QA reuse source ${suffix}`,
    packetLine
  });
  const oldPhoto = await uploadEvidence(request, `saved-before-${suffix}`);
  const submission = await responseJson(await request.post(
    `${API_URL}/session-items/${first.sessionItemId}/submissions`,
    {
      headers: qaHeaders(),
      data: {
        status: "found",
        locationText: "Cage 12, upper shelf",
        serialNumber: `REUSE-${suffix.toUpperCase()}`,
        photos: [{
          uploadId: oldPhoto.uploadId,
          caption: oldPhoto.caption,
          kind: oldPhoto.kind
        }]
      }
    }
  ));
  const review = await responseJson(await request.patch(
    `${API_URL}/submissions/${submission.submission.id}/review`,
    {
      headers: qaHeaders(),
      data: {
        decision: "approved",
        saveItem: true,
        savedMediaUploadIds: [oldPhoto.uploadId]
      }
    }
  ));
  await responseJson(await request.patch(`${API_URL}/inventory/sessions/${first.sessionId}`, {
    headers: qaHeaders(),
    data: { status: "closed" }
  }));
  return { oldPhoto, savedItem: review.savedItem };
}

async function seedBrowserIdentity(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaAdmin);
}

async function openWorkspaceView(page, label, heading) {
  const menu = page.getByRole("button", { name: "Open workspace menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function expectContained(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
}

async function expectViewportContained(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectMinHeight(locator, minimum = 44) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box.height).toBeGreaterThanOrEqual(minimum);
}

test.describe("verified item reuse UI", () => {
  test("leader confirms a prior record and keeps chosen old and new proof in one approval", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const touchTargetMinimum = testInfo.project.name === "mobile-chrome" ? 44 : 32;
    const suffix = `${project}-${testInfo.workerIndex}-${Date.now()}`;
    const lin = `V${testInfo.workerIndex % 10}${String(Date.now() % 10000).padStart(4, "0")}`;
    const packetLine = `${lin} VERIFIED UI REUSE ${suffix.toUpperCase()}`;
    const newLocation = "Cage 12, issue counter";
    let activeSessionId = "";

    try {
      const source = await seedVerifiedRecord(request, { packetLine, suffix });
      const active = await createSessionItem(request, {
        name: `QA reuse active ${suffix}`,
        packetLine
      });
      activeSessionId = active.sessionId;

      await responseJson(await request.patch(`${API_URL}/session-items/${active.sessionItemId}/assignment`, {
        headers: qaHeaders(),
        data: { memberId: "self" }
      }));

      await seedBrowserIdentity(page);
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      await openWorkspaceView(page, "Inventory Sessions", "Sessions");

      const sessionButton = page.locator(".session-row", { hasText: active.sessionName });
      await expect(sessionButton).toBeVisible();
      await sessionButton.click();

      const matchBanner = page.locator(".prior-match-banner");
      await expect(matchBanner.getByText("1 possible previous record", { exact: true })).toBeVisible();
      await expectContained(page, matchBanner);
      const reviewMatches = matchBanner.getByRole("button", { name: "Review matches" });
      await expectMinHeight(reviewMatches, touchTargetMinimum);
      await reviewMatches.click();

      let drawer = page.getByRole("dialog", { name: packetLine });
      await expect(drawer).toBeVisible();
      await expectViewportContained(page, drawer);
      const matchCard = drawer.locator(".prior-match-card");
      await expect(matchCard.getByText("Cage 12, upper shelf", { exact: false })).toBeVisible();
      await expect(matchCard.getByRole("link", { name: "Open previous photo 1" })).toBeVisible();
      await expectContained(page, matchCard);

      const useRecord = matchCard.getByRole("button", { name: "Use this record" });
      const dismissRecord = matchCard.getByRole("button", { name: "Not the same item" });
      await expectMinHeight(useRecord, touchTargetMinimum);
      await expectMinHeight(dismissRecord, touchTargetMinimum);
      await useRecord.click();
      await expect(matchCard).toBeHidden();
      await expect(drawer.getByText("Saved record", { exact: true })).toBeVisible();

      await drawer.getByRole("button", { name: "Add proof" }).click();
      const proofForm = drawer.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      await expect(proofForm.getByLabel("Location", { exact: true })).toHaveValue("Cage 12, upper shelf");
      await expect(proofForm.getByText("Last saved at Cage 12, upper shelf", { exact: true })).toBeVisible();
      await proofForm.getByLabel("Location", { exact: true }).fill(newLocation);
      await proofForm.getByLabel("Serial number", { exact: true }).fill(`REUSE-${suffix.toUpperCase()}`);
      await proofForm.getByLabel("Add proof photos").setInputFiles({
        name: `new-proof-${suffix}.png`,
        mimeType: "image/png",
        buffer: PHOTO_BUFFER
      });

      const uploadResponsePromise = page.waitForResponse(response => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/uploads/photos"
        && response.ok()
      ));
      const submissionResponsePromise = page.waitForResponse(response => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/session-items/${active.sessionItemId}/submissions`
        && response.ok()
      ));
      await proofForm.getByRole("button", { name: "Submit", exact: true }).click();
      const uploadedPhoto = (await (await uploadResponsePromise).json()).photo;
      const submitted = await (await submissionResponsePromise).json();
      await expect(drawer).toBeHidden();

      await openWorkspaceView(page, "Review Queue", "Review Queue");
      const reviewCard = page.locator(".review-card", { hasText: packetLine });
      await expect(reviewCard).toBeVisible();
      await expectContained(page, reviewCard);

      const evidencePicker = reviewCard.locator(".saved-evidence-picker");
      const evidenceSummary = evidencePicker.locator("summary");
      await expect(evidenceSummary.getByText("Optional", { exact: true })).toBeVisible();
      await expectMinHeight(evidenceSummary, touchTargetMinimum);
      await evidenceSummary.click();

      const saveRecord = evidencePicker.getByRole("checkbox", { name: /Save or update this item/ });
      await expect(saveRecord).not.toBeChecked();
      await expectMinHeight(evidencePicker.locator(".saved-evidence-enable"), touchTargetMinimum);
      await saveRecord.check();
      await expect(evidenceSummary.getByText("2/3 photos", { exact: true })).toBeVisible();

      const savedOption = evidencePicker.locator(".saved-evidence-option", { hasText: "Saved" });
      const newOption = evidencePicker.locator(".saved-evidence-option", { hasText: "New" });
      const savedCheckbox = savedOption.getByRole("checkbox");
      const newCheckbox = newOption.getByRole("checkbox");
      await expect(savedCheckbox).toBeChecked();
      await expect(newCheckbox).toBeChecked();
      await expectMinHeight(savedOption, touchTargetMinimum);
      await expectMinHeight(newOption, touchTargetMinimum);
      await expectContained(page, evidencePicker);

      await savedCheckbox.uncheck();
      await expect(evidenceSummary.getByText("1/3 photos", { exact: true })).toBeVisible();
      await savedCheckbox.check();
      await newCheckbox.uncheck();
      await expect(evidenceSummary.getByText("1/3 photos", { exact: true })).toBeVisible();
      await newCheckbox.check();
      await expect(evidenceSummary.getByText("2/3 photos", { exact: true })).toBeVisible();

      let reviewRequests = 0;
      page.on("request", browserRequest => {
        if (
          browserRequest.method() === "PATCH"
          && new URL(browserRequest.url()).pathname === `/api/submissions/${submitted.submission.id}/review`
        ) {
          reviewRequests += 1;
        }
      });
      await reviewCard.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByText(`Approved proof for ${packetLine}.`, { exact: true })).toBeVisible();
      await expect(reviewCard).toHaveCount(0);
      expect(reviewRequests).toBe(1);

      const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${active.sessionId}`, {
        headers: qaHeaders()
      }));
      const finalItem = detail.items.find(item => item.id === active.sessionItemId);
      expect(finalItem.inventoryItem).toMatchObject({
        id: source.savedItem.id,
        currentLocation: newLocation,
        serialNumber: `REUSE-${suffix.toUpperCase()}`
      });
      expect(finalItem.inventoryItem.photos.map(photo => photo.mediaUploadId)).toEqual([
        source.oldPhoto.uploadId,
        uploadedPhoto.uploadId
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
    } finally {
      if (activeSessionId) {
        await request.patch(`${API_URL}/inventory/sessions/${activeSessionId}`, {
          headers: qaHeaders(),
          data: { status: "closed" }
        });
      }
    }
  });
});
