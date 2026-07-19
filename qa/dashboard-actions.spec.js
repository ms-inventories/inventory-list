import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

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

async function deleteEmptySession(request, testInfo, sessionId) {
  if (!sessionId) return;
  const response = await request.delete(`${API_URL}/inventory/sessions/${sessionId}`, {
    headers: qaHeaders(testInfo)
  });
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
}

async function signInAsRoot(page, testInfo) {
  await page.goto(`http://${searchTenantSlug(testInfo)}.localhost:5175/#/admin`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Root admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

function createSessionControl(page) {
  return page.getByRole("button", { name: /^(Start new inventory|Create session)$/ });
}

function createSessionDialog(page) {
  return page.getByRole("dialog", { name: /^(Start inventory|Create inventory session)$/ });
}

async function expectSessionsPageWithoutCreateDialog(page) {
  await expect(
    page.getByRole("region", { name: "Inventory workspace" }),
    "the dashboard action should expand the inventory workspace"
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sessions", exact: true }),
    "the expanded inventory workspace should show the session controls"
  ).toBeVisible();
  await expect(
    createSessionDialog(page),
    "opening existing session work must not open the create-session wizard"
  ).toHaveCount(0);
}

test.describe("dashboard action destinations", () => {
  test("Create session opens the new-session wizard", async ({ page }, testInfo) => {
    await signInAsRoot(page, testInfo);

    await createSessionControl(page).click();

    await expect(createSessionDialog(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toHaveCount(0);
  });

  test("active inventory selector continues the exact selected session", async ({ page, request }, testInfo) => {
    const createdSession = await createActiveSession(request, testInfo);

    try {
      await signInAsRoot(page, testInfo);

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      await expect(activeInventory).toBeVisible();

      const sessionSelector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      await expect(sessionSelector).toBeVisible();
      await expect.poll(
        () => sessionSelector.locator("option").count(),
        { message: "multiple active sessions should be available from the dashboard selector" }
      ).toBeGreaterThan(1);
      await expect(sessionSelector.locator("option", { hasText: createdSession.name })).toHaveCount(1);
      await sessionSelector.selectOption(createdSession.id);
      await expect(sessionSelector).toHaveValue(createdSession.id);

      await activeInventory.getByRole("button", { name: "Open session" }).click();

      await expectSessionsPageWithoutCreateDialog(page);
      await expect(
        page.locator(".session-summary").getByText(createdSession.name, { exact: true }),
        "Open session should preserve the selected active session id"
      ).toBeVisible();
    } finally {
      await deleteEmptySession(request, testInfo, createdSession.id);
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
      const pendingResults = page.getByRole("region", { name: "Pending inventory results" });
      await expect(pendingResults, "the dashboard work queue supports one-tap claiming").toBeVisible();
      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      if (await selector.isVisible()) await selector.selectOption(sessionId);

      const dashboardLists = pendingResults.getByRole("group", { name: "Dashboard work assignment lists" });
      await dashboardLists.getByRole("button", { name: /^Unclaimed\b/ }).click();
      let dashboardRow = pendingResults.locator(".leader-table-row", { hasText: "Quiet Generator" });
      await expect(dashboardRow).toBeVisible();
      await expect(dashboardRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await dashboardRow.getByRole("button", { name: "Claim item", exact: true }).click();
      await expect(page.locator(".leader-dashboard").getByRole("status")).toContainText("Item claimed");
      await expect(page.getByRole("dialog"), "dashboard claiming must not open any item UI").toHaveCount(0);
      await expect(page.locator(".proof-form"), "dashboard claiming must not jump into proof entry").toHaveCount(0);
      await dashboardLists.getByRole("button", { name: /^Mine\b/ }).click();
      dashboardRow = pendingResults.locator(".leader-table-row", { hasText: "Quiet Generator" });
      await expect(dashboardRow).toBeVisible();

      await activeInventory.getByRole("button", { name: "Open session", exact: true }).click();
      await expectSessionsPageWithoutCreateDialog(page);
      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      const assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
      await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();

      const pendingRow = inventoryWorkspace.locator(".session-item", { hasText: "Quiet Generator" });
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

  test("session work remains hidden until explicitly opened and can be collapsed again", async ({ page }, testInfo) => {
    await signInAsRoot(page, testInfo);

    await expect(page.getByRole("region", { name: "Inventory workspace" })).toHaveCount(0);
    await page.getByRole("region", { name: "Active inventory" })
      .getByRole("button", { name: "Open session", exact: true })
      .click();
    await expectSessionsPageWithoutCreateDialog(page);
    await page.getByRole("button", { name: "Close work queue", exact: true }).click();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  });
});
