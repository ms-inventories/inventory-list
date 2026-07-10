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

test.describe("Tenant user menu", () => {
  test("user card opens account actions and signs out cleanly", async ({ page }) => {
    await openTenant(page);

    await page.getByRole("button", { name: "Open user menu" }).click();

    const menu = page.getByRole("region", { name: "User menu" });
    await expect(menu).toBeVisible();
    const profile = menu.locator(".leader-profile-summary");
    await expect(profile.getByText("QA Platoon Admin")).toBeVisible();
    await expect(profile.locator("span").filter({ hasText: /^Platoon admin$/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Workspace home" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Switch workspace" })).toBeVisible();
    await expect(menu.locator("summary", { hasText: "Access details" })).toBeVisible();

    await menu.locator("summary", { hasText: "Access details" }).click();
    const details = menu.locator(".leader-menu-details");
    await expect(details.locator("dt").filter({ hasText: /^Workspace$/ })).toBeVisible();
    await expect(details.locator("dd").filter({ hasText: /^MS Platoon$/ })).toBeVisible();
    await expect(details.locator("dd").filter({ hasText: /^qa-lead@876en\.test$/ })).toBeVisible();

    await menu.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
