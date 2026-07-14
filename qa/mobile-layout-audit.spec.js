import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
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

async function expectContained(locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
}

async function expectWithinViewport(page, locator) {
  await expect(locator).toBeVisible();
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectMinFontSize(locator, minimumPx) {
  await expect(locator).toBeVisible();
  const fontSize = await locator.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(minimumPx);
}

async function expectMinTargetSize(locator, { width = 0, height = 44 } = {}) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(width);
  expect(box.height).toBeGreaterThanOrEqual(height);
}

async function expectInsideHorizontally(container, child) {
  await expect(container).toBeVisible();
  await expect(child).toBeVisible();
  const [containerBox, childBox] = await Promise.all([container.boundingBox(), child.boundingBox()]);
  expect(childBox.x).toBeGreaterThanOrEqual(containerBox.x - 1);
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 1);
}

async function openPlatformView(page, name) {
  const toggle = page.getByRole("button", { name: "Open platform menu" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const item = page.getByRole("button", { name, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

async function openWorkspaceView(page, name) {
  const toggle = page.getByRole("button", { name: "Open workspace menu" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const item = page.getByRole("button", { name, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

test.describe("mobile layout audit", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.project.use.isMobile, "The full navigation audit is intentionally mobile-only.");
  });

  test("platform navigation, cards, dialogs, and contextual actions stay usable", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    const dashboardHeading = page.getByRole("heading", { name: "Dashboard", exact: true });
    await expectMinFontSize(dashboardHeading, 32);
    await expectMinFontSize(page.locator(".platform-page-heading p"), 17);
    await expect(page.locator(".platform-mobile-title")).toBeVisible();
    await expectMinTargetSize(page.getByRole("button", { name: "Open platform menu" }), { width: 48, height: 48 });
    await expectMinTargetSize(page.getByRole("button", { name: "Open account actions" }), { width: 48, height: 48 });
    const topbarBox = await page.locator(".platform-topbar").boundingBox();
    expect(topbarBox.height).toBeLessThanOrEqual(72);
    await expectMinFontSize(page.locator(".platform-topbar .leader-avatar"), 15);

    const statCards = page.locator(".platform-stat-card");
    await expect(statCards).toHaveCount(4);
    await expectMinFontSize(statCards.first().locator("strong"), 24);
    await expectMinFontSize(statCards.first().locator("div > span"), 15);
    const statBoxes = await statCards.evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }));
    expect(Math.abs(statBoxes[0].y - statBoxes[1].y)).toBeLessThanOrEqual(1);
    expect(statBoxes[2].y).toBeGreaterThan(statBoxes[0].y);

    const recentPlatoons = page.locator(".platform-dashboard-card").filter({ hasText: "Recent platoons" });
    await expect(recentPlatoons.getByRole("row")).toHaveCount(2);
    await expectMinFontSize(recentPlatoons.getByRole("heading", { name: "Recent platoons" }), 18);
    const recentRow = recentPlatoons.getByRole("row").first();
    await expect(recentRow.locator(".platform-domain")).toBeHidden();
    await expect(recentRow.locator(".platform-table-number").first()).toBeHidden();
    await expect(recentRow.locator(".platform-table-number").last()).toBeHidden();
    await expect(recentRow.locator(".platform-table-date")).toBeHidden();
    await expectMinFontSize(recentRow.locator(".platform-row-main strong"), 17);
    await expectMinFontSize(recentRow.locator(".platform-row-main div > span"), 15);
    await expectMinFontSize(recentRow.locator(".mobile-field-label").getByText("Status", { exact: true }), 13);
    await expectMinFontSize(recentRow.locator(".status-pill"), 13);
    await expectMinTargetSize(recentRow.getByRole("link", { name: /Open .* workspace/ }), { height: 50 });
    await expectMinFontSize(recentRow.getByRole("link", { name: /Open .* workspace/ }), 15);
    await expectMinTargetSize(recentRow.getByRole("button", { name: /More actions for/ }), { height: 50 });
    await expectContained(page.locator("main"));

    const navToggle = page.getByRole("button", { name: "Open platform menu" });
    await navToggle.click();
    const supportNavItem = page.getByRole("button", { name: "Support", exact: true });
    await expectMinTargetSize(supportNavItem, { height: 54 });
    await expectMinFontSize(supportNavItem, 16);
    await supportNavItem.click();
    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
    await expectContained(page.locator("main"));

    await openPlatformView(page, "Platoons");
    await expect(page.getByRole("heading", { name: "Platoons", exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "MS Platoon" }).first();
    await expect(row).toBeVisible();
    for (const label of ["Subdomain", "Admins", "Members", "Status", "Created", "Actions"]) {
      await expect(row.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
    }
    await expect(row.getByRole("link", { name: /Open ms\.localhost workspace/ })).toBeVisible();
    const more = row.getByRole("button", { name: "More actions for MS Platoon" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(row.getByRole("link", { name: /admin view/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();
    await expectContained(page.locator("main"));

    await page.getByRole("button", { name: "Create platoon" }).first().click();
    const createDialog = page.getByRole("dialog", { name: "Create platoon" });
    await expectWithinViewport(page, createDialog);
    await expectContained(createDialog);
    await expect(createDialog.getByText(/add its leader after permanent account setup is connected/i)).toBeVisible();
    await expect(createDialog.getByLabel("Platoon admin email")).toBeDisabled();
    await expect(createDialog.getByLabel("Platoon admin name")).toBeDisabled();
    await createDialog.getByRole("button", { name: "Cancel" }).click();

    await openPlatformView(page, "Users");
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    const accessRow = page.getByRole("table", { name: "Workspace access" }).getByRole("row").filter({ hasText: "MS Platoon" }).first();
    for (const label of ["Admin group", "Members", "Admins", "Status", "Actions"]) {
      await expect(accessRow.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
    }
    await expect(accessRow.getByRole("link", { name: /Open ms\.localhost workspace/ })).toBeVisible();
    const accessMore = accessRow.getByRole("button", { name: "More actions for MS Platoon" });
    await accessMore.click();
    await expect(accessMore).toHaveAttribute("aria-expanded", "true");
    await expect(accessRow.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(accessRow.getByRole("link", { name: /admin view/i })).toHaveCount(0);
    await expectContained(page.locator("main"));
  });

  test("permanent Team access stays compact and honest when provisioning is not connected", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    await openWorkspaceView(page, "Team");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add permanent teammate" })).toBeVisible();
    await expect(page.getByText("Permanent account setup is not connected yet.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add teammate" })).toBeDisabled();

    const peoplePanel = page.locator(".people-panel");
    await expectContained(peoplePanel);
    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();

    const legacyLinks = page.locator(".legacy-links-card");
    await expect(legacyLinks.getByText("Legacy sign-in links", { exact: true })).toBeVisible();
    await expect(legacyLinks).not.toHaveAttribute("open", "");

    const manage = page.locator(".team-member-manage > summary").first();
    await expectMinTargetSize(manage, { height: 44 });
    await manage.click();
    await expect(page.locator(".team-member-manage .member-role-select").first()).toBeVisible();
  });

  test("platform workspace cards replace clipped tables throughout the mobile drawer breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    await openPlatformView(page, "Platoons");
    const table = page.getByRole("table", { name: "Platoon workspaces" });
    const row = table.getByRole("row").filter({ hasText: "MS Platoon" }).first();
    await expectInsideHorizontally(table, row);
    await expect(row.locator(".mobile-field-label").getByText("Subdomain", { exact: true })).toBeVisible();
    await expectMinTargetSize(row.getByRole("link", { name: /Open ms\.localhost workspace/ }), { height: 44 });
    await expectMinTargetSize(row.getByRole("button", { name: "More actions for MS Platoon" }), { height: 44 });
    await expectContained(page.locator("main"));
  });

  test("tenant toolbar, drawer navigation, reports, and session cards stay usable", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Active inventory" })).toBeVisible();
    await expectWithinViewport(page, page.locator(".leader-topbar"));
    await expectContained(page.locator("main"));

    const uploadPacket = page.getByRole("button", { name: "Upload packet" });
    await expect(uploadPacket).toBeVisible();
    await expectMinTargetSize(uploadPacket, { height: 44 });

    await openWorkspaceView(page, "Workspace Settings");
    await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible();
    await expectContained(page.locator("main"));

    await openWorkspaceView(page, "Reports");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const reportRow = page.locator(".reports-table-row").first();
    await expect(reportRow).toBeVisible();
    for (const label of ["Session", "Item", "Outcome", "Proof status", "Location / serial"]) {
      await expect(reportRow.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
    }
    await expectContained(page.locator("main"));

    await openWorkspaceView(page, "Inventory Sessions");
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    const assignmentLists = page.getByRole("group", { name: "Work assignment lists" });
    for (const name of [/^Unclaimed\b/, /^Mine\b/, /^Others\b/]) {
      await expectMinTargetSize(assignmentLists.getByRole("button", { name }), { height: 48 });
    }
    const sessionRow = page.locator(".session-item").filter({
      has: page.getByRole("button", { name: "Claim item" })
    }).first();
    await expect(sessionRow).toBeVisible();
    await expect(sessionRow.locator(".session-assignment-control")).toBeHidden();
    await expect(sessionRow.getByRole("button", { name: "Found", exact: true })).toBeHidden();
    await expect(sessionRow.getByRole("button", { name: "Claim item" })).toBeVisible();
    const details = sessionRow.getByRole("button", { name: /Open details for/ });
    await expect(details).toBeVisible();
    await details.click();
    const drawer = page.getByRole("dialog");
    await expectWithinViewport(page, drawer);
    await expectContained(drawer);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();
    await expectContained(page.locator("main"));
  });

  test("compact 360px headers keep every primary control inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await seedQaRootSession(page);

    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    for (const control of [
      page.getByRole("button", { name: "Open workspace menu" }),
      page.getByRole("searchbox", { name: "Search dashboard" }),
      page.getByRole("button", { name: "Open user menu" })
    ]) {
      await expectWithinViewport(page, control);
    }
    await expectContained(page.locator("main"));

    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expectWithinViewport(page, page.getByRole("button", { name: "Open platform menu" }));
    await expectWithinViewport(page, page.getByRole("button", { name: "Open account actions" }));
    await expectContained(page.locator("main"));
  });

  test("legacy lookup keeps search and scanning primary with secondary actions disclosed", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("http://ms.localhost:5175/#/lookup");
    await expect(page.getByRole("heading", { name: "Shadow Tracer" })).toBeVisible();
    await expect(page.getByLabel("Platoon")).toBeEnabled();
    await page.getByLabel("Password").fill("demo");
    await page.getByRole("button", { name: "Open equipment list" }).click();

    const search = page.getByRole("searchbox", { name: "Search inventory" });
    await expectWithinViewport(page, search);
    await expect(page.getByRole("button", { name: "Scan paper" })).toBeVisible();
    const more = page.getByRole("button", { name: "More inventory actions" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Upload PDF" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change platoon" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();

    await search.fill("radio cage");
    await expect(page.getByText("DAGR GPS", { exact: true })).toBeVisible();
    await expect(page.getByText("HMEE", { exact: true })).toHaveCount(0);
    await search.fill("5825-0152-64783");
    await expect(page.getByText("DAGR GPS", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator(".viewer-card")).toHaveCount(3);
    await expectContained(page.locator(".app-frame"));
  });
});

test.describe("intermediate session layout", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Intermediate desktop widths are covered once in Chromium.");
  });

  test("keeps session rows and actions inside 900px and 1024px viewports", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await seedQaRootSession(page);
    await page.goto("http://qa-search-desktop.localhost:5175/#/admin");
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    await page.getByRole("button", { name: "Inventory Sessions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    const session = page.locator(".session-row", { hasText: "Search behavior fixture" });
    await expect(session).toBeVisible();
    await session.click();
    await expect(page.locator(".session-summary").getByText("Search behavior fixture", { exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Work assignment lists" }).getByRole("button", { name: /^Unclaimed\b/ }).click();

    const row = page.locator(".session-item", { hasText: "Quiet Generator" });
    const actions = row.locator(".session-item-actions");
    const details = row.getByRole("button", { name: /Open details for/ });

    for (const width of [1024, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
      await expectInsideHorizontally(row, actions);
      await expect(row.locator(".session-assignment-control")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Found", exact: true })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Not found", exact: true })).toHaveCount(0);
      await expect(details).toBeVisible();
    }

    await details.click();
    const drawer = page.getByRole("dialog");
    await expectWithinViewport(page, drawer);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();
  });
});
