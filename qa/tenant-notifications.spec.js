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

test.describe("Tenant notifications", () => {
  test("bell opens a notification panel with useful workspace actions", async ({ page }) => {
    await openTenant(page);

    await page.getByRole("button", { name: "Notifications" }).click();

    const panel = page.getByRole("region", { name: "Notifications" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Refresh alerts" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Open sessions" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Open review queue" })).toBeVisible();

    await panel.getByRole("button", { name: "Open sessions" }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Open review queue" }).click();
    await expect(page.getByRole("heading", { name: "Review Queue" })).toBeVisible();
  });
});
