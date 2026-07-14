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
    page.getByRole("heading", { name: "Sessions", exact: true }),
    "the dashboard action should navigate to Inventory Sessions"
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

  test("Open item opens the seeded pending row's exact item without creating a session", async ({ page }, testInfo) => {
    const sessionCreateRequests = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /\/api\/inventory\/sessions\/?$/.test(url.pathname)) {
        sessionCreateRequests.push(request.url());
      }
    });

    await signInAsRoot(page, testInfo);

    const pendingResults = page.getByRole("region", { name: "Pending inventory results" });
    const pendingRow = pendingResults.locator(".leader-table-row").filter({
      has: page.getByText("Field Radio", { exact: true })
    });
    await expect(pendingRow).toBeVisible();
    await pendingRow.getByRole("button", { name: "Open item", exact: true }).click();

    await expectSessionsPageWithoutCreateDialog(page);
    await expect(
      page.locator(".session-summary").getByText("Search behavior fixture", { exact: true }),
      "the row action should preserve and select the row's session id"
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Field Radio" }),
      "the row action should open the exact pending item's detail drawer"
    ).toBeVisible();
    expect(sessionCreateRequests, "opening pending work must not create an inventory session").toHaveLength(0);
  });

  test("Open sessions navigates from the pending card to the sessions page", async ({ page }, testInfo) => {
    await signInAsRoot(page, testInfo);

    const pendingResults = page.getByRole("region", { name: "Pending inventory results" });
    await pendingResults.getByRole("button", { name: "Open session" }).click();

    await expectSessionsPageWithoutCreateDialog(page);
  });
});
