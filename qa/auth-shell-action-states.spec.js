import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";

const qaNco = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

async function seedQaSession(page, identity) {
  await page.addInitScript(seed => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(seed));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

async function doubleClickBeforeReactCommit(locator) {
  await locator.evaluate(button => {
    button.click();
    button.click();
  });
}

test.describe("fallback authentication shell action states", () => {
  test("QA sign-in is single-shot and keeps the selected action visible", async ({ page }) => {
    let meRequests = 0;
    await page.route("**/api/me", async route => {
      const headers = route.request().headers();
      if (route.request().method() !== "GET" || headers["x-dev-sub"] !== "qa-root") {
        await route.continue();
        return;
      }
      meRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.continue();
    });

    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: "QA users" }).click();

    const rootAdmin = page.getByRole("button", { name: "Root admin", exact: true });
    await doubleClickBeforeReactCommit(rootAdmin);
    await expect(page.getByRole("button", { name: "Signing in...", exact: true })).toBeDisabled();
    await expect.poll(() => meRequests).toBe(1);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    expect(meRequests).toBe(1);
  });

  test("access refresh rejects duplicate taps and names the pending request", async ({ page }) => {
    let trackRefresh = false;
    let refreshRequests = 0;
    await page.route("**/api/me", async route => {
      if (trackRefresh && route.request().method() === "GET") {
        refreshRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 450));
      }
      await route.continue();
    });

    await seedQaSession(page, qaNco);
    await page.goto(ADMIN_URL);
    await expect(page.getByText("Platform access required", { exact: true })).toBeVisible();
    trackRefresh = true;

    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await doubleClickBeforeReactCommit(refresh);
    await expect.poll(() => refreshRequests).toBe(1);
    await expect(page.getByRole("button", { name: "Refreshing...", exact: true })).toBeDisabled();
    await expect(refresh).toBeEnabled();
    expect(refreshRequests).toBe(1);
  });
});
