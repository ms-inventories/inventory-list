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

test.describe("Platform support", () => {
  test("support shows the owner contact and keeps technical diagnostics secondary", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Support", isMobileProject);

    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
    await expect(page.getByText("Get help with Shadow Tracer or open technical diagnostics.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Need help with Shadow Tracer?" })).toBeVisible();
    const contact = page.getByRole("link", { name: "tm.lewisbenson@gmail.com" });
    await expect(contact).toHaveAttribute("href", "mailto:tm.lewisbenson@gmail.com");

    const diagnostics = page.getByText("Technical diagnostics", { exact: true });
    await expect(diagnostics).toBeVisible();
    await diagnostics.click();
    await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();

    await expect(page.getByText("Current URL", { exact: true })).toBeVisible();
    await expect(page.getByText("Base domain", { exact: true })).toBeVisible();
    await expect(page.getByText("API base URL", { exact: true })).toBeVisible();
    await expect(page.getByText("API health", { exact: true })).toBeVisible();
    await expect(page.getByText("App launcher", { exact: true })).toBeVisible();
    await expect(page.getByText("Signed in as", { exact: true })).toBeVisible();
  });
});
