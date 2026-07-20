import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const ADMIN_LAUNCH_URL = process.env.QA_ADMIN_LAUNCH_URL || "http://admin.localhost:5175/#/launch";
const NEWSLETTER_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter/issues";

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
  const refreshTokens = [];
  let meAuthorization = "";

  await page.route("**/api/auth/oidc/refresh", async route => {
    refreshTokens.push((await route.request().postDataJSON()).refreshToken);
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
    // Let the proactive API refresh finish before the dashboard's zero-delay
    // renewal timer wakes, reproducing the rotated-token race deterministically.
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay = 0, ...args) => nativeSetTimeout(
      callback,
      Number(delay) === 0 ? 100 : delay,
      ...args
    );
    localStorage.setItem("inventory.qa.identity", JSON.stringify({
      sub: "qa-lead",
      email: "qa-lead@876en.test",
      name: "QA Platoon Admin",
      groups: ["876en-ms", "876en-platoon-admin"]
    }));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "expiring-access-token",
      idToken: "expiring-id-token",
      refreshToken: "qa-refresh-token",
      expiresAt: Date.now() + 10_000,
      createdAt: Date.now() - 60 * 60 * 1000
    }));
  });

  await page.goto(TENANT_URL);

  await expect.poll(() => refreshTokens).toEqual(["qa-refresh-token"]);
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
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await page.waitForTimeout(250);
  expect(refreshTokens).toEqual(["qa-refresh-token"]);
  await expect(page.getByText("Your sign-in expired. Try again.")).toHaveCount(0);
});

test("notification renewal and reconnect keep the signed-in dashboard and draft in place", async ({ page }) => {
  let rejectNextNotification = false;
  let rejectedNotificationToken = "notification-access-token";
  let rejectNextRefresh = false;
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
    if (rejectNextRefresh) {
      rejectNextRefresh = false;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The renewable sign-in session is no longer valid.",
          code: "oidc_refresh_rejected"
        })
      });
    }
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
    if (rejectNextNotification && authorization === `Bearer ${rejectedNotificationToken}`) {
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

  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByRole("button", { name: "Start inventory", exact: true }).click();
  const draftDialog = page.locator(".start-inventory-modal");
  const draftNameInput = draftDialog.locator("#startInventoryName");
  const draftName = "Inventory draft survives renewal";
  await draftNameInput.fill(draftName);
  await expect(draftNameInput).toBeFocused();
  const urlBeforeReconnect = page.url();

  rejectedNotificationToken = "renewed-notification-token";
  rejectNextNotification = true;
  rejectNextRefresh = true;
  await page.evaluate(async () => {
    const { apiRequest } = await import("/src/lib/api.js");
    const session = JSON.parse(localStorage.getItem("inventory.auth.session") || "null");
    try {
      await apiRequest("/tenant/notifications", {
        token: session?.accessToken || "",
        tenantSlug: "ms"
      });
    } catch {
      // The page-level reconnect prompt is the behavior under test.
    }
  });

  const reconnectDialog = page.getByRole("alertdialog", { name: "Reconnect to continue" });
  const reconnectButton = reconnectDialog.getByRole("button", { name: "Reconnect", exact: true });
  await expect(reconnectDialog).toBeVisible();
  await expect(reconnectButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reconnectButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(reconnectButton).toBeFocused();
  expect(page.url()).toBe(urlBeforeReconnect);
  await expect(page.locator(".leader-app")).toHaveAttribute("inert", "");
  await expect(draftDialog).toBeVisible();
  await expect(draftNameInput).toHaveValue(draftName);

  await reconnectButton.click();
  await expect.poll(() => refreshCount).toBe(3);
  await expect(reconnectDialog).toHaveCount(0);
  await expect(dashboardHeading).toBeVisible();
  await expect(draftDialog).toBeVisible();
  await expect(draftNameInput).toHaveValue(draftName);
  await expect(draftNameInput).toBeFocused();
  expect(page.url()).toBe(urlBeforeReconnect);
  expect(authorizeCount).toBe(0);

  rejectNextNotification = true;
  rejectNextRefresh = true;
  await page.evaluate(async () => {
    const { apiRequest } = await import("/src/lib/api.js");
    const session = JSON.parse(localStorage.getItem("inventory.auth.session") || "null");
    try {
      await apiRequest("/tenant/notifications", {
        token: session?.accessToken || "",
        tenantSlug: "ms"
      });
    } catch {
      // A rejected automatic refresh should preserve the current page and draft.
    }
  });

  await expect.poll(() => refreshCount).toBe(4);
  await expect(reconnectDialog).toBeVisible();
  rejectNextRefresh = true;
  await reconnectDialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => refreshCount).toBe(5);
  const signInAgainButton = reconnectDialog.getByRole("button", { name: "Sign in again", exact: true });
  await expect(signInAgainButton).toBeVisible();
  await expect(signInAgainButton).toBeFocused();
  await expect(draftNameInput).toHaveValue(draftName);
  expect(page.url()).toBe(urlBeforeReconnect);
  expect(authorizeCount).toBe(0);

  await reconnectDialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => refreshCount).toBe(6);
  await expect(reconnectDialog).toHaveCount(0);
  await expect(draftNameInput).toHaveValue(draftName);
  await expect(draftNameInput).toBeFocused();
  expect(page.url()).toBe(urlBeforeReconnect);
  expect(authorizeCount).toBe(0);
});

test("reconnect stays above the newsletter editor and preserves an unsaved issue", async ({ page }) => {
  let rejectNextNewsletter = false;
  let rejectNextRefresh = false;
  let refreshCount = 0;
  let authorizeCount = 0;
  let newsletterWrites = 0;

  await page.route("**/application/o/authorize/**", route => {
    authorizeCount += 1;
    return route.abort();
  });
  await page.route("**/api/auth/oidc/refresh", route => {
    refreshCount += 1;
    if (rejectNextRefresh) {
      rejectNextRefresh = false;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session ended", code: "oidc_refresh_rejected" })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "renewed-newsletter-token",
        refresh_available: true,
        expires_in: 3600
      })
    });
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
  await page.route("**/api/newsletter/**", route => {
    if (route.request().method() !== "GET") {
      newsletterWrites += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unexpected write" }) });
    }
    if (new URL(route.request().url()).pathname !== "/api/newsletter/admin") {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected newsletter request" }) });
    }
    if (rejectNextNewsletter) {
      rejectNextNewsletter = false;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required", code: "token_rejected" })
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        issues: [],
        contentBlocks: [],
        subscribers: [],
        deliveries: [],
        subscriberStats: { pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 },
        deliverySettings: { emailConfigured: false }
      })
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "newsletter-access-token",
      refreshAvailable: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now()
    }));
  });

  await page.goto(NEWSLETTER_URL);
  await expect(page.getByRole("heading", { name: "Newsletter issues", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const issueEditor = page.locator(".newsletter-issue-modal");
  const issueTitle = issueEditor.locator("#newsletterTitle");
  const issueBody = issueEditor.locator("#newsletterBody");
  await issueTitle.fill("Unsaved reconnect issue");
  await issueBody.fill("This unsaved newsletter body must survive a secure session renewal.");
  await expect(issueBody).toBeFocused();
  const urlBeforeReconnect = page.url();

  rejectNextNewsletter = true;
  rejectNextRefresh = true;
  await page.evaluate(async () => {
    const { apiRequest } = await import("/src/lib/api.js");
    const session = JSON.parse(localStorage.getItem("inventory.auth.session") || "null");
    try {
      await apiRequest("/newsletter/admin", { token: session?.accessToken || "" });
    } catch {
      // The reconnect dialog should appear without unmounting the editor.
    }
  });

  const reconnectDialog = page.getByRole("alertdialog", { name: "Reconnect to continue" });
  await expect(reconnectDialog).toBeVisible();
  await expect(issueTitle).toHaveValue("Unsaved reconnect issue");
  await expect(issueBody).toHaveValue("This unsaved newsletter body must survive a secure session renewal.");
  expect(page.url()).toBe(urlBeforeReconnect);
  expect(authorizeCount).toBe(0);
  expect(newsletterWrites).toBe(0);

  await reconnectDialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => refreshCount).toBe(2);
  await expect(reconnectDialog).toHaveCount(0);
  await expect(issueTitle).toHaveValue("Unsaved reconnect issue");
  await expect(issueBody).toHaveValue("This unsaved newsletter body must survive a secure session renewal.");
  await expect(issueBody).toBeFocused();
  expect(page.url()).toBe(urlBeforeReconnect);
  expect(authorizeCount).toBe(0);
  expect(newsletterWrites).toBe(0);
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
