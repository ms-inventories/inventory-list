import { expect, test } from "@playwright/test";

const ROOT_CALLBACK_URL = process.env.QA_ROOT_CALLBACK_URL || "http://localhost:5175/?code=qa-code&state=qa-state#/launch";
const ADMIN_CALLBACK_URL = process.env.QA_ADMIN_CALLBACK_URL || "http://admin.localhost:5175/?code=qa-code&state=qa-state#/admin";
const TENANT_CALLBACK_URL = process.env.QA_TENANT_CALLBACK_URL || "http://ms.localhost:5175/?code=qa-code&state=qa-state#/admin";

const qaIdentities = {
  root: {
    sub: "qa-root",
    email: "qa-root@876en.test",
    name: "QA Root Admin",
    groups: ["876en-admins"]
  },
  lead: {
    sub: "qa-lead",
    email: "qa-lead@876en.test",
    name: "QA Platoon Admin",
    groups: ["876en-ms", "876en-platoon-admin"]
  }
};

async function seedOidcCallback(page, callbackUrl, identity, returnTo = "/#/launch") {
  const originUrl = new URL("/", callbackUrl).toString();
  await page.goto(originUrl);
  await page.evaluate(({ qaIdentity, oidcReturnTo }) => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(qaIdentity));
    sessionStorage.setItem("inventory.oidc.state", JSON.stringify({
      state: "qa-state",
      returnTo: oidcReturnTo,
      createdAt: Date.now()
    }));
    sessionStorage.setItem("inventory.oidc.verifier", "qa-verifier-value-long-enough-for-callback-tests");
  }, { qaIdentity: identity, oidcReturnTo: returnTo });
}

async function mockTokenExchange(page, { status = 200 } = {}) {
  await page.route("**/api/auth/oidc/token", async route => {
    if (status >= 400) {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "qa_token_exchange_failed" })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "qa-dev",
        token_type: "Bearer",
        expires_in: 3600
      })
    });
  });
  await page.route("**/api/auth/oidc/refresh", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      access_token: "qa-dev",
      token_type: "Bearer",
      refresh_available: true,
      expires_in: 3600
    })
  }));
}

test.describe("OIDC callback recovery", () => {
  test("root callback routes platform admins toward the platform workspace", async ({ page }) => {
    await seedOidcCallback(page, ROOT_CALLBACK_URL, qaIdentities.root, "/#/launch");
    await mockTokenExchange(page);

    await page.goto(ROOT_CALLBACK_URL);

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
  });

  test("admin callback completes on the admin host", async ({ page }) => {
    await seedOidcCallback(page, ADMIN_CALLBACK_URL, qaIdentities.root, "/#/admin");
    await mockTokenExchange(page);

    await page.goto(ADMIN_CALLBACK_URL);

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
    await expect(page.getByRole("heading", { name: "Platoons" })).toBeVisible();
  });

  test("tenant callback keeps the tenant host and opens the workspace", async ({ page }) => {
    await seedOidcCallback(page, TENANT_CALLBACK_URL, qaIdentities.lead, "/#/admin");
    await mockTokenExchange(page);

    await page.goto(TENANT_CALLBACK_URL);

    await expect(page).toHaveURL(/ms\.localhost:5175\/#\/admin/);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  });

  test("token exchange failures show callback-specific recovery copy", async ({ page }) => {
    await seedOidcCallback(page, ROOT_CALLBACK_URL, qaIdentities.root, "/#/launch");
    await mockTokenExchange(page, { status: 502 });

    await page.goto(ROOT_CALLBACK_URL);

    await expect(page.getByRole("heading", { name: "Opening workspace" })).toBeVisible();
    await expect(page.getByText("Sign-in reached the app, but the inventory API did not finish the callback. Try again or ask an admin to check API routing.")).toBeVisible();
    await expect(page.getByText("Failed to fetch")).toHaveCount(0);
  });
});
