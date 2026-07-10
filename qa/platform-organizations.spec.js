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
  const button = page.getByRole("button", { name, exact: true });
  if (isMobileProject) {
    await button.evaluate(element => {
      element.scrollIntoView({ block: "nearest", inline: "center" });
      element.click();
    });
    return;
  }
  await button.click();
}

test.describe("Platform organizations", () => {
  test("organizations nav opens organization overview", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Organizations", isMobileProject);

    await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
    await expect(page.getByText("Review the organization container and workspace totals.")).toBeVisible();
    await expect(page.getByText("Total platoons", { exact: true })).toBeVisible();
    await expect(page.getByText("Active platoons", { exact: true })).toBeVisible();
    await expect(page.getByText("Total users", { exact: true })).toBeVisible();
    await expect(page.getByText("Admins assigned", { exact: true })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Organization overview" })).toBeVisible();
    await expect(page.getByText("876 EN", { exact: true })).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
  });
});
