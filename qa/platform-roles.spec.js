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

test.describe("Platform roles", () => {
  test("roles nav opens Authentik group mapping guidance", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Roles", isMobileProject);

    await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();
    await expect(page.getByText("Confirm which groups unlock platform, platoon, and public-site access.")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Platform admin" })).toBeVisible();
    await expect(page.getByText("876en-admins", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "FRG admin" })).toBeVisible();
    await expect(page.getByText("876en-frg-admins", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platoon admin" })).toBeVisible();
    await expect(page.getByText("876en-platoon-admin", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platoon member" })).toBeVisible();
    await expect(page.getByText("876en-{platoon}", { exact: true })).toBeVisible();
  });
});
