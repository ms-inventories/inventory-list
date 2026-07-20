import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";

const qaRootAdmin = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

async function seedQaRootSession(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaRootAdmin);
}

async function activatePlatformNav(page, name, isMobileProject) {
  if (isMobileProject) await page.getByRole("button", { name: "Open platform menu" }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

test.describe("Platform dashboard", () => {
  test("dashboard is the platoon overview instead of a second management page", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByText("Open a platoon and see where today’s inventories need attention.")).toBeVisible();

    const cards = page.locator(".platform-platoon-card");
    await expect(cards.first()).toBeVisible();
    const msCard = cards.filter({ hasText: "MS Platoon" }).first();
    await expect(msCard).toBeVisible();
    const inventoryFact = msCard.locator(".platform-platoon-facts > span").first();
    await expect(inventoryFact).toHaveText(/^\d+active (?:inventory|inventories)$/);
    await expect(inventoryFact).not.toContainText("inventorys");
    await expect(msCard.getByText(/active crew member/)).toBeVisible();
    await expect(msCard.getByText(/team members?/)).toBeVisible();
    const progress = msCard.getByRole("progressbar");
    if (await progress.count()) {
      await expect(progress).toHaveAttribute("aria-valuenow", /^\d+(?:\.\d+)?$/);
    } else {
      await expect(msCard.getByText("No active inventory.", { exact: true })).toBeVisible();
    }
    await expect(msCard.getByText("Link", { exact: true })).toBeVisible();
    await expect(msCard.getByRole("button", { name: /Copy link for MS Platoon/i })).toBeVisible();
    await expect(msCard.getByRole("link", { name: /Enter MS Platoon workspace/i })).toBeVisible();

    await expect(page.getByRole("button", { name: "Platoons", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Roles", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Organizations", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create platoon", exact: true })).toHaveCount(0);

    await activatePlatformNav(page, "Users", isMobileProject);
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add user", exact: true })).toBeVisible();
    const usersTable = page.getByRole("table", { name: "Platform users" });
    if (isMobileProject) {
      const firstUserRow = usersTable.locator(".platform-table-row").first();
      await expect(firstUserRow).toBeVisible();
      await expect(firstUserRow.locator(".mobile-field-label").getByText("Role", { exact: true })).toBeVisible();
      await expect(firstUserRow.locator(".mobile-field-label").getByText("Status", { exact: true })).toBeVisible();
    } else {
      for (const heading of ["User", "Platoon", "Role", "Status"]) {
        await expect(usersTable.getByRole("columnheader", { name: heading, exact: true })).toBeVisible();
      }
    }
    await expect(usersTable.getByText("authentik", { exact: true })).toHaveCount(0);

    await activatePlatformNav(page, "Settings", isMobileProject);
    await expect(page.getByRole("heading", { name: "Platform settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create platoon", exact: true })).toBeVisible();
  });

  test("authorized admins can open the newsletter from the dashboard shortcut", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    const shortcuts = page.getByRole("region", { name: "Admin shortcuts" });
    const newsletterLink = shortcuts.getByRole("link", { name: "Open FRG Newsletter", exact: true });
    await expect(shortcuts).toBeVisible();
    await expect(newsletterLink).toBeVisible();
    await expect(newsletterLink.getByText("Communications", { exact: true })).toBeVisible();
    await expect(newsletterLink.getByText("FRG Newsletter", { exact: true })).toBeVisible();
    await expect(newsletterLink.getByText("Open newsletter", { exact: true })).toBeVisible();
    expect(await newsletterLink.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )).toBeTruthy();

    await newsletterLink.click();
    await expect(page).toHaveURL(/#\/newsletter$/);
    await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
  });

  test("platoon cards stay contained at desktop and docked widths", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Desktop containment is covered once in Chromium.");
    await seedQaRootSession(page);

    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ADMIN_URL);

      const main = page.locator("main");
      const grid = page.locator(".platform-platoon-grid");
      const firstCard = grid.locator(".platform-platoon-card").first();
      await expect(grid).toBeVisible();
      await expect(firstCard).toBeVisible();

      const [mainBox, gridBox, cardBox] = await Promise.all([
        main.boundingBox(),
        grid.boundingBox(),
        firstCard.boundingBox()
      ]);
      expect(gridBox.x).toBeGreaterThanOrEqual(mainBox.x - 1);
      expect(gridBox.x + gridBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
      expect(cardBox.x).toBeGreaterThanOrEqual(mainBox.x - 1);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
      expect(await grid.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      expect(await firstCard.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )).toBeTruthy();
    }
  });

  test("a user-list error stays visible and can be retried without hiding platoons", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "The recoverable load state is covered once in Chromium.");
    let userLoadCount = 0;
    let userLoadShouldFail = true;
    const retryUser = {
      id: "77777777-7777-4777-8777-777777777777",
      email: "retry-user@876en.test",
      displayName: "Retry User",
      memberships: [{
        id: "88888888-8888-4888-8888-888888888888",
        tenantId: "11111111-1111-4111-8111-111111111111",
        tenantSlug: "ms",
        tenantName: "MS Platoon",
        role: "contributor",
        status: "active"
      }]
    };
    await page.route("**/api/platform/users**", async route => {
      userLoadCount += 1;
      if (userLoadShouldFail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary user directory failure" })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ users: [retryUser], management: { mutationsAvailable: true } })
      });
    });
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("region", { name: "Platoon workspaces" })).toBeVisible();

    await activatePlatformNav(page, "Users", false);
    const loadAlert = page.getByRole("alert").filter({ hasText: "Could not load users" });
    await expect(loadAlert).toBeVisible();
    const attemptsBeforeRetry = userLoadCount;
    userLoadShouldFail = false;
    await loadAlert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => userLoadCount).toBeGreaterThan(attemptsBeforeRetry);
    await expect(loadAlert).toHaveCount(0);
    const retryRow = page.getByRole("row").filter({ hasText: "Retry User" });
    await expect(retryRow).toBeVisible();

    userLoadShouldFail = true;
    await page.getByRole("button", { name: "Refresh platform", exact: true }).click();
    await expect(loadAlert).toBeVisible();
    await expect(retryRow).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /for Retry User in MS Platoon/ })).toHaveCount(0);

    userLoadShouldFail = false;
    await loadAlert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(loadAlert).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "Retry User" })).toBeVisible();
  });
});
