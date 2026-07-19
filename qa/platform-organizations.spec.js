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

test.describe("Platform settings", () => {
  test("settings holds infrequent platoon creation, totals, and technical checks", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Settings", isMobileProject);

    await expect(page.getByRole("heading", { name: "Platform settings", exact: true })).toBeVisible();
    await expect(page.getByText("Create platoons and review technical workspace setup when needed.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platoon management" })).toBeVisible();
    const totals = page.getByRole("table", { name: "Platform totals" });
    await expect(totals.getByRole("row")).toHaveCount(4);
    await expect(totals).toContainText("Total platoons");
    await expect(totals).toContainText("Active platoons");
    await expect(totals).toContainText("Permanent users");
    await expect(totals).toContainText("Platoon admins");

    const setup = page.getByText("Technical workspace checks", { exact: true });
    await expect(setup).toBeVisible();
    await setup.click();
    await expect(page.getByRole("combobox", { name: "Platoon setup" })).toBeVisible();

    await page.getByRole("button", { name: "Create platoon", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create platoon" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Platoon name")).toBeVisible();
    await expect(dialog.getByLabel("Workspace link")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});
