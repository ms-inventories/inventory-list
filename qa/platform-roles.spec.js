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

test.describe("Platform user roles", () => {
  test("role and account status changes live in Users and require confirmation", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    const userId = "11111111-1111-4111-8111-111111111111";
    const membershipId = "22222222-2222-4222-8222-222222222222";
    let role = "contributor";
    let status = "active";
    const updates = [];

    await page.route("**/api/platform/users", async route => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          users: [{
            id: userId,
            email: "qa-member@876en.test",
            displayName: "QA Member",
            accountType: "authentik",
            hasSignedIn: true,
            isPlatformAdmin: false,
            memberships: [{
              id: membershipId,
              tenantId: "33333333-3333-4333-8333-333333333333",
              tenantSlug: "ms",
              tenantName: "MS Platoon",
              role,
              status
            }]
          }]
        })
      });
    });
    await page.route(`**/api/tenant/members/${membershipId}`, async route => {
      const body = route.request().postDataJSON();
      updates.push(body);
      role = body.role || role;
      status = body.status || status;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ member: { id: membershipId, role, status } })
      });
    });

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await activatePlatformNav(page, "Users", isMobileProject);
    const roleSelect = page.getByRole("combobox", { name: "Role for QA Member in MS Platoon" });
    const statusSelect = page.getByRole("combobox", { name: "Status for QA Member in MS Platoon" });
    await expect(roleSelect).toHaveValue("contributor");
    await expect(statusSelect).toHaveValue("active");

    await roleSelect.selectOption("viewer");
    const roleDialog = page.getByRole("dialog", { name: "Change this user’s access?" });
    await expect(roleDialog).toContainText("QA Member");
    await expect(roleDialog).toContainText("Viewer");
    await roleDialog.getByRole("button", { name: "Confirm role change" }).click();
    await expect(roleDialog).toHaveCount(0);
    expect(updates[0]).toEqual({ role: "viewer" });

    await page.getByRole("combobox", { name: "Status for QA Member in MS Platoon" }).selectOption("disabled");
    const statusDialog = page.getByRole("dialog", { name: "Disable this account?" });
    await expect(statusDialog).toContainText("QA Member");
    await statusDialog.getByRole("button", { name: "Disable account" }).click();
    await expect(statusDialog).toHaveCount(0);
    expect(updates[1]).toEqual({ status: "disabled" });

    await page.getByRole("combobox", { name: "Status for QA Member in MS Platoon" }).selectOption("active");
    const enableDialog = page.getByRole("dialog", { name: "Enable this account?" });
    await enableDialog.getByRole("button", { name: "Enable account" }).click();
    await expect(enableDialog).toHaveCount(0);
    expect(updates[2]).toEqual({ status: "active" });

    await expect(page.getByRole("button", { name: "Roles", exact: true })).toHaveCount(0);
  });
});
