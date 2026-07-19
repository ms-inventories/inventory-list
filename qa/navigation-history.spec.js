import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function seedSession(page, identity) {
  await page.addInitScript(currentIdentity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(currentIdentity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

async function openPlatformPage(page, name, isMobile) {
  if (isMobile) await page.getByRole("button", { name: "Open platform menu" }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function openTenantPage(page, name, isMobile) {
  if (isMobile) await page.getByRole("button", { name: "Open workspace menu" }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

test("platform Back and Forward navigation stays inside the signed-in app", async ({ page }, testInfo) => {
  const isMobile = Boolean(testInfo.project.use.isMobile);
  let authorizeCount = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/me**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      user: { id: "qa-root", email: "qa-root@876en.test", display_name: "QA Root Admin" },
      identity: { subject: "qa-root", email: "qa-root@876en.test", displayName: "QA Root Admin" },
      groups: ["876en-admins"],
      isPlatformAdmin: true,
      isFrgAdmin: true,
      workspaces: []
    })
  }));
  await page.route("**/api/platform/tenants", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ tenants: [], provisioningAvailable: false, setup: { tenants: {} } })
  }));
  await page.route("**/api/platform/users", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ users: [], management: { mutationsAvailable: false } })
  }));
  await page.route("**/api/newsletter/admin", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      issues: [],
      contentBlocks: [],
      subscribers: [],
      deliveries: [],
      subscriberStats: { pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 },
      deliverySettings: { emailConfigured: false }
    })
  }));

  await seedSession(page, {
    sub: "qa-root",
    email: "qa-root@876en.test",
    name: "QA Root Admin",
    groups: ["876en-admins"]
  });
  await page.goto(ADMIN_URL);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  await openPlatformPage(page, "Users", isMobile);
  await expect(page).toHaveURL(/#\/admin\/users$/);
  await openPlatformPage(page, "Settings", isMobile);
  await expect(page).toHaveURL(/#\/admin\/settings$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  await openPlatformPage(page, "Newsletter", isMobile);
  await expect(page).toHaveURL(/#\/newsletter$/);
  await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "Open newsletter menu" }).click();
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(page).toHaveURL(/#\/newsletter\/issues$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/newsletter$/);
  await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  expect(authorizeCount).toBe(0);
});

test("platoon Back navigation returns through workspace pages without reauthentication", async ({ page }, testInfo) => {
  const isMobile = Boolean(testInfo.project.use.isMobile);
  let authorizeCount = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/me**", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      user: { id: "qa-lead", email: "qa-lead@876en.test", display_name: "QA Platoon Admin" },
      identity: { subject: "qa-lead", email: "qa-lead@876en.test", displayName: "QA Platoon Admin" },
      groups: ["876en-ms", "876en-platoon-admin"],
      isPlatformAdmin: false,
      isFrgAdmin: false,
      tenant: { id: "qa-tenant", slug: "ms", name: "MS Platoon", status: "active" },
      membership: { role: "tenant_admin", status: "active" },
      workspaces: [{ slug: "ms", name: "MS Platoon", role: "tenant_admin" }]
    })
  }));
  await page.route("**/api/tenant/notifications", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ notifications: [], unreadCount: 0 })
  }));
  await page.route("**/api/tenant", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ tenant: { id: "qa-tenant", slug: "ms", name: "MS Platoon", status: "active" } })
  }));
  await page.route("**/api/tenant/members", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ members: [], provisioningAvailable: false })
  }));
  await page.route("**/api/tenant/invitations", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ invitations: [] })
  }));
  await page.route("**/api/inventory/sessions", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] })
  }));
  await page.route("**/api/inventory/review-queue", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ submissions: [] })
  }));
  await page.route("**/api/inventory/reports", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [], rows: [] })
  }));

  await seedSession(page, {
    sub: "qa-lead",
    email: "qa-lead@876en.test",
    name: "QA Platoon Admin",
    groups: ["876en-ms", "876en-platoon-admin"]
  });
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

  await openTenantPage(page, "Reports", isMobile);
  await expect(page).toHaveURL(/#\/admin\/reports$/);
  await openTenantPage(page, "Team", isMobile);
  await expect(page).toHaveURL(/#\/admin\/team$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/admin\/reports$/);
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  expect(authorizeCount).toBe(0);
});
