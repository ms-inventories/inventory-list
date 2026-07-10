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

test.describe("Platform users", () => {
  test("users nav opens workspace access coverage", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await page.getByRole("button", { name: "Users", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByText("Review account coverage across active workspaces.")).toBeVisible();
    await expect(page.getByPlaceholder("Search access by platoon or subdomain...")).toBeVisible();

    const accessTable = page.getByRole("table", { name: "Workspace access" });
    await expect(accessTable).toBeVisible();
    await expect(accessTable).toContainText("Workspace");
    await expect(accessTable).toContainText("Admin group");
    await expect(accessTable).toContainText("Members");
    await expect(accessTable).toContainText("Admins");
    await expect(accessTable).toContainText("Actions");
    if (!isMobileProject) {
      await expect(accessTable.getByText("Workspace", { exact: true })).toBeVisible();
      await expect(accessTable.getByText("Admin group", { exact: true })).toBeVisible();
      await expect(accessTable.getByText("Members", { exact: true })).toBeVisible();
      await expect(accessTable.getByText("Admins", { exact: true })).toBeVisible();
      await expect(accessTable.getByText("Actions", { exact: true })).toBeVisible();
    }

    await page.getByPlaceholder("Search access by platoon or subdomain...").fill("no matching workspace");
    await expect(page.getByText("No user coverage found")).toBeVisible();
  });
});
