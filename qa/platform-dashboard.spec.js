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
  test("dashboard nav opens a real platform overview and shortcuts", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByText("Total platoons", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent platoons" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Admin actions" })).toBeVisible();

    await activatePlatformNav(page, "Platoons", isMobileProject);
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Search platoons by name or subdomain...")).toBeVisible();

    await activatePlatformNav(page, "Dashboard", isMobileProject);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    const reviewUsersShortcut = page.getByRole("button", { name: "Review users" });
    await expect(reviewUsersShortcut).toBeVisible();
    if (isMobileProject) {
      await activatePlatformNav(page, "Users", true);
    } else {
      await reviewUsersShortcut.click();
    }
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
});
