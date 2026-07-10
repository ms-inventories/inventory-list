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

function expectedTenantUrls(slug) {
  const adminUrl = new URL(ADMIN_URL);
  const baseHost = adminUrl.hostname.replace(/^admin\./, "");
  const host = `${slug}.${baseHost}`;
  const port = adminUrl.port ? `:${adminUrl.port}` : "";
  const workspace = `${adminUrl.protocol}//${host}${port}/`;
  return {
    host,
    workspace,
    admin: `${workspace}#/admin`
  };
}

test.describe("Platform tenant row actions", () => {
  test("platoon rows expose clear workspace, admin, and copy actions", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await page.getByRole("button", { name: "Platoons", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();

    const tenantUrls = expectedTenantUrls("ms");
    const row = page.getByRole("row").filter({ hasText: tenantUrls.host }).first();
    await expect(row).toBeVisible();

    const workspaceLink = row.getByRole("link", { name: `Open ${tenantUrls.host} workspace` });
    await expect(workspaceLink).toHaveAttribute("href", tenantUrls.workspace);
    await expect(workspaceLink).toContainText("Open workspace");

    const adminLink = row.getByRole("link", { name: `Open ${tenantUrls.host} admin view` });
    await expect(adminLink).toHaveAttribute("href", tenantUrls.admin);
    await expect(adminLink).toContainText("Admin view");

    await expect(row.getByRole("button", { name: "Copy link" })).toBeVisible();
  });
});
