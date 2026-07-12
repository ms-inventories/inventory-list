import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaNco = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function qaHeaders(identity, tenantSlug) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": tenantSlug
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function openWorkspaceTab(page, name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  const tab = page.getByRole("button", { name, exact: true });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
}

async function signIn(page, tenantSlug, persona) {
  await page.goto(`http://${tenantSlug}.localhost:5175/#/admin`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

test.describe("tenant settings", () => {
  test("platoon admins persist workspace identity and notification behavior without exposing routing internals", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const mobile = testInfo.project.name === "mobile-chrome";
    const tenantSlug = mobile ? "qa-settings-mobile" : "qa-settings-desktop";
    const identity = qaRoot;
    const persona = "Root admin";
    const headers = qaHeaders(identity, tenantSlug);
    const baseline = (await responseJson(await request.get(`${API_URL}/tenant/settings`, { headers }))).settings;
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const displayName = `QA Settings ${suffix}`;

    try {
      await signIn(page, tenantSlug, persona);
      await openWorkspaceTab(page, "Workspace Settings");
      await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Workspace profile" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Notification preferences" })).toBeVisible();
      await expect(page.getByText(`http://${tenantSlug}.localhost:5175/`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Copy workspace URL" })).toBeVisible();

      await expect(page.locator(".leader-nav").getByText("Inventory Guidance", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Guidance", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Routing & Authentik" })).toHaveCount(0);
      await expect(page.getByText("Tenant group", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Admin group", { exact: true })).toHaveCount(0);
      await expect(page.getByText(`876en-${tenantSlug}`, { exact: true })).toHaveCount(0);
      await expect(page.getByText("876en-platoon-admin", { exact: true })).toHaveCount(0);

      await page.getByLabel("Display name", { exact: true }).fill(displayName);
      await page.getByLabel("Open rows").uncheck();
      await page.getByLabel("Packet imports").uncheck();
      await page.getByLabel("Email proof requests").uncheck();
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByText("Workspace settings saved.", { exact: true })).toBeVisible();

      if (mobile) {
        await page.getByRole("button", { name: "Open workspace menu" }).click();
      }
      await expect(page.locator(".leader-system-card")).toContainText(displayName);

      const saved = (await responseJson(await request.get(`${API_URL}/tenant/settings`, { headers }))).settings;
      expect(saved.displayName).toBe(displayName);
      expect(saved.notificationPreferences.open_rows).toBeFalsy();
      expect(saved.notificationPreferences.packet_imports).toBeFalsy();
      expect(saved.workspace.slug).toBe(tenantSlug);

      const tenant = await responseJson(await request.get(`${API_URL}/tenant`, { headers }));
      expect(tenant.tenant.name).toBe(displayName);
      const notifications = await responseJson(await request.get(`${API_URL}/tenant/notifications`, { headers }));
      expect(notifications.notifications.some(item => item.type === "assignment")).toBeFalsy();
      expect(notifications.notifications.some(item => item.type === "packet_import")).toBeFalsy();

      for (const [body, expectedCode] of [
        [{ slug: "cannot-change" }, "validation_failed"],
        [{ displayName: "Bad\nName" }, "validation_failed"],
        [{ notificationPreferences: { unknown_alert: true } }, "validation_failed"]
      ]) {
        const invalid = await request.patch(`${API_URL}/tenant/settings`, { headers, data: body });
        expect(invalid.status()).toBe(400);
        expect((await invalid.json()).code).toBe(expectedCode);
      }

      await page.reload();
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      await openWorkspaceTab(page, "Workspace Settings");
      await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(displayName);
      await expect(page.getByLabel("Guidance", { exact: true })).toHaveCount(0);
      await expect(page.locator(".leader-nav").getByText("Inventory Guidance", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
    } finally {
      await request.patch(`${API_URL}/tenant/settings`, {
        headers,
        data: {
          displayName: baseline.displayName,
          notificationPreferences: baseline.notificationPreferences
        }
      });
    }
  });

  test("contributors cannot see or call workspace settings", async ({ page, request }) => {
    await signIn(page, "ms", "NCO");
    await expect(page.locator(".leader-nav").getByText("Inventory Guidance", { exact: true })).toHaveCount(0);
    const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await expect(page.getByRole("button", { name: "Workspace Settings", exact: true })).toHaveCount(0);

    const headers = qaHeaders(qaNco, "ms");
    expect((await request.get(`${API_URL}/tenant/settings`, { headers })).status()).toBe(403);
    expect((await request.patch(`${API_URL}/tenant/settings`, {
      headers,
      data: { displayName: "Not allowed" }
    })).status()).toBe(403);
    expect((await request.get(`${API_URL}/tenant/settings`, {
      headers: qaHeaders(qaNco, "qa-other")
    })).status()).toBe(403);
  });
});
