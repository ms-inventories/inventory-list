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
  await expect(page.getByRole("button", { name: "Continue to secure sign-in" })).toBeVisible();
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

test("a notification 401 renews once without replacing the signed-in dashboard", async ({ page }) => {
  let rejectNextNotification = false;
  let notificationRequests = 0;
  let refreshCount = 0;
  let authorizeCount = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/auth/oidc/refresh", async route => {
    refreshCount += 1;
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "renewed-notification-token",
        refresh_available: true,
        expires_in: 3600
      })
    });
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
  await page.route("**/api/tenant/notifications", route => {
    notificationRequests += 1;
    const authorization = route.request().headers().authorization || "";
    if (rejectNextNotification && authorization === "Bearer notification-access-token") {
      rejectNextNotification = false;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required", code: "token_rejected" })
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ notifications: [], unreadCount: 0 })
    });
  });
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

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "notification-access-token",
      refreshAvailable: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now()
    }));
  });

  await page.goto(TENANT_URL);
  const dashboardHeading = page.getByRole("heading", { name: "Leader Dashboard" });
  await expect(dashboardHeading).toBeVisible();
  await expect.poll(() => notificationRequests).toBeGreaterThan(0);

  rejectNextNotification = true;
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByText("Refreshing secure access", { exact: true })).toBeVisible();
  await expect.poll(() => refreshCount).toBe(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("inventory.auth.session") || "null")?.accessToken)).toBe("renewed-notification-token");

  await expect(dashboardHeading).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByLabel("Opening Shadow Tracer")).toHaveCount(0);
  await expect(page.getByText("Reconnect to continue", { exact: true })).toHaveCount(0);
  expect(authorizeCount).toBe(0);
});

test("explicit sign out blocks a renewal that starts while logout is pending", async ({ page }) => {
  let logoutStarted = false;
  let releaseLogout;
  let refreshCount = 0;
  const logoutGate = new Promise(resolve => {
    releaseLogout = resolve;
  });

  await page.route("**/api/auth/oidc/logout", async route => {
    logoutStarted = true;
    await logoutGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  await page.route("**/api/auth/oidc/refresh", route => {
    refreshCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "resurrected-access-token",
        refresh_available: true,
        expires_in: 3600
      })
    });
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

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "logout-race-access-token",
      refreshAvailable: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now()
    }));
  });

  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Open user menu" }).click();
  await page.getByLabel("User menu").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => logoutStarted).toBe(true);

  const refreshResult = await page.evaluate(async () => {
    const { refreshAuthSession } = await import("/src/lib/auth.js");
    try {
      await refreshAuthSession({
        accessToken: "logout-race-access-token",
        refreshAvailable: true,
        expiresAt: Date.now() + 60 * 60 * 1000
      }, { force: true });
      return "resolved";
    } catch (error) {
      return error?.code || error?.message || "rejected";
    }
  });

  expect(refreshResult).toBe("token_refresh_cancelled");
  expect(refreshCount).toBe(0);
  releaseLogout();

  await expect(page.getByRole("button", { name: "Continue to secure sign-in" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("inventory.auth.session"))).toBeNull();
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
  await page.route("**/api/auth/oidc/refresh", async route => {
    refreshCount += 1;
    await new Promise(resolve => setTimeout(resolve, 300));
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

  await expect(page.getByLabel("Opening Shadow Tracer")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect.poll(() => refreshCount).toBe(1);
  expect(authorizeCount).toBe(0);
});
