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
  test("users table manages platoon membership and adds permanent users", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    const tenant = {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "ms",
      name: "MS Platoon",
      status: "active",
      memberCount: 1,
      adminCount: 1,
      activeSessionCount: 0,
      activeTemporaryCrewCount: 0,
      latestActiveSession: null
    };
    let createdMemberBody = null;

    await page.route("**/api/platform/tenants", async route => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tenants: [tenant], provisioningAvailable: true, setup: { tenants: {} } })
      });
    });
    await page.route("**/api/platform/users", async route => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          users: [{
            id: "11111111-1111-4111-8111-111111111111",
            email: "qa-member@876en.test",
            displayName: "QA Member",
            accountType: "authentik",
            hasSignedIn: true,
            memberships: [{
              id: "22222222-2222-4222-8222-222222222222",
              tenantId: tenant.id,
              tenantSlug: tenant.slug,
              tenantName: tenant.name,
              role: "contributor",
              status: "active"
            }]
          }]
        })
      });
    });
    await page.route("**/api/tenant/members/identity-check", async route => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "new", candidates: [] }) });
    });
    await page.route("**/api/tenant/members", async route => {
      if (route.request().method() !== "POST") return route.continue();
      createdMemberBody = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ member: { id: "44444444-4444-4444-8444-444444444444", ...createdMemberBody, status: "invited" } })
      });
    });

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Users", isMobileProject);

    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByText("Manage permanent accounts, platoon access, and roles.")).toBeVisible();
    await expect(page.getByPlaceholder("Search users, platoons, or roles...")).toBeVisible();

    const accessTable = page.getByRole("table", { name: "Platform users" });
    await expect(accessTable).toBeVisible();
    await expect(accessTable).toContainText("User");
    await expect(accessTable).toContainText("Platoon");
    await expect(accessTable).toContainText("Role");
    await expect(accessTable).toContainText("Status");
    await expect(accessTable).toContainText("Actions");

    const accessRow = accessTable.getByRole("row").filter({ hasText: "QA Member" });
    await expect(accessRow).toContainText("qa-member@876en.test");
    await expect(accessRow).toContainText("MS Platoon");
    await expect(accessRow.getByRole("combobox", { name: "Role for QA Member in MS Platoon" })).toHaveValue("contributor");
    await expect(accessRow.getByRole("combobox", { name: "Status for QA Member in MS Platoon" })).toHaveValue("active");
    await expect(accessRow.getByRole("link", { name: "Open platoon" })).toHaveAttribute("href", "http://ms.localhost:5175/#/launch");

    await page.getByPlaceholder("Search users, platoons, or roles...").fill("no matching user");
    await expect(page.getByText("No matching users", { exact: true })).toBeVisible();
    await page.locator(".admin-empty").getByRole("button", { name: "Clear search" }).click();
    await expect(accessRow).toBeVisible();

    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a user" });
    await expect(dialog.getByLabel("Platoon")).toHaveValue("ms");
    await dialog.getByLabel("Email").fill("new-user@876en.test");
    await dialog.getByLabel("Name").fill("New User");
    await dialog.getByLabel("Role").selectOption("tenant_admin");
    await dialog.getByRole("button", { name: "Add user", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(createdMemberBody).toEqual({
      email: "new-user@876en.test",
      displayName: "New User",
      role: "tenant_admin"
    });
  });
});
