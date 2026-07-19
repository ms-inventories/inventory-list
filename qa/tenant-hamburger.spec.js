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

test.describe("Tenant hamburger menu", () => {
  test("desktop hamburger collapses and expands the sidebar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Desktop-only sidebar collapse behavior.");

    await openTenant(page);

    const shell = page.locator(".leader-shell");
    await expect(shell).not.toHaveClass(/sidebar-collapsed/);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(shell).toHaveClass(/sidebar-collapsed/);
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(shell).not.toHaveClass(/sidebar-collapsed/);
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("mobile hamburger opens the nav drawer and closes after navigation", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "Mobile-only drawer behavior.");

    await openTenant(page);

    const shell = page.locator(".leader-shell");
    await expect(shell).not.toHaveClass(/sidebar-open/);

    await page.getByRole("button", { name: "Open workspace menu" }).click();
    await expect(shell).toHaveClass(/sidebar-open/);

    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(shell).not.toHaveClass(/sidebar-open/);
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  });
});
