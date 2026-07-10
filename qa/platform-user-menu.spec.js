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

test.describe("Platform user menu", () => {
  test("account trigger opens real platform account actions", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    await page.locator(".platform-topbar .leader-user-trigger").click({ force: true });

    const menu = page.getByLabel("Account menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Profile", { exact: true })).toBeVisible();
    await expect(menu.getByText("QA Root Admin")).toBeVisible();
    await expect(menu.getByText("qa-root@876en.test")).toBeVisible();
    await expect(menu.getByRole("button", { name: "App portal" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();

    await menu.getByRole("button", { name: "Diagnostics", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deployment details" })).toBeVisible();
    await expect(menu).toBeHidden();
  });
});
