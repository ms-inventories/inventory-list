import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const ADMIN_LAUNCH_URL = process.env.QA_ADMIN_LAUNCH_URL || "http://admin.localhost:5175/#/launch";

test("an unauthorized API response clears the rejected browser session", async ({ page }) => {
  await page.route("**/api/me**", route => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({
      error: "Authentication required",
      code: "token_rejected"
    })
  }));

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "rejected-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now()
    }));
  });

  await page.goto(TENANT_URL);

  await expect(page.getByText("Your sign-in expired. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Authentik" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("inventory.auth.session"))).toBeNull();
});

test("a near-expiry OIDC session renews silently before loading the workspace", async ({ page }) => {
  let refreshCount = 0;
  let meAuthorization = "";

  await page.route("**/api/auth/oidc/refresh", async route => {
    refreshCount += 1;
    expect((await route.request().postDataJSON()).refreshToken).toBe("qa-refresh-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "renewed-access-token",
        id_token: "renewed-id-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600
      })
    });
  });

  await page.route("**/api/me**", async route => {
    meAuthorization = route.request().headers().authorization || "";
    await route.fulfill({
      status: 200,
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
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "expiring-access-token",
      idToken: "expiring-id-token",
      refreshToken: "qa-refresh-token",
      expiresAt: Date.now() + 10_000,
      createdAt: Date.now() - 60 * 60 * 1000
    }));
  });

  await page.goto(TENANT_URL);

  await expect.poll(() => refreshCount).toBe(1);
  await expect.poll(() => meAuthorization).toBe("Bearer renewed-access-token");
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("inventory.auth.session") || "null");
    return {
      accessToken: session?.accessToken,
      refreshToken: session?.refreshToken,
      hasFutureExpiry: session?.expiresAt > Date.now() + 50 * 60 * 1000
    };
  })).toEqual({
    accessToken: "renewed-access-token",
    refreshToken: "rotated-refresh-token",
    hasFutureExpiry: true
  });
  await expect(page.getByText("Your sign-in expired. Try again.")).toHaveCount(0);
});

test("a new app subdomain restores the API renewal session without another Authentik trip", async ({ page }) => {
  let refreshCount = 0;
  let authorizeCount = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/auth/oidc/refresh", async route => {
    refreshCount += 1;
    expect(await route.request().postDataJSON()).toEqual({});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "shared-cookie-access-token",
        id_token: "shared-cookie-id-token",
        refresh_available: true,
        expires_in: 3600
      })
    });
  });
  await page.route("**/api/me**", route => route.fulfill({
    status: 200,
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

  await page.goto(ADMIN_LAUNCH_URL);

  await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
  await expect.poll(() => refreshCount).toBe(1);
  expect(authorizeCount).toBe(0);
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("inventory.auth.session") || "null");
    return { accessToken: session?.accessToken, refreshAvailable: session?.refreshAvailable };
  })).toEqual({ accessToken: "shared-cookie-access-token", refreshAvailable: true });
});

test("a protected admin deep link restores the API renewal session before Authentik", async ({ page }) => {
  let refreshCount = 0;
  let authorizeCount = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/auth/oidc/refresh", route => {
    refreshCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "deep-link-access-token",
        refresh_available: true,
        expires_in: 3600
      })
    });
  });
  await page.route("**/api/me**", route => route.fulfill({
    status: 200,
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
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ tenants: [], provisioningAvailable: false, setup: {} })
  }));
  await page.route("**/api/platform/users", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ users: [], management: { mutationsAvailable: false } })
  }));

  await page.goto(ADMIN_URL);

  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect.poll(() => refreshCount).toBe(1);
  expect(authorizeCount).toBe(0);
});
