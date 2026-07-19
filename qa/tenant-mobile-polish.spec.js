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

const qaWorker = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

function qaHeaders(identity = qaAdmin) {
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

async function seedBrowserIdentity(page, identity = qaAdmin) {
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

async function openWorkspaceView(page, name) {
  const toggle = page.getByRole("button", { name: "Open workspace menu" });
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
  const item = page.getByRole("button", { name, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

async function openSessionsFromNotifications(page) {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open sessions", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
}

async function expectContained(locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
}

async function expectInsideHorizontally(container, child) {
  await expect(container).toBeVisible();
  await expect(child).toBeVisible();
  const [containerBox, childBox] = await Promise.all([container.boundingBox(), child.boundingBox()]);
  expect(childBox.x).toBeGreaterThanOrEqual(containerBox.x - 1);
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 1);
}

async function expectMinTargetSize(locator, { width = 0, height = 44 } = {}) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(width);
  expect(box.height).toBeGreaterThanOrEqual(height);
}

function scenarioSuffix(testInfo, label) {
  return `${label}-${testInfo.workerIndex}-${Date.now()}`;
}

async function createSession(request, name, status = "active") {
  return (await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(),
    data: { name, status }
  }))).session;
}

async function createItem(request, sessionId, packetLine) {
  return (await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionId}/items`, {
    headers: qaHeaders(),
    data: {
      packetLine,
      expectedQty: 1,
      locationHint: `QA location for ${packetLine}`
    }
  }))).sessionItem;
}

async function assignItem(request, itemId, identity) {
  await responseJson(await request.patch(`${API_URL}/session-items/${itemId}/assignment`, {
    headers: qaHeaders(identity),
    data: { memberId: "self" }
  }));
}

async function submitFoundProof(request, itemId, marker) {
  await assignItem(request, itemId, qaWorker);
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(qaWorker),
    data: {
      fileName: `${marker}.png`,
      mimeType: "image/png",
      dataUrl: PHOTO_DATA_URL,
      caption: `Mobile preview proof ${marker}`,
      kind: "general",
      purpose: "evidence"
    }
  }));
  return (await responseJson(await request.post(`${API_URL}/session-items/${itemId}/submissions`, {
    headers: qaHeaders(qaWorker),
    data: {
      status: "found",
      locationText: `Mobile QA location ${marker}`,
      note: `Mobile QA proof ${marker}`,
      photos: [{ uploadId: upload.photo.uploadId, kind: "general" }]
    }
  }))).submission;
}

async function closeSession(request, sessionId) {
  if (!sessionId) return;
  await request.patch(`${API_URL}/inventory/sessions/${sessionId}`, {
    headers: qaHeaders(),
    data: { status: "closed" }
  });
}

async function approveAndCloseScenario(request, scenario) {
  if (!scenario) return;
  for (const submissionId of scenario.submissionIds || []) {
    await request.patch(`${API_URL}/submissions/${submissionId}/review`, {
      headers: qaHeaders(),
      data: { decision: "approved", note: "QA mobile preview cleanup." }
    });
  }
  await closeSession(request, scenario.sessionId);
}

function selectedPhoto(name) {
  return {
    name,
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  };
}

test.describe("tenant mobile and tablet polish", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Explicit viewport coverage runs once in Chromium.");
  });

  test("Reports fully converts to contained cards at the 800px drawer breakpoint", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const suffix = scenarioSuffix(testInfo, "reports-card");
    const session = await createSession(request, `QA mobile reports ${suffix}`);
    const packetLine = `QA-MOBILE-REPORT-${suffix.toUpperCase()}`;
    await createItem(request, session.id, packetLine);

    try {
      await seedBrowserIdentity(page);
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      await openWorkspaceView(page, "Reports");
      await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();

      await page.getByRole("combobox", { name: "Session", exact: true }).selectOption(session.id);
      const results = page.getByRole("region", { name: "Report results" });
      const row = results.locator(".reports-table-row", { hasText: packetLine });
      await expect(row).toBeVisible();
      await expect(results.locator(".reports-table-header")).toBeHidden();
      for (const label of ["Session", "Item", "Outcome", "Proof status", "Location / serial"]) {
        await expect(row.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
      }

      expect(await row.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
      await expectContained(results);
      await expectContained(row);
      await expectInsideHorizontally(results, row);
      await expectContained(page.locator("main"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
    } finally {
      await closeSession(request, session.id);
    }
  });

  test("mobile dashboard keeps work claimable and limits both previews to three rows", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 360, height: 740 });
    const suffix = scenarioSuffix(testInfo, "dashboard-preview");
    const scenario = { sessionId: "", submissionIds: [] };

    try {
      const session = await createSession(request, `QA mobile dashboard ${suffix}`);
      scenario.sessionId = session.id;
      for (let index = 0; index < 10; index += 1) {
        const marker = `QA-MOBILE-PREVIEW-${suffix.toUpperCase()}-${index + 1}`;
        const item = await createItem(request, session.id, marker);
        if (index < 4) {
          const submission = await submitFoundProof(request, item.id, `${suffix}-${index + 1}`);
          scenario.submissionIds.push(submission.id);
        } else {
          await assignItem(request, item.id, qaAdmin);
        }
      }

      await seedBrowserIdentity(page);
      const sessionPayload = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders()
      }));
      const reviewPayload = await responseJson(await request.get(`${API_URL}/inventory/review-queue`, {
        headers: qaHeaders()
      }));
      await page.route("**/api/inventory/sessions", async route => {
        if (route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...sessionPayload,
            sessions: (sessionPayload.sessions || []).filter(candidate => candidate.id === session.id)
          })
        });
      });
      await page.route("**/api/inventory/review-queue", async route => {
        if (route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...reviewPayload,
            submissions: (reviewPayload.submissions || []).filter(submission => submission.session?.id === session.id)
          })
        });
      });
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

      await expect(page.getByRole("region", { name: "Active inventory" })).toContainText(session.name);

      const workCard = page.getByRole("region", { name: "Pending inventory results" });
      await expect(workCard).toBeVisible();
      await expect(workCard.locator(".leader-table-row")).toHaveCount(3);
      await expect(workCard.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);

      const reviewCard = page.getByRole("region", { name: "Dashboard review results" });
      await expect(reviewCard.locator(".leader-table-row")).toHaveCount(3);
      for (const card of [workCard, reviewCard]) {
        await expectContained(card);
        for (const row of await card.locator(".leader-table-row").all()) {
          await expectInsideHorizontally(card, row);
        }
      }
      await expectContained(page.locator("main"));
    } finally {
      await approveAndCloseScenario(request, scenario);
    }
  });

  test("reachable Team, search, inline item controls, and proof controls meet 44px touch targets", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 412, height: 915 });
    const suffix = scenarioSuffix(testInfo, "touch-targets");
    const session = await createSession(request, `QA mobile touch ${suffix}`);
    const packetLine = `QA-MOBILE-TOUCH-${suffix.toUpperCase()}`;
    const item = await createItem(request, session.id, packetLine);
    await assignItem(request, item.id, qaAdmin);
    const archivedSession = await createSession(request, `QA archived mobile ${suffix}`);
    await closeSession(request, archivedSession.id);

    try {
      await seedBrowserIdentity(page);
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

      await openWorkspaceView(page, "Team");
      await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
      const teammateSearch = page.getByRole("searchbox", { name: "Search teammates" });
      await teammateSearch.fill("QA");
      const clearSearch = page.getByRole("button", { name: "Clear search" });
      await expectMinTargetSize(clearSearch, { width: 44, height: 44 });
      await clearSearch.click();

      const manage = page.locator(".team-member-manage > summary").first();
      await expectMinTargetSize(manage);
      await manage.click();
      await expectMinTargetSize(page.locator(".team-member-manage .member-role-select").first());

      await openSessionsFromNotifications(page);
      await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
      const sessionList = page.locator(".session-list");
      await expect(sessionList).toBeVisible();
      const sessionListStyle = await sessionList.evaluate(element => ({
        overflowY: getComputedStyle(element).overflowY,
        maxHeight: getComputedStyle(element).maxHeight
      }));
      expect(["auto", "scroll"]).not.toContain(sessionListStyle.overflowY);
      expect(sessionListStyle.maxHeight).toBe("none");

      const archiveSummary = page.locator(".session-archive > summary").first();
      await expectMinTargetSize(archiveSummary);

      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      await inventoryWorkspace.locator(".session-row", { hasText: session.name }).click();
      const assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
      await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();
      const row = inventoryWorkspace.locator(".session-item", { hasText: packetLine });
      await expect(row).toBeVisible();

      await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await expect(page.getByRole("dialog"), "item context should be visible without a generic dialog").toHaveCount(0);
      const leaderControls = row.getByRole("region", { name: `Manage ${packetLine}` });
      await expect(leaderControls.getByRole("heading", { name: "Leader controls" })).toBeVisible();
      await expectMinTargetSize(leaderControls.getByRole("combobox", { name: "Assign to" }));
      await expectMinTargetSize(leaderControls.getByRole("combobox", { name: "Set result" }));
      await expectContained(row);

      await row.getByRole("button", { name: "Add proof" }).click();
      const proofDialog = page.getByRole("dialog", { name: `Add proof for ${packetLine}` });
      const proofForm = proofDialog.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      await expectMinTargetSize(proofForm.getByRole("combobox", { name: "Inventory result" }));
      await expectMinTargetSize(proofForm.locator(".photo-picker"));

      const photoName = `touch-target-${suffix}.jpg`;
      await proofForm.getByLabel("Add item photos").setInputFiles(selectedPhoto(photoName));
      const removePhoto = proofForm.getByRole("button", { name: `Remove ${photoName}` });
      await expectMinTargetSize(removePhoto, { width: 44, height: 44 });
      await removePhoto.click();
      await expect(proofForm.getByRole("list", { name: "Selected proof photos" })).toHaveCount(0);
      await proofForm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(proofDialog).toBeHidden();
    } finally {
      await closeSession(request, session.id);
    }
  });
});
