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
  test("dashboard navigation opens a focused platform overview", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByText("Total platoons", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent platoons" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Admin actions" })).toHaveCount(0);

    await activatePlatformNav(page, "Platoons", isMobileProject);
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Search platoons by name or subdomain...")).toBeVisible();

    await activatePlatformNav(page, "Dashboard", isMobileProject);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    await activatePlatformNav(page, "Users", isMobileProject);
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();

    await activatePlatformNav(page, "Dashboard", isMobileProject);
    const viewAllShortcut = page.getByRole("button", { name: "View all" });
    await expect(viewAllShortcut).toBeVisible();
    if (isMobileProject) {
      await activatePlatformNav(page, "Platoons", true);
    } else {
      await viewAllShortcut.click();
    }
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();
  });

  test("recent platoons stays contained at desktop and docked widths", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Desktop containment is covered once in Chromium.");
    await seedQaRootSession(page);

    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ADMIN_URL);

      const main = page.locator("main");
      const recent = page.locator(".platform-dashboard-card").filter({ hasText: "Recent platoons" });
      const table = recent.getByRole("table");
      await expect(recent).toBeVisible();
      await expect(table).toBeVisible();

      const [mainBox, cardBox, tableBox] = await Promise.all([
        main.boundingBox(),
        recent.boundingBox(),
        table.boundingBox()
      ]);
      expect(cardBox.x).toBeGreaterThanOrEqual(mainBox.x - 1);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
      expect(tableBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      expect(await recent.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )).toBeTruthy();
    }
  });
});
