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

async function openPlatformView(page, name, isMobileProject) {
  if (isMobileProject) await page.getByRole("button", { name: "Open platform menu" }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

function mockedTenant(slug, name) {
  return {
    id: `qa-${slug}`,
    slug,
    name,
    status: "active",
    createdAt: new Date().toISOString(),
    memberCount: 0,
    adminCount: 0
  };
}

test.describe("platform async action states", () => {
  test("creation recovers in place and create and refresh reject duplicate taps", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    const suffix = `${Date.now()}-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const slug = `qa-guard-${suffix}`.toLowerCase().slice(0, 63).replace(/-+$/, "");
    const name = `QA Guard ${testInfo.project.name}`;
    const tenant = mockedTenant(slug, name);
    let createAttempts = 0;
    let created = false;
    let trackRefresh = false;
    let refreshAttempts = 0;

    await page.route("**/api/platform/tenants", async route => {
      const method = route.request().method();
      if (method === "POST") {
        createAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 500));
        if (createAttempts === 1) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary platoon creation failure" })
          });
          return;
        }
        created = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ tenant, adminMembership: null })
        });
        return;
      }

      if (method === "GET" && created) {
        if (trackRefresh) {
          refreshAttempts += 1;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ tenants: [tenant], provisioningAvailable: false })
        });
        return;
      }

      await route.continue();
    });

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    await openPlatformView(page, "Settings", isMobileProject);
    await page.getByRole("button", { name: "Create platoon", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create platoon" });
    const form = dialog.locator("form");
    await dialog.getByLabel("Platoon name").fill(name);
    await dialog.getByLabel("Workspace link").fill(slug);

    await form.evaluate(element => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect.poll(() => createAttempts).toBe(1);
    await expect(dialog.getByRole("button", { name: "Creating platoon..." })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close create platoon" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(dialog.getByLabel("Platoon name")).toBeDisabled();
    await expect(dialog.getByLabel("Workspace link")).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("Temporary platoon creation failure");
    await expect(dialog.getByLabel("Platoon name")).toHaveValue(name);
    await expect(dialog.getByLabel("Workspace link")).toHaveValue(slug);
    expect(createAttempts).toBe(1);

    await dialog.getByRole("button", { name: "Create platoon", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`Created ${slug}.localhost.`);
    expect(createAttempts).toBe(2);

    await openPlatformView(page, "Dashboard", isMobileProject);
    await expect(page.locator(".platform-platoon-card").filter({ hasText: name })).toBeVisible();

    trackRefresh = true;
    if (isMobileProject) await page.getByRole("button", { name: "Open account actions" }).click();
    const refreshButton = page.getByRole("button", { name: "Refresh platform" });
    await refreshButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect.poll(() => refreshAttempts).toBe(1);
    if (isMobileProject) await page.getByRole("button", { name: "Open account actions" }).click();
    await expect(page.getByRole("button", { name: /Refreshing platform/ })).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("Platform refreshed.");
    expect(refreshAttempts).toBe(1);
  });

  test("duplicate admin email requires an eligible identity choice before creating a platoon", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    const blockedIdentityId = "91111111-1111-4111-8111-111111111111";
    const selectedIdentityId = "92222222-2222-4222-8222-222222222222";
    const slug = `qa-identity-${Date.now()}`.slice(0, 63);
    const name = "QA Identity Platoon";
    const adminEmail = "duplicate-admin@example.test";
    const adminDisplayName = "Duplicate Admin";
    const tenant = mockedTenant(slug, name);
    const identityChecks = [];
    const createBodies = [];
    let created = false;

    await page.route("**/api/platform/identity-check", async route => {
      identityChecks.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "ambiguous",
          candidateCount: 2,
          candidates: [
            {
              id: blockedIdentityId,
              username: "privileged.duplicate",
              displayName: "Privileged duplicate",
              active: true,
              eligible: false,
              blockedReason: "Privileged administrator accounts cannot be linked through a platoon invite."
            },
            {
              id: selectedIdentityId,
              username: "field.leader",
              displayName: "Field leader",
              active: true,
              eligible: true,
              blockedReason: null
            }
          ]
        })
      });
    });
    await page.route("**/api/platform/tenants", async route => {
      if (route.request().method() === "POST") {
        createBodies.push(route.request().postDataJSON());
        created = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ tenant, adminMembership: null })
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tenants: created ? [tenant] : [],
          provisioningAvailable: true,
          setup: { tenants: {} }
        })
      });
    });

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await openPlatformView(page, "Settings", isMobileProject);
    await page.getByRole("button", { name: "Create platoon", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Create platoon" });
    await dialog.getByLabel("Platoon name").fill(name);
    await dialog.getByLabel("Workspace link").fill(slug);
    await dialog.getByLabel("Platoon admin email").fill("Duplicate-Admin@Example.Test");
    await dialog.getByLabel("Platoon admin name").fill(adminDisplayName);

    const createButton = dialog.getByRole("button", { name: "Create platoon", exact: true });
    await createButton.click();

    await expect(dialog.getByRole("group", { name: "Choose the correct sign-in account" })).toBeVisible();
    const blockedChoice = dialog.getByRole("radio", { name: /Privileged duplicate/ });
    const eligibleChoice = dialog.getByRole("radio", { name: /Field leader/ });
    await expect(blockedChoice).toBeDisabled();
    await expect(eligibleChoice).toBeEnabled();
    expect(identityChecks).toEqual([{ email: adminEmail }]);
    expect(createBodies).toEqual([]);
    await expect(createButton).toBeDisabled();

    await eligibleChoice.check();
    await expect(createButton).toBeEnabled();
    await createButton.click();

    await expect.poll(() => createBodies.length).toBe(1);
    expect(identityChecks).toEqual([{ email: adminEmail }, { email: adminEmail }]);
    expect(createBodies[0]).toEqual({
      name,
      slug,
      adminEmail,
      adminDisplayName,
      authentikUserUuid: selectedIdentityId
    });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`Created ${slug}.localhost.`);
  });

  test("an initial platoon load failure offers one clear retry", async ({ page }, testInfo) => {
    const isMobileProject = Boolean(testInfo.project.use.isMobile);
    let loadAttempts = 0;
    let allowLoad = false;
    await page.route("**/api/platform/tenants", async route => {
      if (route.request().method() !== "GET") return route.continue();
      loadAttempts += 1;
      if (!allowLoad) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary platform load failure" })
        });
        return;
      }
      await route.continue();
    });

    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("alert")).toContainText("Temporary platform load failure");
    await expect(page.getByText("Could not load platoons", { exact: true })).toBeVisible();
    const failedLoadAttempts = loadAttempts;
    allowLoad = true;
    if (isMobileProject) await page.getByRole("button", { name: "Open account actions" }).click();
    await page.getByRole("button", { name: "Refresh platform" }).click();
    await expect.poll(() => loadAttempts).toBe(failedLoadAttempts + 1);
    await expect(page.getByRole("status")).toContainText("Platform refreshed.");
    await expect(page.getByText("Could not load platoons", { exact: true })).toHaveCount(0);
  });
});
