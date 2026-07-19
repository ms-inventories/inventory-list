import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";

async function signInAsNewsletterAdmin(page) {
  await page.goto(ADMIN_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Newsletter admin" }).click();
  await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
}

async function openNewsletterSection(page, name) {
  const menuToggle = page.getByRole("button", { name: "Open newsletter menu" });
  if (await menuToggle.isVisible()) await menuToggle.click();
  await page.getByRole("button", { name, exact: true }).click();
}

function newsletterAdminData(overrides = {}) {
  return {
    issues: [],
    contentBlocks: [],
    subscribers: [],
    deliveries: [],
    subscriberStats: { pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 },
    deliverySettings: { emailConfigured: false },
    ...overrides
  };
}

async function mockNewsletterAdmin(page, data) {
  await page.route("**/api/newsletter/admin", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data)
    });
  });
}

test.describe("newsletter empty-state guidance", () => {
  test("true-empty sections offer one direct next action and focus the editor", async ({ page }) => {
    await mockNewsletterAdmin(page, newsletterAdminData());
    await signInAsNewsletterAdmin(page);

    await expect(page.getByRole("heading", { name: "Homepage updates" })).toBeVisible();
    await page.getByRole("button", { name: "Update homepage" }).click();
    const homepageDialog = page.getByRole("dialog", { name: "Manage homepage updates" });
    let emptyPanel = homepageDialog.locator(".admin-empty").filter({ hasText: "No homepage updates yet" });
    await expect(emptyPanel).toBeVisible();
    await emptyPanel.getByRole("button", { name: "Add homepage update" }).click();
    await expect(homepageDialog.getByLabel("Title")).toBeFocused();
    await expect(page.getByRole("status")).toContainText("New homepage update ready.");
    await homepageDialog.getByRole("button", { name: "Close homepage editor" }).click();

    await openNewsletterSection(page, "Issues");
    emptyPanel = page.locator(".admin-empty").filter({ hasText: "No newsletters yet" });
    await expect(emptyPanel).toBeVisible();
    await emptyPanel.getByRole("button", { name: "Write first newsletter" }).click();
    const issueDialog = page.getByRole("dialog", { name: "Create issue" });
    await expect(issueDialog.getByLabel("Title")).toBeFocused();
    await expect(page.getByRole("status")).toContainText("New newsletter draft ready.");
    await issueDialog.getByRole("button", { name: "Close issue editor" }).click();

    await openNewsletterSection(page, "Subscribers");
    emptyPanel = page.locator(".admin-empty").filter({ hasText: "No subscribers yet" });
    await expect(emptyPanel).toBeVisible();
    await expect(emptyPanel.getByRole("link", { name: "View signup page" })).toHaveAttribute("href", /^https:\/\//);
  });

  test("filtered-empty sections clear their filters without losing real records", async ({ page }) => {
    const now = new Date().toISOString();
    const contentTitle = "QA homepage update";
    const issueTitle = "QA newsletter";
    const subscriberName = "QA Approved Reader";
    await mockNewsletterAdmin(page, newsletterAdminData({
      contentBlocks: [{
        id: "qa-content",
        blockType: "announcement",
        title: contentTitle,
        summary: "Visible public update",
        body: "QA content",
        href: "",
        linkLabel: "",
        sortOrder: 1,
        status: "draft",
        createdAt: now,
        updatedAt: now
      }],
      issues: [{
        id: "qa-issue",
        title: issueTitle,
        editionLabel: "QA",
        summary: "Visible newsletter",
        body: "QA newsletter body",
        status: "draft",
        createdAt: now,
        updatedAt: now,
        sentCount: 0
      }],
      subscribers: [{
        id: "qa-subscriber",
        email: "qa-approved@example.com",
        displayName: subscriberName,
        platoon: "MS",
        supervisorName: "QA Lead",
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastSubscribedAt: now
      }],
      subscriberStats: { pending: 0, active: 1, rejected: 0, unsubscribed: 0, total: 1 }
    }));
    await signInAsNewsletterAdmin(page);

    await page.getByRole("button", { name: "Update homepage" }).click();
    const homepageDialog = page.getByRole("dialog", { name: "Manage homepage updates" });
    await homepageDialog.getByLabel("Search public content").fill("not in any update");
    let emptyPanel = homepageDialog.locator(".admin-empty").filter({ hasText: "No matching homepage updates" });
    await expect(emptyPanel).toBeVisible();
    await emptyPanel.getByRole("button", { name: "Clear filters" }).click();
    await expect(homepageDialog.locator(".frg-content-list").getByText(contentTitle, { exact: true })).toBeVisible();
    await homepageDialog.getByRole("button", { name: "Close homepage editor" }).click();

    await openNewsletterSection(page, "Issues");
    await page.getByLabel("Search newsletter issues").fill("not in any newsletter");
    emptyPanel = page.locator(".admin-empty").filter({ hasText: "No matching newsletters" });
    await expect(emptyPanel).toBeVisible();
    await emptyPanel.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByRole("table", { name: "Newsletter issues" }).getByText(issueTitle, { exact: true })).toBeVisible();

    await openNewsletterSection(page, "Subscribers");
    emptyPanel = page.locator(".admin-empty").filter({ hasText: "No pending requests" });
    await expect(emptyPanel).toBeVisible();
    await emptyPanel.getByRole("button", { name: "Show all subscribers" }).click();
    await expect(page.getByText(subscriberName, { exact: true })).toBeVisible();
  });
});
