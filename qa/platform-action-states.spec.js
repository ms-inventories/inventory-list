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

    await page.getByRole("button", { name: "Create platoon", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create platoon" });
    const form = dialog.locator("form");
    await dialog.getByLabel("Platoon name").fill(name);
    await dialog.getByLabel("Subdomain").fill(slug);

    await form.evaluate(element => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect.poll(() => createAttempts).toBe(1);
    await expect(dialog.getByRole("button", { name: "Creating platoon..." })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close create platoon" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(dialog.getByLabel("Platoon name")).toBeDisabled();
    await expect(dialog.getByLabel("Subdomain")).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("Temporary platoon creation failure");
    await expect(dialog.getByLabel("Platoon name")).toHaveValue(name);
    await expect(dialog.getByLabel("Subdomain")).toHaveValue(slug);
    expect(createAttempts).toBe(1);

    await dialog.getByRole("button", { name: "Create platoon", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`Created ${slug}.localhost.`);
    expect(createAttempts).toBe(2);

    await openPlatformView(page, "Platoons", isMobileProject);
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
    await page.getByPlaceholder("Search platoons by name or subdomain...").fill("no-such-platoon");
    await expect(page.getByText("No matching platoons", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();

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

  test("an initial platoon load failure offers one clear retry", async ({ page }) => {
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
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => loadAttempts).toBe(failedLoadAttempts + 1);
    await expect(page.getByRole("status")).toContainText("Platform refreshed.");
    await expect(page.getByText("Could not load platoons", { exact: true })).toHaveCount(0);
  });
});
