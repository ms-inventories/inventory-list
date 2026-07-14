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

test.describe("Platform users", () => {
  test("users nav opens workspace access coverage", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Users", isMobileProject);

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
      const tableHeader = accessTable.locator(".platform-table-head");
      await expect(tableHeader.getByText("Workspace", { exact: true })).toBeVisible();
      await expect(tableHeader.getByText("Admin group", { exact: true })).toBeVisible();
      await expect(tableHeader.getByText("Members", { exact: true })).toBeVisible();
      await expect(tableHeader.getByText("Admins", { exact: true })).toBeVisible();
      await expect(tableHeader.getByText("Actions", { exact: true })).toBeVisible();
    }

    const accessRow = accessTable.getByRole("row").filter({ hasText: "MS Platoon" }).first();
    const workspaceLink = accessRow.getByRole("link", { name: /Open ms\.localhost workspace/ });
    await expect(workspaceLink).toHaveCount(1);
    await expect(workspaceLink).toBeVisible();
    await expect(accessRow.getByRole("link", { name: /admin view/i })).toHaveCount(0);
    if (isMobileProject) {
      await accessRow.getByRole("button", { name: "More actions for MS Platoon" }).click();
    }
    await expect(accessRow.getByRole("button", { name: "Copy link" })).toBeVisible();

    await page.getByPlaceholder("Search access by platoon or subdomain...").fill("no matching workspace");
    await expect(page.getByText("No user coverage found")).toBeVisible();
  });
});
