import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
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

async function signIn(page, persona) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page.getByRole("heading", { name: persona === "NCO" ? "Inventory Dashboard" : "Leader Dashboard" })).toBeVisible();
}

async function openWorkspaceTab(page, name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  const tab = page.getByRole("button", { name, exact: true });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
}

test.describe("tenant activity log", () => {
  test("admins can filter human-readable activity and open its related session", async ({ page, request }, testInfo) => {
    const sessionName = `QA activity UI ${testInfo.project.name} ${Date.now()}`;
    const session = (await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(),
      data: { name: sessionName, status: "active" }
    }))).session;

    try {
    await signIn(page, "Platoon admin");
    await openWorkspaceTab(page, "Activity Log");
    await expect(page.getByRole("heading", { name: "Activity Log", exact: true })).toBeVisible();

    const filters = page.getByRole("form", { name: "Activity filters" });
    await expect(filters.getByLabel("Action")).toContainText("Inventory Session Created");
    await filters.getByLabel("Action").selectOption("inventory_session.created");
    await filters.getByRole("button", { name: "Apply filters" }).click();

    const event = page.locator(".activity-event", { hasText: sessionName }).first();
    await expect(event).toBeVisible();
    await expect(event.getByText(`QA Platoon Admin created ${sessionName}.`, { exact: true })).toBeVisible();
    await expect(event.getByText("Workflow", { exact: true })).toBeVisible();
    await expect(event.getByText("Inventory Session Created", { exact: true })).toBeVisible();
    await expect(event).not.toContainText(/metadata|storageKey|mediaUploadIds|inviteToken/i);

    await event.getByRole("button", { name: "Open inventory" }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    await expect(page.locator(".session-summary", { hasText: sessionName })).toBeVisible();

    await openWorkspaceTab(page, "Activity Log");
    await expect(page.getByRole("heading", { name: "Activity Log", exact: true })).toBeVisible();
    const refreshedFilters = page.getByRole("form", { name: "Activity filters" });
    await refreshedFilters.getByLabel("From").fill("2100-01-01");
    await refreshedFilters.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByText("No matching activity", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).last().click();
    await expect(page.locator(".activity-event").first()).toBeVisible();

    let failNextActivityRequest = true;
    await page.route("**/api/tenant/audit-events**", async route => {
      if (!failNextActivityRequest) {
        await route.continue();
        return;
      }
      failNextActivityRequest = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "X-Request-ID": "qa-activity-filter-failure" },
        body: JSON.stringify({ error: "Internal server error", code: "internal_error", requestId: "qa-activity-filter-failure" })
      });
    });
    await page.getByRole("form", { name: "Activity filters" }).getByLabel("Category").selectOption("workflow");
    await page.getByRole("form", { name: "Activity filters" }).getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("alert")).toHaveText("Internal server error");
    await expect(page.getByText("qa-activity-filter-failure", { exact: false })).toHaveCount(0);
    await expect(page.locator(".activity-event")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load older activity" })).toHaveCount(0);
    await expect(page.getByText("No matching activity", { exact: true })).toHaveCount(0);
    await page.getByRole("form", { name: "Activity filters" }).getByRole("button", { name: "Apply filters" }).click();
    await expect(page.locator(".activity-event").first()).toBeVisible();

    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    if (testInfo.project.name === "mobile-chrome") {
      const firstEvent = page.locator(".activity-event").first();
      expect(await firstEvent.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    }

    } finally {
      await request.patch(`${API_URL}/inventory/sessions/${session.id}`, {
        headers: qaHeaders(),
        data: { status: "closed" }
      }).catch(() => {});
    }
  });

  test("contributors do not see the activity navigation", async ({ page }) => {
    await signIn(page, "NCO");
    const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await expect(page.getByRole("button", { name: "Activity Log", exact: true })).toHaveCount(0);
  });

  test("an empty activity log points leaders back to inventory sessions", async ({ page }) => {
    await page.route("**/api/tenant/audit-events**", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        events: [],
        nextCursor: null,
        filterOptions: { actors: [], actions: [], entityTypes: [], categories: [] }
      })
    }));

    await signIn(page, "Platoon admin");
    await openWorkspaceTab(page, "Activity Log");
    await expect(page.getByText("No activity yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open inventories", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
  });
});
