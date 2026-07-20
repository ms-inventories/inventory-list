import { expect, test } from "@playwright/test";

const NEWSLETTER_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";

const qaRootAdmin = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

const now = "2026-07-17T12:00:00.000Z";
const viewports = [
  { label: "360px", width: 360, height: 740 },
  { label: "800px", width: 800, height: 900 }
];

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

function contentBlock(index, title = `Mobile content item ${index}`) {
  return {
    id: `mobile-content-${index}`,
    blockType: "announcement",
    title,
    summary: `Summary ${index}`,
    body: `Details ${index}`,
    href: "",
    linkLabel: "",
    sortOrder: index,
    status: index % 2 ? "draft" : "published",
    createdAt: now,
    updatedAt: now
  };
}

function issue(index, title = `Mobile newsletter issue ${index}`) {
  return {
    id: `mobile-issue-${index}`,
    title,
    editionLabel: `Edition ${index}`,
    summary: `Summary ${index}`,
    body: `Newsletter body ${index}`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    sentCount: 0
  };
}

function newsletterData(overrides = {}) {
  return {
    issues: [],
    contentBlocks: [],
    subscribers: [],
    deliveries: [],
    subscriberStats: { pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 },
    deliverySettings: { emailConfigured: true },
    ...overrides
  };
}

async function openNewsletter(page, data) {
  await seedQaRootSession(page);
  await page.route("**/api/newsletter/admin", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data)
    });
  });
  await page.goto(NEWSLETTER_URL);
  await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
}

async function selectNewsletterSection(page, name, heading = name) {
  const menuToggle = page.getByRole("button", { name: "Open newsletter menu" });
  if (await menuToggle.isVisible()) await menuToggle.click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
}

async function expectEditorEngaged(page, editor) {
  const state = await editor.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      focused: element.contains(document.activeElement),
      intersectsViewport: bounds.top < window.innerHeight && bounds.bottom > 0,
      top: Math.round(bounds.top),
      viewportHeight: window.innerHeight
    };
  });
  expect(
    state.focused || state.intersectsViewport,
    `Expected the selected editor to receive focus or scroll into view; editor top=${state.top}, viewport height=${state.viewportHeight}.`
  ).toBeTruthy();
}

async function expectContained(locator, label) {
  const size = await locator.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(
    size.scrollWidth,
    `${label} overflowed horizontally: scrollWidth=${size.scrollWidth}, clientWidth=${size.clientWidth}.`
  ).toBeLessThanOrEqual(size.clientWidth + 1);
}

for (const viewport of viewports) {
  test.describe(`newsletter mobile polish at ${viewport.label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("selecting public content brings its editor into context", async ({ page }) => {
      await openNewsletter(page, newsletterData({
        contentBlocks: Array.from({ length: 12 }, (_, index) => contentBlock(index + 1))
      }));

      await page.getByRole("button", { name: "Update homepage" }).click();
      const dialog = page.getByRole("dialog", { name: "Manage homepage updates" });
      await dialog.locator(".frg-content-list .newsletter-issue-button").nth(1).click();
      await expectEditorEngaged(page, dialog.locator(".frg-content-admin-grid .newsletter-editor-form"));
    });

    test("selecting an issue brings its editor into context", async ({ page }) => {
      await openNewsletter(page, newsletterData({
        issues: Array.from({ length: 12 }, (_, index) => issue(index + 1))
      }));
      await selectNewsletterSection(page, "Issues", "Newsletter issues");

      const issueRow = page.getByRole("table", { name: "Newsletter issues" }).getByRole("row").filter({ hasText: "Mobile newsletter issue 2" });
      await issueRow.getByRole("button", { name: "Edit" }).click();
      await expectEditorEngaged(page, page.getByRole("dialog", { name: "Edit issue" }).locator(".newsletter-editor-form"));
    });

    test("long unbroken public-content and issue titles stay contained", async ({ page }) => {
      const longContentTitle = `CONTENT-${"X".repeat(120)}`;
      const longIssueTitle = `ISSUE-${"Y".repeat(120)}`;
      await openNewsletter(page, newsletterData({
        contentBlocks: [contentBlock(1, longContentTitle)],
        issues: [issue(1, longIssueTitle)]
      }));

      await page.getByRole("button", { name: "Update homepage" }).click();
      const homepageDialog = page.getByRole("dialog", { name: "Manage homepage updates" });
      await expectContained(
        homepageDialog.locator(".frg-content-list .newsletter-issue-button").first(),
        `${viewport.label} public-content row`
      );
      await homepageDialog.getByRole("button", { name: "Close homepage editor" }).click();

      await selectNewsletterSection(page, "Issues", "Newsletter issues");
      await expectContained(
        page.getByRole("table", { name: "Newsletter issues" }).getByRole("row").filter({ hasText: longIssueTitle }),
        `${viewport.label} issue row`
      );
    });

    test("subscriber rows hide email until the details modal is opened", async ({ page }) => {
      await openNewsletter(page, newsletterData({
        subscribers: [{
          id: "mobile-rejected-subscriber",
          displayName: "Rejected Mobile Subscriber",
          email: "rejected-mobile@876en.test",
          platoon: "MS",
          supervisorName: "QA Lead",
          status: "rejected",
          reviewNote: "Address corrected; ready for another review.",
          reviewedAt: now,
          createdAt: now,
          lastSubscribedAt: now
        }],
        subscriberStats: { pending: 0, active: 0, rejected: 1, unsubscribed: 0, total: 1 }
      }));
      await selectNewsletterSection(page, "Subscribers");
      await page.getByLabel("Filter subscribers by status").selectOption("rejected");

      const table = page.getByRole("table", { name: "Newsletter subscribers" });
      const row = table.getByRole("row").filter({ hasText: "Rejected Mobile Subscriber" });
      await expect(row).toBeVisible();
      await expect(row).not.toContainText("rejected-mobile@876en.test");
      const statusAppearance = await row.locator(".status-pill").evaluate(element => ({
        tagName: element.tagName,
        role: element.getAttribute("role"),
        borderTopWidth: getComputedStyle(element).borderTopWidth,
        borderRadius: getComputedStyle(element).borderRadius,
        backgroundColor: getComputedStyle(element).backgroundColor,
        cursor: getComputedStyle(element).cursor
      }));
      expect(statusAppearance.tagName).toBe("SPAN");
      expect(statusAppearance.role).not.toBe("button");
      expect(statusAppearance.borderTopWidth).toBe("0px");
      expect(statusAppearance.borderRadius).toBe("0px");
      expect(statusAppearance.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(statusAppearance.cursor).not.toBe("pointer");
      await row.getByRole("button", { name: "View details" }).click();
      const dialog = page.getByRole("dialog", { name: "Rejected Mobile Subscriber" });
      await expect(dialog).toContainText("rejected-mobile@876en.test");
      await expect(dialog.getByRole("button", { name: "Approve subscriber" })).toBeVisible();
    });

    test("delivery history does not create a nested vertical scroller", async ({ page }) => {
      const selectedIssue = issue(1, "Issue with delivery history");
      const deliveries = Array.from({ length: 12 }, (_, index) => ({
        id: `mobile-delivery-${index + 1}`,
        issueId: selectedIssue.id,
        subscriberName: `Recipient ${index + 1}`,
        email: `recipient-${index + 1}@876en.test`,
        status: "sent",
        sentAt: now,
        createdAt: now
      }));
      await openNewsletter(page, newsletterData({ issues: [selectedIssue], deliveries }));
      await selectNewsletterSection(page, "Analytics", "Delivery analytics");

      const deliveryTable = page.getByRole("table", { name: "Newsletter delivery records" });
      await expect(deliveryTable).toBeVisible();
      const scrollState = await deliveryTable.evaluate(element => ({
        overflowY: getComputedStyle(element).overflowY,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }));
      expect(
        ["auto", "scroll"],
        `Delivery history is a nested ${scrollState.clientHeight}px scroller for ${scrollState.scrollHeight}px of content.`
      ).not.toContain(scrollState.overflowY);
    });

    test("the account/avatar affordance is interactive or explicitly decorative", async ({ page }) => {
      await openNewsletter(page, newsletterData());

      const affordance = await page.locator(".newsletter-user-card").evaluate(element => {
        const chevron = element.querySelector(":scope > svg");
        return {
          interactive: element.matches("button, a, [role='button']"),
          explicitlyDecorative: element.getAttribute("aria-hidden") === "true",
          chevronVisible: Boolean(chevron && getComputedStyle(chevron).display !== "none")
        };
      });
      expect(
        affordance.interactive || (affordance.explicitlyDecorative && !affordance.chevronVisible),
        `Account affordance was static and not marked decorative (chevronVisible=${affordance.chevronVisible}).`
      ).toBeTruthy();
    });
  });
}

test("newsletter load failures do not expose false zero totals or blank editors", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await seedQaRootSession(page);
  let attempts = 0;
  let allowSuccess = false;
  await page.route("**/api/newsletter/admin", async route => {
    if (route.request().method() !== "GET") return route.continue();
    attempts += 1;
    if (!allowSuccess) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Newsletter service is temporarily unavailable." })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(newsletterData({ contentBlocks: [contentBlock(1)] }))
    });
  });

  await page.goto(NEWSLETTER_URL);
  await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
  await expect(page.getByText("Newsletter could not load", { exact: true })).toBeVisible();
  await expect(page.locator(".newsletter-stat-grid")).toHaveCount(0);
  await expect(page.locator(".newsletter-editor-form")).toHaveCount(0);

  allowSuccess = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Homepage updates" })).toBeVisible();
  await expect(page.locator(".newsletter-overview-grid")).toBeVisible();
  await expect(page.locator(".newsletter-stat-grid")).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});
