import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.QA_FRONTEND_URL || "http://localhost:5175";
const publishedAt = "2026-07-17T12:00:00.000Z";
const longTitle = `July Family & Soldier Resources ${"NewsletterUpdate".repeat(8)}`;
const longSummary = "STEM kits, an AGR opportunity, retention reminders, and upcoming family activities for every Soldier and family member.";
const longUrl = `https://www.cognitoforms.com/PAARNGChildYouthProgram/${"SummerSTEMKitRegistration".repeat(7)}`;
const longEdition = `July-${"FamilyResources".repeat(7)}`;
const longCardTitle = `Community-${"Announcement".repeat(9)}`;
const longCardSummary = `Details-${"FamilyReadinessResource".repeat(12)}`;
const longLinkLabel = `Open-${"RegistrationResource".repeat(8)}`;
const longRequestError = `Request-${"ReferenceToken".repeat(14)}`;

const viewports = [
  { width: 320, height: 568 },
  { width: 320, height: 700 },
  { width: 360, height: 740 },
  { width: 412, height: 820 }
];

function publicNewsletterPayload() {
  return {
    latestIssue: {
      id: "mobile-overflow-issue",
      title: longTitle,
      editionLabel: longEdition,
      summary: longSummary,
      body: [
        "Summer STEM kits for Guard families",
        "The PAARNG Child and Youth Program is offering summer kits to registered children ages 6-17, shipped directly to families.",
        "Register through the PAARNG form:",
        longUrl
      ].join("\n"),
      status: "published",
      publishedAt,
      createdAt: publishedAt,
      updatedAt: publishedAt
    },
    issues: [],
    contentBlocks: {
      announcements: [{
        id: "mobile-overflow-content",
        title: longCardTitle,
        summary: longCardSummary,
        href: longUrl,
        linkLabel: longLinkLabel,
        status: "published"
      }],
      events: [],
      resources: []
    }
  };
}

async function expectHorizontallyContained(locator, label, viewportWidth) {
  const geometry = await locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    };
  });

  expect(geometry.left, `${label} began outside the viewport`).toBeGreaterThanOrEqual(-1);
  expect(geometry.right, `${label} ended outside the ${viewportWidth}px viewport`).toBeLessThanOrEqual(viewportWidth + 1);
  expect(
    geometry.scrollWidth,
    `${label} overflowed internally: scrollWidth=${geometry.scrollWidth}, clientWidth=${geometry.clientWidth}`
  ).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectTextToWrap(locator, label) {
  const metrics = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const fontSize = Number.parseFloat(style.fontSize);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2
    };
  });

  expect(metrics.scrollWidth, `${label} created horizontal scrolling`).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.height, `${label} did not wrap onto multiple lines`).toBeGreaterThan(metrics.lineHeight * 1.5);
}

for (const viewport of viewports) {
  test(`public newsletter stays within a ${viewport.width}x${viewport.height} phone viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/newsletter/public", async route => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(publicNewsletterPayload())
      });
    });
    await page.route("**/api/newsletter/subscribers", async route => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: longRequestError })
      });
    });

    await page.goto(FRONTEND_URL);
    const title = page.getByRole("heading", { name: longTitle, exact: true });
    await expect(title).toBeVisible();

    const documentGeometry = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth
    }));
    expect(documentGeometry.viewportWidth).toBe(viewport.width);
    expect(
      documentGeometry.documentWidth,
      `Document spilled beyond ${viewport.width}px`
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(documentGeometry.bodyWidth, `Body spilled beyond ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);

    const newsletter = page.locator(".public-newsletter-wrap");
    const issue = page.locator(".public-newsletter-latest");
    const body = page.locator(".public-newsletter-body");
    const urlLine = body.getByText(longUrl, { exact: true });
    const edition = page.getByText(longEdition, { exact: true });
    const publicCard = page.locator(".public-info-item", { hasText: longCardTitle });
    const cardTitle = publicCard.getByText(longCardTitle, { exact: true });
    const cardSummary = publicCard.getByText(longCardSummary, { exact: true });
    const cardLink = publicCard.getByRole("link", { name: longLinkLabel, exact: true });
    const accessCard = page.locator(".public-newsletter-request-card");
    const accessButton = accessCard.getByRole("button", { name: "Request access", exact: true });

    await expectHorizontallyContained(publicCard, "Public content card", viewport.width);
    await expectHorizontallyContained(newsletter, "Newsletter layout", viewport.width);
    await expectHorizontallyContained(issue, "Published issue", viewport.width);
    await expectHorizontallyContained(body, "Issue body", viewport.width);
    await expectHorizontallyContained(accessCard, "Newsletter access card", viewport.width);
    await expectHorizontallyContained(accessButton, "Newsletter access button", viewport.width);

    await expectTextToWrap(cardTitle, "Long public content title");
    await expectTextToWrap(cardSummary, "Long public content summary");
    await expectTextToWrap(cardLink, "Long public content link label");
    await expectTextToWrap(title, "Long newsletter title");
    await expectTextToWrap(edition, "Long newsletter edition label");
    await expectTextToWrap(urlLine, "Long newsletter URL");

    await accessButton.click();
    const dialog = page.getByRole("dialog", { name: "Request company updates" });
    await expect(dialog).toBeVisible();
    await expectHorizontallyContained(dialog, "Newsletter request dialog", viewport.width);
    const dialogBounds = await dialog.boundingBox();
    expect(dialogBounds.y).toBeGreaterThanOrEqual(-1);
    expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(viewport.height + 1);
    await dialog.getByLabel("Name").fill("Mobile Test User");
    await dialog.getByLabel("Email address").fill("mobile-overflow@876en.test");
    await dialog.getByLabel("Connection").fill("Family");
    await dialog.getByLabel("Unit contact").fill("QA Lead");
    await dialog.getByRole("button", { name: "Submit request" }).click();
    const requestError = dialog.getByText(longRequestError, { exact: true });
    await expect(requestError).toBeVisible();
    await expectHorizontallyContained(requestError, "Newsletter request error", viewport.width);
    await expectTextToWrap(requestError, "Long newsletter request error");
  });
}
