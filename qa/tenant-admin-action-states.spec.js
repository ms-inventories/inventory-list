import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

const qaPlatoonAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

async function seedQaTenantSession(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaPlatoonAdmin);
}

async function openTenant(page) {
  await seedQaTenantSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openWorkspaceTab(page, name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function doubleClickBeforeReactCommit(locator) {
  await locator.evaluate(button => {
    button.click();
    button.click();
  });
}

test.describe("tenant administration async action states", () => {
  test("settings and reports name pending work and reject duplicate taps", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await openTenant(page);
    await openWorkspaceTab(page, "Workspace Settings");

    const settingsPage = page.locator(".tenant-settings-page");
    const displayName = settingsPage.getByLabel("Display name", { exact: true });
    await expect(displayName).toBeEnabled();
    const currentName = await displayName.inputValue();
    const workspaceUrl = await settingsPage.locator(".settings-workspace-link a").getAttribute("href");
    let settingsRefreshes = 0;
    let settingsSaves = 0;

    await page.route("**/api/tenant/settings", async route => {
      const method = route.request().method();
      if (method === "GET") settingsRefreshes += 1;
      if (method === "PATCH") settingsSaves += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      const requestBody = method === "PATCH" ? route.request().postDataJSON() : {};
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settings: {
            displayName: requestBody.displayName || currentName,
            notificationPreferences: requestBody.notificationPreferences || {},
            workspace: { slug: "ms", url: workspaceUrl }
          }
        })
      });
    });

    const settingsRefresh = settingsPage.getByRole("button", { name: "Refresh", exact: true });
    await doubleClickBeforeReactCommit(settingsRefresh);
    await expect.poll(() => settingsRefreshes).toBe(1);
    await expect(settingsPage.getByRole("button", { name: "Refreshing...", exact: true })).toBeDisabled();
    await expect(settingsRefresh).toBeEnabled();

    const settingsForm = settingsPage.locator("form.settings-form");
    await settingsForm.evaluate(form => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => settingsSaves).toBe(1);
    await expect(settingsPage.getByRole("button", { name: "Saving...", exact: true })).toBeDisabled();
    await expect(page.getByText("Workspace settings saved.", { exact: true })).toBeVisible();

    await page.unroute("**/api/tenant/settings");
    await openWorkspaceTab(page, "Reports");
    const reportsPage = page.locator(".reports-page");
    await expect(reportsPage.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(reportsPage.getByRole("combobox", { name: "Inventory", exact: true })).toBeEnabled();

    let reportRefreshes = 0;
    await page.route("**/api/inventory/reports", async route => {
      reportRefreshes += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.continue();
    });

    const isMobile = Boolean(testInfo.project.use.isMobile);
    let reportRefresh;
    if (isMobile) {
      await reportsPage.getByRole("button", { name: "More actions", exact: true }).click();
      reportRefresh = reportsPage.getByRole("button", { name: "Refresh report", exact: true });
    } else {
      reportRefresh = reportsPage.getByRole("button", { name: "Refresh", exact: true });
    }
    await expect(reportRefresh).toBeEnabled();
    await doubleClickBeforeReactCommit(reportRefresh);
    await expect.poll(() => reportRefreshes).toBe(1);
    if (isMobile) {
      await expect(reportsPage.getByRole("button", { name: "Refreshing report", exact: true })).toBeDisabled();
    } else {
      await expect(reportsPage.getByRole("button", { name: "Refreshing...", exact: true })).toBeDisabled();
    }
    await expect(reportsPage.getByRole("combobox", { name: "Inventory", exact: true })).toBeEnabled();
    expect(reportRefreshes).toBe(1);
  });

  test("workspace, alert, and activity refreshes stay single-shot and explain progress", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openTenant(page);
    await expect(page.locator(".leader-system-card")).toContainText("MS Platoon");

    let workspaceRefreshes = 0;
    await page.route(/\/api\/tenant$/, async route => {
      workspaceRefreshes += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.continue();
    });

    const isMobile = Boolean(testInfo.project.use.isMobile);
    if (isMobile) await page.getByRole("button", { name: "Open user menu", exact: true }).click();
    const workspaceRefresh = isMobile
      ? page.getByRole("region", { name: "User menu" }).getByRole("button", { name: "Refresh workspace", exact: true })
      : page.getByRole("button", { name: "Refresh workspace", exact: true }).first();
    await doubleClickBeforeReactCommit(workspaceRefresh);
    await expect.poll(() => workspaceRefreshes).toBe(1);
    await expect(page.getByRole("button", { name: isMobile ? "Refreshing workspace..." : "Refreshing workspace", exact: true })).toBeDisabled();
    await expect(page.getByText("Workspace refreshed.", { exact: true })).toBeVisible();
    expect(workspaceRefreshes).toBe(1);

    const notificationButton = page.getByRole("button", { name: /^Notifications/ });
    await notificationButton.click();
    const notificationPanel = page.getByRole("region", { name: "Notifications" });
    await expect(notificationPanel.getByRole("button", { name: "Refresh alerts", exact: true })).toBeEnabled({ timeout: 30_000 });

    let alertRefreshes = 0;
    await page.route("**/api/tenant/notifications", async route => {
      alertRefreshes += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.continue();
    });
    const alertRefresh = notificationPanel.getByRole("button", { name: "Refresh alerts", exact: true });
    await doubleClickBeforeReactCommit(alertRefresh);
    await expect.poll(() => alertRefreshes).toBe(1);
    await expect(notificationPanel.getByRole("button", { name: "Refreshing alerts...", exact: true })).toBeDisabled();
    await expect(notificationPanel.getByRole("button", { name: "Refresh alerts", exact: true })).toBeEnabled();
    expect(alertRefreshes).toBe(1);

    await page.unroute("**/api/tenant/notifications");
    await openWorkspaceTab(page, "Activity Log");
    const activityPage = page.locator(".activity-page");
    const filters = activityPage.getByRole("form", { name: "Activity filters" });
    await expect(filters.getByRole("button", { name: "Apply filters", exact: true })).toBeEnabled();

    let activityLoads = 0;
    await page.route("**/api/tenant/audit-events**", async route => {
      activityLoads += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.continue();
    });
    await filters.getByLabel("Category").selectOption("workflow");
    await filters.evaluate(form => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => activityLoads).toBe(1);
    await expect(filters.getByRole("button", { name: "Applying...", exact: true })).toBeDisabled();
    await expect(filters.getByRole("button", { name: "Apply filters", exact: true })).toBeEnabled();
    expect(activityLoads).toBe(1);
  });
});
