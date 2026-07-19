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
    workspace: `${workspace}#/launch`
  };
}

test.describe("Platform platoon card actions", () => {
  test("dashboard cards expose one workspace destination and a visible copy action", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    const tenantUrls = expectedTenantUrls("ms");
    const card = page.locator(".platform-platoon-card").filter({ hasText: tenantUrls.host }).first();
    await expect(card).toBeVisible();

    const workspaceLink = card.getByRole("link", { name: `Enter ${tenantUrls.host} workspace` });
    await expect(workspaceLink).toHaveCount(1);
    await expect(workspaceLink).toHaveAttribute("href", tenantUrls.workspace);
    await expect(workspaceLink).toContainText("Enter workspace");
    await expect(card.getByRole("link", { name: /admin view/i })).toHaveCount(0);
    await expect(card.getByText("Admin view", { exact: true })).toHaveCount(0);

    await expect(card.getByRole("button", { name: "Copy link for MS Platoon" })).toBeVisible();
    await expect(card.getByRole("button", { name: /More actions/i })).toHaveCount(0);
  });
});
