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

function expectedTenantUrls(slug) {
  const adminUrl = new URL(ADMIN_URL);
  const baseHost = adminUrl.hostname.replace(/^admin\./, "");
  const host = `${slug}.${baseHost}`;
  const port = adminUrl.port ? `:${adminUrl.port}` : "";
  const workspace = `${adminUrl.protocol}//${host}${port}/`;
  return {
    host,
    workspace
  };
}

test.describe("Platform tenant row actions", () => {
  test("platoon rows expose one workspace destination and a copy action", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Platoons", isMobileProject);
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();

    const tenantUrls = expectedTenantUrls("ms");
    const row = page.getByRole("row").filter({ hasText: tenantUrls.host }).first();
    await expect(row).toBeVisible();

    const workspaceLink = row.getByRole("link", { name: `Open ${tenantUrls.host} workspace` });
    await expect(workspaceLink).toHaveCount(1);
    await expect(workspaceLink).toHaveAttribute("href", tenantUrls.workspace);
    await expect(workspaceLink).toContainText("Open workspace");
    await expect(row.getByRole("link", { name: /admin view/i })).toHaveCount(0);
    await expect(row.getByText("Admin view", { exact: true })).toHaveCount(0);

    if (isMobileProject) await row.getByRole("button", { name: "More actions for MS Platoon" }).click();
    await expect(row.getByRole("button", { name: "Copy link" })).toBeVisible();
  });
});
