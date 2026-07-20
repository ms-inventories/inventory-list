import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PHOTO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mNk+M9QDwADgQGAUj0KkwAAAABJRU5ErkJggg==";

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function searchTenantSlug(testInfo) {
  return testInfo.project.name === "mobile-chrome"
    ? "qa-search-mobile"
    : "qa-search-desktop";
}

function qaHeaders(testInfo) {
  return {
    "X-Dev-Sub": qaRoot.sub,
    "X-Dev-Email": qaRoot.email,
    "X-Dev-Name": qaRoot.name,
    "X-Dev-Groups": qaRoot.groups.join(","),
    "X-Tenant-Slug": searchTenantSlug(testInfo)
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function createActiveSession(request, testInfo) {
  const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const response = await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(testInfo),
    data: {
      name: `QA active inventory ${suffix}`,
      status: "active"
    }
  });
  return (await responseJson(response)).session;
}

async function signInAsRoot(page, testInfo) {
  await page.goto(`http://${searchTenantSlug(testInfo)}.localhost:5175/#/admin`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Root admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

function createSessionDialog(page) {
  return page.getByRole("dialog", { name: /^(Start inventory|Create inventory session)$/ });
}

async function expectPersistentDashboardWorkQueue(page) {
  await expect(
    page.getByRole("heading", { name: "Leader Dashboard", exact: true }),
    "the work queue should remain part of the dashboard instead of replacing it"
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Inventory workspace" }),
    "an active inventory should render its workspace on initial dashboard load"
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Work queue", exact: true }),
    "the dashboard should show the selected inventory's work queue"
  ).toBeVisible();
  await expect(
    createSessionDialog(page),
    "loading existing inventory work must not open the create-session wizard"
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Open inventory|Open session|Back to dashboard)$/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Current inventory", exact: true })).toHaveCount(0);
  await expect(page.getByText("Manage inventories", { exact: true })).toHaveCount(0);
  await expect(page.locator(".session-sidebar")).toHaveCount(0);
}

async function selectDashboardInventory(page, sessionId, sessionName) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
  const singleInventoryHeading = activeInventory.getByRole("heading", { name: sessionName, exact: true });

  await expect.poll(async () => {
    if (await selector.isVisible()) return "selector";
    if (await singleInventoryHeading.isVisible()) return "heading";
    return "loading";
  }, { message: `wait for ${sessionName} to become selectable` }).not.toBe("loading");

  if (await selector.isVisible()) {
    await selector.selectOption(sessionId);
    await expect(selector).toHaveValue(sessionId);
  } else {
    await expect(singleInventoryHeading).toBeVisible();
  }

  return { activeInventory, selector };
}

test.describe("dashboard action destinations", () => {
  test("inventory work is open by default without duplicate workspace controls", async ({ page }, testInfo) => {
    await signInAsRoot(page, testInfo);
    await expectPersistentDashboardWorkQueue(page);
    const currentInventory = page.getByRole("region", { name: "Active inventory" });
    await expect(currentInventory).toBeVisible();
    await expect(currentInventory.getByText("Current inventory", { exact: true })).toBeVisible();
  });

  test("refresh keeps the automatic dashboard inventory and work queue aligned after summaries reorder", async ({ page }, testInfo) => {
    const inventoryA = {
      id: "dashboard-default-inventory-a",
      name: "Automatic inventory A",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 2,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };
    const inventoryB = {
      ...inventoryA,
      id: "dashboard-default-inventory-b",
      name: "Automatic inventory B",
      needsReviewCount: 0,
      createdAt: "2026-07-20T13:00:00.000Z",
      startedAt: "2026-07-20T13:00:00.000Z"
    };
    const detailFor = (session, packetLine) => ({
      session,
      items: [{
        id: `${session.id}-item`,
        sessionId: session.id,
        packetLine,
        expectedQty: 1,
        status: "unchecked",
        assignedTo: null,
        assignedToEmail: null,
        assignedToName: null,
        inventoryItem: null,
        submissions: []
      }],
      importBatches: []
    });
    let prioritizeInventoryB = false;
    let reorderedSummaryResponses = 0;

    await page.route("**/api/inventory/sessions", async route => {
      const sessions = prioritizeInventoryB
        ? [
            { ...inventoryA, needsReviewCount: 0 },
            { ...inventoryB, needsReviewCount: 3 }
          ]
        : [inventoryA, inventoryB];
      if (prioritizeInventoryB) reorderedSummaryResponses += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions })
      });
    });
    await page.route(`**/api/inventory/sessions/${inventoryA.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(inventoryA, "AUTOMATIC-QUEUE-A"))
    }));
    await page.route(`**/api/inventory/sessions/${inventoryB.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(inventoryB, "AUTOMATIC-QUEUE-B"))
    }));

    await signInAsRoot(page, testInfo);
    await expectPersistentDashboardWorkQueue(page);

    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const inventorySelector = activeInventory.getByRole("combobox", { name: "Active inventory" });
    const selectedInventoryOption = inventorySelector.locator("option:checked");
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(inventorySelector).toHaveValue(inventoryA.id);
    await expect(selectedInventoryOption).toHaveText(inventoryA.name);
    await expect(inventoryWorkspace.locator(".session-item", { hasText: "AUTOMATIC-QUEUE-A" })).toBeVisible();
    await expect(inventoryWorkspace.getByText("AUTOMATIC-QUEUE-B", { exact: true })).toHaveCount(0);

    prioritizeInventoryB = true;
    const visibleRefreshButton = page.getByRole("button", { name: "Refresh workspace", exact: true });
    if (!(await visibleRefreshButton.isVisible())) {
      await page.getByRole("button", { name: "Open user menu", exact: true }).click();
    }
    await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
    await expect.poll(
      () => reorderedSummaryResponses,
      { message: "both dashboard consumers should receive the reordered inventory summaries" }
    ).toBeGreaterThanOrEqual(2);

    await expect(
      inventorySelector,
      "refreshing reordered summaries must preserve the inventory selected automatically on initial load"
    ).toHaveValue(inventoryA.id);
    await expect(selectedInventoryOption).toHaveText(inventoryA.name);
    await expect(
      inventoryWorkspace.locator(".session-item", { hasText: "AUTOMATIC-QUEUE-A" }),
      "the work queue must remain aligned with the dashboard inventory selector"
    ).toBeVisible();
    await expect(inventoryWorkspace.getByText("AUTOMATIC-QUEUE-B", { exact: true })).toHaveCount(0);
  });

  test("slow inventory loading never presents a false empty dashboard or creation action", async ({ page }, testInfo) => {
    const inventory = {
      id: "dashboard-slow-loading-inventory",
      name: "Loaded inventory",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 0,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };
    let releaseInventoryList = () => {};
    const inventoryListGate = new Promise(resolve => {
      releaseInventoryList = resolve;
    });

    await page.route("**/api/inventory/sessions", async route => {
      await inventoryListGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [inventory] })
      });
    });
    await page.route(`**/api/inventory/sessions/${inventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: inventory,
        items: [{
          id: "dashboard-slow-loading-item",
          sessionId: inventory.id,
          packetLine: "LOADED-INVENTORY-QUEUE-ROW",
          expectedQty: 1,
          status: "unchecked",
          assignedTo: null,
          assignedToEmail: null,
          assignedToName: null,
          inventoryItem: null,
          submissions: []
        }],
        importBatches: []
      })
    }));

    try {
      await signInAsRoot(page, testInfo);
      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      await expect(activeInventory.getByRole("heading", { name: "Loading inventory...", exact: true })).toBeVisible();
      await expect(inventoryWorkspace.getByText("Loading inventory...", { exact: true })).toBeVisible();
      await expect(activeInventory.getByRole("button", { name: "Start inventory", exact: true })).toHaveCount(0);
      await expect(activeInventory.getByRole("heading", { name: "No active inventory", exact: true })).toHaveCount(0);
      await expect(inventoryWorkspace.getByText("Select an inventory", { exact: true })).toHaveCount(0);

      releaseInventoryList();
      await expect(activeInventory.getByRole("heading", { name: inventory.name, exact: true })).toBeVisible();
      await expect(inventoryWorkspace.locator(".session-item", { hasText: "LOADED-INVENTORY-QUEUE-ROW" })).toBeVisible();
    } finally {
      releaseInventoryList();
    }
  });

  test("inventory detail failures stop loading and provide a working retry", async ({ page }, testInfo) => {
    const inventory = {
      id: "dashboard-detail-retry-inventory",
      name: "Retry inventory detail",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 0,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };
    const packetLine = "DETAIL-RETRY-QUEUE-ROW";
    let allowDetail = false;
    let detailRequests = 0;

    await page.route("**/api/inventory/sessions", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [inventory] })
    }));
    await page.route(`**/api/inventory/sessions/${inventory.id}`, route => {
      detailRequests += 1;
      if (!allowDetail) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Inventory details are temporarily unavailable." })
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: inventory,
          items: [{
            id: "dashboard-detail-retry-item",
            sessionId: inventory.id,
            packetLine,
            expectedQty: 1,
            status: "unchecked",
            assignedTo: null,
            assignedToEmail: null,
            assignedToName: null,
            inventoryItem: null,
            submissions: []
          }],
          importBatches: []
        })
      });
    });

    await signInAsRoot(page, testInfo);
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    const detailError = inventoryWorkspace.locator(".admin-empty", { hasText: "Could not load inventory" });
    await expect(detailError.getByText("Could not load inventory", { exact: true })).toBeVisible();
    await expect(inventoryWorkspace.getByText("Loading inventory...", { exact: true })).toHaveCount(0);
    await expect(detailError).toContainText("Inventory details are temporarily unavailable.");

    allowDetail = true;
    await inventoryWorkspace.getByRole("button", { name: "Retry inventory", exact: true }).click();
    await expect(inventoryWorkspace.locator(".session-item", { hasText: packetLine })).toBeVisible();
    await expect(detailError).toHaveCount(0);
    expect(detailRequests).toBeGreaterThanOrEqual(2);
  });

  test("review queue failures do not hide available inventory work", async ({ page }, testInfo) => {
    const inventory = {
      id: "dashboard-review-failure-inventory",
      name: "Inventory available during review outage",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 1,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };

    await page.route("**/api/inventory/sessions", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [inventory] })
    }));
    await page.route(`**/api/inventory/sessions/${inventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: inventory,
        items: [{
          id: "dashboard-review-failure-item",
          sessionId: inventory.id,
          packetLine: "REVIEW-OUTAGE-QUEUE-ROW",
          expectedQty: 1,
          status: "unchecked",
          assignedTo: null,
          assignedToEmail: null,
          assignedToName: null,
          inventoryItem: null,
          submissions: []
        }],
        importBatches: []
      })
    }));
    await page.route("**/api/inventory/review-queue", route => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Review queue temporarily unavailable." })
    }));

    await signInAsRoot(page, testInfo);
    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(activeInventory.getByRole("heading", { name: inventory.name, exact: true })).toBeVisible();
    await expect(inventoryWorkspace.locator(".session-item", { hasText: "REVIEW-OUTAGE-QUEUE-ROW" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Inventories loaded, but the review queue could not be loaded." })).toBeVisible();
  });

  test("queue-only refresh shares newly available inventories with the dashboard selector", async ({ page }, testInfo) => {
    const inventory = {
      id: "dashboard-shared-refresh-current",
      name: "Current shared inventory",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 0,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };
    const externalInventory = {
      ...inventory,
      id: "dashboard-shared-refresh-external",
      name: "Externally started inventory",
      createdAt: "2026-07-20T15:00:00.000Z",
      startedAt: "2026-07-20T15:00:00.000Z"
    };
    const detailFor = (session, packetLine) => ({
      session,
      items: [{
        id: `${session.id}-item`,
        sessionId: session.id,
        packetLine,
        expectedQty: 1,
        status: "unchecked",
        assignedTo: null,
        assignedToEmail: null,
        assignedToName: null,
        inventoryItem: null,
        submissions: []
      }],
      importBatches: []
    });
    let exposeExternalInventory = false;
    let refreshedListRequests = 0;

    await page.route("**/api/inventory/sessions", route => {
      if (exposeExternalInventory) refreshedListRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: exposeExternalInventory ? [externalInventory, inventory] : [inventory]
        })
      });
    });
    await page.route(`**/api/inventory/sessions/${inventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(inventory, "SHARED-REFRESH-CURRENT-ROW"))
    }));
    await page.route(`**/api/inventory/sessions/${externalInventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(externalInventory, "SHARED-REFRESH-EXTERNAL-ROW"))
    }));

    await signInAsRoot(page, testInfo);
    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(activeInventory.getByRole("heading", { name: inventory.name, exact: true })).toBeVisible();
    await expect(inventoryWorkspace.locator(".session-item", { hasText: "SHARED-REFRESH-CURRENT-ROW" })).toBeVisible();

    exposeExternalInventory = true;
    await inventoryWorkspace.getByRole("button", { name: "Refresh inventory", exact: true }).click();

    const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
    await expect(selector).toBeVisible();
    await expect(selector.locator("option", { hasText: externalInventory.name })).toHaveCount(1);
    await expect(selector).toHaveValue(inventory.id);
    await expect(inventoryWorkspace.locator(".session-item", { hasText: "SHARED-REFRESH-CURRENT-ROW" })).toBeVisible();
    await expect(inventoryWorkspace.getByText("SHARED-REFRESH-EXTERNAL-ROW", { exact: true })).toHaveCount(0);
    await expect.poll(
      () => refreshedListRequests,
      { message: "queue refresh should also refresh the dashboard inventory list" }
    ).toBeGreaterThanOrEqual(2);
  });

  test("selecting a draft hides crew invitations while keeping its queue visible", async ({ page }, testInfo) => {
    const activeInventory = {
      id: "dashboard-active-with-crew",
      name: "Active inventory with crew",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 0,
      createdAt: "2026-07-20T14:00:00.000Z",
      startedAt: "2026-07-20T14:00:00.000Z"
    };
    const draftInventory = {
      ...activeInventory,
      id: "dashboard-draft-without-crew",
      name: "Draft inventory without crew",
      status: "draft",
      createdAt: "2026-07-20T15:00:00.000Z",
      startedAt: null
    };
    const detailFor = (session, packetLine) => ({
      session,
      items: [{
        id: `${session.id}-item`,
        sessionId: session.id,
        packetLine,
        expectedQty: 1,
        status: "unchecked",
        assignedTo: null,
        assignedToEmail: null,
        assignedToName: null,
        inventoryItem: null,
        submissions: []
      }],
      importBatches: []
    });

    await page.route("**/api/inventory/sessions", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [activeInventory, draftInventory] })
    }));
    await page.route(`**/api/inventory/sessions/${activeInventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(activeInventory, "ACTIVE-CREW-QUEUE-ROW"))
    }));
    await page.route(`**/api/inventory/sessions/${draftInventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFor(draftInventory, "DRAFT-NO-CREW-QUEUE-ROW"))
    }));

    await signInAsRoot(page, testInfo);
    await expectPersistentDashboardWorkQueue(page);
    const { activeInventory: dashboardInventory, selector } = await selectDashboardInventory(
      page,
      activeInventory.id,
      activeInventory.name
    );
    await expect(dashboardInventory.getByRole("button", { name: "Invite crew", exact: true })).toBeVisible();

    await selector.selectOption(draftInventory.id);
    await expect(selector).toHaveValue(draftInventory.id);
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(inventoryWorkspace.locator(".session-item", { hasText: "DRAFT-NO-CREW-QUEUE-ROW" })).toBeVisible();
    await expect(
      dashboardInventory.getByRole("button", { name: "Invite crew", exact: true }),
      "crew access should not be offered until a draft inventory is active"
    ).toHaveCount(0);
  });

  test("Add packet for the selected inventory opens directly on the Source step", async ({ page }, testInfo) => {
    const selectedInventory = {
      id: "dashboard-selected-packet-inventory",
      name: "Selected packet inventory",
      status: "active",
      itemCount: 1,
      completedCount: 0,
      foundCount: 0,
      needsReviewCount: 0,
      createdAt: "2026-07-20T16:00:00.000Z",
      startedAt: "2026-07-20T16:00:00.000Z"
    };
    const selectedItem = {
      id: "dashboard-selected-packet-item",
      sessionId: selectedInventory.id,
      packetLine: "SELECTED-PACKET-QUEUE-ROW",
      expectedQty: 1,
      status: "unchecked",
      assignedTo: null,
      assignedToEmail: null,
      assignedToName: null,
      inventoryItem: null,
      submissions: []
    };

    await page.route("**/api/inventory/sessions", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [selectedInventory] })
    }));
    await page.route(`**/api/inventory/sessions/${selectedInventory.id}`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: selectedInventory, items: [selectedItem], importBatches: [] })
    }));

    await signInAsRoot(page, testInfo);
    await expectPersistentDashboardWorkQueue(page);
    await expect(page.getByRole("region", { name: "Inventory workspace" })
      .locator(".session-item", { hasText: selectedItem.packetLine })).toBeVisible();

    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    const inventoryActionsTrigger = inventoryWorkspace.getByRole("button", {
      name: `Inventory actions for ${selectedInventory.name}`,
      exact: true
    });
    const inventoryActions = inventoryWorkspace.getByRole("group", {
      name: `Manage inventory ${selectedInventory.name}`,
      exact: true
    });
    await expect(inventoryWorkspace.getByText("Inventory tools", { exact: true })).toHaveCount(0);
    await expect(inventoryWorkspace.getByText("Close-out report", { exact: true })).toHaveCount(0);
    await expect(inventoryWorkspace.getByText("Inventory status", { exact: true })).toHaveCount(0);
    await expect(inventoryActionsTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(inventoryActionsTrigger).toHaveAttribute("aria-controls", /.+/);
    await expect(inventoryActions).toHaveCount(0);
    await inventoryActionsTrigger.click();
    await expect(inventoryActions).toBeVisible();
    await expect(inventoryActions.getByRole("button", { name: /^Import history\b/ })).toHaveCount(0);
    await inventoryActions.getByRole("button", { name: "Add packet", exact: true }).click();

    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(inventoryActions).toHaveCount(0);
    await expect(packetDialog.getByRole("heading", { name: "Add the packet source", exact: true })).toBeVisible();
    await expect(packetDialog.getByRole("heading", { name: "Choose where these items belong", exact: true })).toHaveCount(0);
    await expect(packetDialog.getByText("Start a new inventory", { exact: true })).toHaveCount(0);
    await expect(packetDialog.getByLabel("Packet import progress").locator("span.active small")).toHaveText("Source");
    await packetDialog.getByRole("button", { name: "Close packet wizard" }).click();
    await expect(packetDialog).toBeHidden();
    await expect(inventoryActionsTrigger).toBeFocused();
  });

  test("active inventory selector immediately swaps the visible work queue", async ({ page, request }, testInfo) => {
    const sourceSession = await createActiveSession(request, testInfo);
    const createdSession = await createActiveSession(request, testInfo);
    const sourcePacketLine = `QA-SESSION-SOURCE-${Date.now()}`;
    const packetLine = `QA-SESSION-SWAP-${Date.now()}`;
    let releaseTargetDetail = () => {};

    try {
      await responseJson(await request.post(`${API_URL}/inventory/sessions/${sourceSession.id}/items`, {
        headers: qaHeaders(testInfo),
        data: { packetLine: sourcePacketLine, expectedQty: 1 }
      }));
      await responseJson(await request.post(`${API_URL}/inventory/sessions/${createdSession.id}/items`, {
        headers: qaHeaders(testInfo),
        data: { packetLine, expectedQty: 1 }
      }));
      await signInAsRoot(page, testInfo);
      await expectPersistentDashboardWorkQueue(page);

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      await expect(activeInventory).toBeVisible();

      const sessionSelector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      await expect(sessionSelector).toBeVisible();
      await expect.poll(
        () => sessionSelector.locator("option").count(),
        { message: "multiple active sessions should be available from the dashboard selector" }
      ).toBeGreaterThan(1);
      await expect(sessionSelector.locator("option", { hasText: createdSession.name })).toHaveCount(1);
      await sessionSelector.selectOption(sourceSession.id);
      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      const sourceRow = inventoryWorkspace.locator(".session-item", { hasText: sourcePacketLine });
      await expect(sourceRow).toBeVisible();

      const targetDetailGate = new Promise(resolve => {
        releaseTargetDetail = resolve;
      });
      await page.route(`**/api/inventory/sessions/${createdSession.id}`, async route => {
        await targetDetailGate;
        await route.continue();
      }, { times: 1 });

      await sessionSelector.selectOption(createdSession.id);
      await expect(sessionSelector).toHaveValue(createdSession.id);
      await expect(
        sourceRow,
        "the previous inventory must stop being actionable as soon as the selector changes"
      ).toHaveCount(0);
      await expect(inventoryWorkspace.getByText("Loading inventory...", { exact: true })).toBeVisible();
      releaseTargetDetail();
      await expect(
        inventoryWorkspace.locator(".session-item", { hasText: packetLine }),
        "changing the dashboard selector should replace the queue without a second confirmation button"
      ).toBeVisible();
      await expectPersistentDashboardWorkQueue(page);
    } finally {
      releaseTargetDetail();
      for (const session of [sourceSession, createdSession]) {
        await request.patch(`${API_URL}/inventory/sessions/${session.id}`, {
          headers: qaHeaders(testInfo),
          data: { status: "closed" }
        });
      }
    }
  });

  test("Refresh workspace reloads inventory summaries without remounting the dashboard", async ({ page, request }, testInfo) => {
    const createdSession = await createActiveSession(request, testInfo);

    try {
      await signInAsRoot(page, testInfo);
      const { activeInventory, selector: sessionSelector } = await selectDashboardInventory(
        page,
        createdSession.id,
        createdSession.name
      );
      await expect(activeInventory).toContainText("0 items - 0% complete");

      await responseJson(await request.post(`${API_URL}/inventory/sessions/${createdSession.id}/items`, {
        headers: qaHeaders(testInfo),
        data: { packetLine: `QA-REFRESH-${Date.now()} TEST ITEM`, expectedQty: 1 }
      }));

      const visibleRefreshButton = page.getByRole("button", { name: "Refresh workspace", exact: true });
      if (!(await visibleRefreshButton.isVisible())) {
        await page.getByRole("button", { name: "Open user menu", exact: true }).click();
      }
      await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
      await expect(activeInventory).toContainText("1 item - 0% complete");
      await expect(sessionSelector).toHaveValue(createdSession.id);
    } finally {
      await request.patch(`${API_URL}/inventory/sessions/${createdSession.id}`, {
        headers: qaHeaders(testInfo),
        data: { status: "closed" }
      });
    }
  });

  test("session work can be claimed directly and only Add proof opens a form", async ({ page, request }, testInfo) => {
    const sessionCreateRequests = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /\/api\/inventory\/sessions\/?$/.test(url.pathname)) {
        sessionCreateRequests.push(request.url());
      }
    });

    let sessionId = "";
    let sessionItemId = "";
    try {
      await signInAsRoot(page, testInfo);

      const sessionPayload = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(testInfo)
      }));
      sessionId = sessionPayload.sessions.find(session => session.name === "Search behavior fixture")?.id || "";
      expect(sessionId).toBeTruthy();
      const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${sessionId}`, {
        headers: qaHeaders(testInfo)
      }));
      sessionItemId = detail.items.find(item => item.inventoryItem?.commonName === "Quiet Generator")?.id || "";
      expect(sessionItemId).toBeTruthy();
      await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
        headers: qaHeaders(testInfo),
        data: { memberId: null }
      }));

      await page.reload();
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      await expectPersistentDashboardWorkQueue(page);
      await expect(page.getByRole("region", { name: "Pending inventory results" })).toHaveCount(0);
      await selectDashboardInventory(page, sessionId, "Search behavior fixture");

      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      const assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
      await assignmentLists.getByRole("button", { name: /^Unclaimed\b/ }).click();

      const pendingRow = inventoryWorkspace.locator(".session-item", { hasText: "Quiet Generator" });
      await expect(pendingRow).toBeVisible();
      await expect(pendingRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await pendingRow.getByRole("button", { name: "Claim item", exact: true }).click();
      await expect(page.getByRole("dialog"), "claiming must not open any item UI").toHaveCount(0);
      await expect(page.locator(".proof-form"), "claiming must not jump into proof entry").toHaveCount(0);
      await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();

      await expect(pendingRow).toBeVisible();
      await expect(pendingRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await expect(page.locator(".session-item-drawer")).toHaveCount(0);
      await expect(pendingRow.getByRole("button", { name: "Add proof", exact: true })).toBeVisible();

      await pendingRow.getByRole("button", { name: "Add proof", exact: true }).click();
      const proofDialog = page.getByRole("dialog", { name: "Add proof for Quiet Generator" });
      await expect(proofDialog).toBeVisible();
      await expect(proofDialog.locator(".proof-form")).toBeVisible();
      await expect(page.locator(".session-item-drawer")).toHaveCount(0);
      await proofDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(proofDialog).toBeHidden();

      expect(sessionCreateRequests, "claiming or adding proof must not create an inventory session").toHaveLength(0);
    } finally {
      if (sessionItemId) {
        await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
          headers: qaHeaders(testInfo),
          data: { memberId: null }
        }));
      }
    }
  });

  test("previous inventory history opens from a compact, accessible modal trigger", async ({ page, request }, testInfo) => {
    const sessionPayload = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(testInfo)
    }));
    const session = sessionPayload.sessions.find(candidate => candidate.name === "Search behavior fixture");
    expect(session?.id).toBeTruthy();

    const originalDetail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${session.id}`, {
      headers: qaHeaders(testInfo)
    }));
    const historyItem = originalDetail.items.find(item => item.inventoryItem?.commonName === "Quiet Generator");
    expect(historyItem?.id).toBeTruthy();

    const inventoriedAt = "2026-06-18T14:30:00.000Z";
    const latestOutcomeAt = "2026-07-02T16:45:00.000Z";
    await page.route(`**/api/inventory/sessions/${session.id}`, async route => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...originalDetail,
          items: (originalDetail.items || []).map(item => item.id === historyItem.id ? {
            ...item,
            packetLine: "Quiet Generator",
            inventoryItem: null,
            status: "unchecked",
            assignedTo: null,
            assignedToEmail: null,
            assignedToName: null,
            submissions: [{
              id: "current-rejected-proof",
              sessionItemId: item.id,
              status: "found",
              reviewState: "rejected",
              reviewNote: "CURRENT SESSION REQUEST MUST NOT APPEAR ON PRIOR PHOTOS",
              createdAt: "2026-07-18T18:00:00.000Z",
              photos: []
            }],
            priorInventoryHistory: {
              sessionName: "July 2026 recheck",
              sessionStatus: "closed",
              status: "not_found",
              locationText: "This must not replace the last-found location",
              inventoriedAt: latestOutcomeAt,
              expectedQty: 4,
              historyCount: 3,
              lastFound: {
                sessionName: "June 2026 inventory",
                sessionStatus: "closed",
                locationText: "Motor pool, bay 4",
                inventoriedAt,
                expectedQty: 4
              },
              photoContext: {
                sessionName: "June 2026 inventory",
                sessionStatus: "closed",
                status: "found",
                locationText: "Motor pool, bay 4",
                inventoriedAt,
                expectedQty: 4
              },
              photos: [
                { url: PHOTO_DATA_URL, kind: "general", caption: "Generator front view" },
                { url: `${PHOTO_DATA_URL}#second`, kind: "location", caption: "Generator in motor pool bay 4" }
              ]
            }
          } : item)
        })
      });
    });

    await signInAsRoot(page, testInfo);
    await selectDashboardInventory(page, session.id, session.name);

    await expect(page.getByRole("region", { name: "Pending inventory results" })).toHaveCount(0);

    await expectPersistentDashboardWorkQueue(page);
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await inventoryWorkspace.getByRole("group", { name: "Work assignment lists" })
      .getByRole("button", { name: /^Unclaimed\b/ })
      .click();
    const sessionRow = inventoryWorkspace.locator(".session-item", { hasText: "Quiet Generator" });
    await expect(sessionRow).toBeVisible();
    await expect(sessionRow.getByRole("region", { name: "Previous inventory for Quiet Generator" })).toHaveCount(0);
    const historyButton = sessionRow.getByRole("button", { name: "View previous inventory history for Quiet Generator" });
    await expect(historyButton).toBeVisible();
    await expect(historyButton).toHaveAttribute("aria-haspopup", "dialog");
    await expect(sessionRow.locator(".session-item-leading-thumb img"), "history supplies the full-session thumbnail").toBeVisible();
    await expect(sessionRow.getByRole("button", { name: "Claim item", exact: true })).toBeVisible();
    await expect(sessionRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    expect(await sessionRow.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();

    await historyButton.click();
    const historyDialog = page.getByRole("dialog", { name: "Previous inventory for Quiet Generator" });
    await expect(historyDialog).toBeVisible();
    await expect(historyDialog).toHaveAttribute("aria-modal", "true");
    await expect(historyDialog.getByText("3 earlier records", { exact: true })).toBeVisible();
    await expect(historyDialog.getByText("Motor pool, bay 4", { exact: true })).toBeVisible();
    await expect(historyDialog.getByText("June 2026 inventory", { exact: true })).toBeVisible();
    await expect(historyDialog.getByText("Not found", { exact: true })).toBeVisible();
    await expect(historyDialog.getByText("July 2026 recheck", { exact: true })).toBeVisible();
    await expect(historyDialog.getByText("This must not replace the last-found location", { exact: true })).toHaveCount(0);
    await expect(historyDialog.getByText("4", { exact: true })).toBeVisible();
    await expect(historyDialog.locator(`time[datetime="${inventoriedAt}"]`)).toBeVisible();
    await expect(historyDialog.locator(`time[datetime="${latestOutcomeAt}"]`)).toBeVisible();
    await expect(historyDialog.locator("img")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(historyDialog).toBeHidden();
    await expect(historyButton).toBeFocused();

    await historyButton.click();
    await historyDialog.getByRole("button", { name: "View previous inventory photo 1" }).click();
    const viewer = page.getByRole("dialog", { name: "Evidence photo" });
    await expect(viewer).toBeVisible();
    const obscuredHistoryDialog = page.locator(".prior-inventory-modal");
    await expect(obscuredHistoryDialog).toHaveAttribute("aria-hidden", "true");
    await expect(obscuredHistoryDialog).toHaveAttribute("inert", "");
    await expect(viewer).toContainText("June 2026 inventory");
    await expect(viewer).not.toContainText("CURRENT SESSION REQUEST MUST NOT APPEAR ON PRIOR PHOTOS");
    await expect(viewer.locator(".proof-viewer-request")).toHaveCount(0);
    await viewer.getByRole("button", { name: "Close evidence viewer" }).click();
    await expect(historyDialog).toBeVisible();
    await expect(historyDialog).not.toHaveAttribute("aria-hidden", "true");
    await expect(historyDialog).not.toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(historyDialog).toBeHidden();
    await expect(historyButton).toBeFocused();
    if (testInfo.project.name === "mobile-chrome") {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
    }
  });

  test("session work remains mounted on the dashboard and has no collapse step", async ({ page }, testInfo) => {
    await signInAsRoot(page, testInfo);

    await expectPersistentDashboardWorkQueue(page);
    await expect(page.getByRole("button", { name: "Back to dashboard", exact: true })).toHaveCount(0);
  });
});
