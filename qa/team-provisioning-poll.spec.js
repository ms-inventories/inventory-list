import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

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

async function openTeam(page) {
  const toggle = page.getByRole("button", { name: "Open workspace menu" });
  if (await toggle.count()) await toggle.click();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
}

test("permanent teammate setup keeps polling unchanged pending work and stops after completion", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), "One browser project covers the polling lifecycle.");

  await page.clock.install();
  let countScheduledPolls = false;
  let scheduledPolls = 0;

  await page.route("**/api/tenant/members", async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    if (countScheduledPolls) scheduledPolls += 1;
    const isComplete = countScheduledPolls && scheduledPolls >= 2;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        provisioningAvailable: true,
        members: [{
          id: "11111111-1111-4111-8111-111111111111",
          tenantId: "22222222-2222-4222-8222-222222222222",
          userId: "33333333-3333-4333-8333-333333333333",
          displayName: "Polling Teammate",
          email: "polling-teammate@876en.test",
          role: "contributor",
          status: isComplete ? "active" : "invited",
          hasSignedIn: false,
          provisioning: {
            id: "44444444-4444-4444-8444-444444444444",
            status: isComplete ? "succeeded" : "pending",
            desiredRole: "contributor",
            desiredState: "active",
            retryable: false,
            enrollmentRequired: false,
            enrollmentSentAt: null
          }
        }]
      })
    });
  });

  await seedQaRootSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await openTeam(page);
  await page.locator(".add-teammate-summary").click();
  await expect(page.getByText("Setting up", { exact: true })).toBeVisible();

  countScheduledPolls = true;
  scheduledPolls = 0;

  await page.clock.fastForward(2500);
  await expect.poll(() => scheduledPolls).toBe(1);
  await expect(page.getByText("Setting up", { exact: true })).toBeVisible();

  await page.clock.fastForward(2500);
  await expect.poll(() => scheduledPolls).toBe(2);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await page.clock.fastForward(10_000);
  expect(scheduledPolls).toBe(2);
});

test("a transient provisioning poll failure keeps setup available and retries with backoff", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), "One browser project covers the polling recovery lifecycle.");

  await page.clock.install();
  let countScheduledPolls = false;
  let scheduledPolls = 0;

  await page.route("**/api/tenant/members", async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    if (countScheduledPolls) scheduledPolls += 1;
    if (countScheduledPolls && scheduledPolls === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary test outage" })
      });
      return;
    }

    const isComplete = countScheduledPolls && scheduledPolls >= 2;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        provisioningAvailable: true,
        members: [{
          id: "51111111-1111-4111-8111-111111111111",
          tenantId: "52222222-2222-4222-8222-222222222222",
          userId: "53333333-3333-4333-8333-333333333333",
          displayName: "Resilient Teammate",
          email: "resilient-teammate@876en.test",
          role: "contributor",
          status: isComplete ? "active" : "invited",
          hasSignedIn: false,
          provisioning: {
            id: "54444444-4444-4444-8444-444444444444",
            status: isComplete ? "succeeded" : "pending",
            desiredRole: "contributor",
            desiredState: "active",
            retryable: false,
            enrollmentRequired: false,
            enrollmentSentAt: null
          }
        }]
      })
    });
  });

  await seedQaRootSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await openTeam(page);
  await page.locator(".add-teammate-summary").click();
  await expect(page.getByText("Setting up", { exact: true })).toBeVisible();

  countScheduledPolls = true;
  scheduledPolls = 0;
  await page.clock.fastForward(2500);
  await expect.poll(() => scheduledPolls).toBe(1);
  await expect(page.getByRole("button", { name: "Add teammate" })).toBeEnabled();
  await expect(page.getByText("Setting up", { exact: true })).toBeVisible();

  await page.clock.fastForward(4999);
  expect(scheduledPolls).toBe(1);
  await page.clock.fastForward(1);
  await expect.poll(() => scheduledPolls).toBe(2);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await page.clock.fastForward(10_000);
  expect(scheduledPolls).toBe(2);
});

test("permanent teammate fields enforce the API limits before submitting", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), "One browser project covers native form validation.");

  let createRequests = 0;
  await page.route("**/api/tenant/members", async route => {
    if (route.request().method() === "POST") {
      createRequests += 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ member: null })
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ provisioningAvailable: true, members: [] })
    });
  });

  await seedQaRootSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await openTeam(page);
  await page.locator(".add-teammate-summary").click();

  const name = page.getByLabel("Name", { exact: true });
  const email = page.getByLabel("Email", { exact: true });
  await expect(name).toHaveAttribute("minlength", "2");
  await expect(name).toHaveAttribute("maxlength", "120");
  await expect(email).toHaveAttribute("maxlength", "254");

  await name.fill("A");
  await email.fill("teammate@example.test");
  await page.locator(".team-member-form").getByRole("button", { name: "Add teammate" }).click();

  expect(await name.evaluate(input => input.validity.tooShort)).toBe(true);
  expect(createRequests).toBe(0);
});

test("an empty Team result gives one action and focuses the teammate form", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), "The mobile layout audit covers the compact disclosure.");

  await page.route("**/api/tenant/members", async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ provisioningAvailable: true, members: [] })
    });
  });

  await seedQaRootSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await openTeam(page);

  const addCard = page.locator(".add-teammate-card");
  await expect(addCard).not.toHaveAttribute("open", "");
  const emptyState = page.locator(".admin-empty").filter({ hasText: "No teammates yet" });
  const nextAction = emptyState.getByRole("button", { name: "Add teammate" });
  await expect(nextAction).toBeVisible();
  await nextAction.click();

  await expect(addCard).toHaveAttribute("open", "");
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
});

test("legacy invitation actions stay row scoped and name the operation in progress", async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), "One browser project covers row-scoped invitation operations.");

  const invitations = [
    {
      id: "61111111-1111-4111-8111-111111111111",
      email: "copy-invite@876en.test",
      displayName: "Copy Invite",
      role: "contributor",
      status: "pending",
      expiresAt: "2026-07-20T12:00:00.000Z"
    },
    {
      id: "62222222-2222-4222-8222-222222222222",
      email: "resend-invite@876en.test",
      displayName: "Resend Invite",
      role: "contributor",
      status: "pending",
      expiresAt: "2026-07-20T12:00:00.000Z"
    }
  ];

  await page.route("**/api/tenant/invitations", async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ invitations })
    });
  });
  await page.route("**/api/tenant/invitations/*/resend", async route => {
    const invitation = invitations.find(item => route.request().url().includes(item.id));
    await new Promise(resolve => setTimeout(resolve, 450));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        invitation: {
          ...invitation,
          inviteUrl: `http://ms.localhost:5175/#/accept-invite?token=${invitation.id}`
        },
        email: { sent: route.request().postDataJSON()?.sendEmail === true }
      })
    });
  });

  await seedQaRootSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await openTeam(page);
  await page.locator(".legacy-links-summary").click();

  const copyRow = page.locator(".invitation-row").filter({ hasText: "copy-invite@876en.test" });
  const resendRow = page.locator(".invitation-row").filter({ hasText: "resend-invite@876en.test" });
  await copyRow.getByRole("button", { name: "Copy link" }).click();
  await expect(copyRow.getByRole("button", { name: "Refreshing..." })).toBeVisible();
  await resendRow.getByRole("button", { name: "Resend" }).click();

  await expect(copyRow.getByRole("button", { name: "Refreshing..." })).toBeDisabled();
  await expect(resendRow.getByRole("button", { name: "Sending..." })).toBeDisabled();
  await expect(copyRow.getByRole("button", { name: "Copy link" })).toBeEnabled();
  await expect(resendRow.getByRole("button", { name: "Resend" })).toBeEnabled();
});
