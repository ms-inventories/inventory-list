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

test.describe("Platform support", () => {
  test("support nav opens deployment diagnostics", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Support", isMobileProject);

    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
    await expect(page.getByText("Check safe deploy details before troubleshooting.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deployment details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();

    await expect(page.getByText("Current URL", { exact: true })).toBeVisible();
    await expect(page.getByText("Base domain", { exact: true })).toBeVisible();
    await expect(page.getByText("API base URL", { exact: true })).toBeVisible();
    await expect(page.getByText("API health", { exact: true })).toBeVisible();
    await expect(page.getByText("App launcher", { exact: true })).toBeVisible();
    await expect(page.getByText("Signed in as", { exact: true })).toBeVisible();
  });
});
