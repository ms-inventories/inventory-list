import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const NEWSLETTER_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";

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

async function expectChipTextCentered(locator) {
  await expect(locator).toBeVisible();
  const alignment = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      textAlign: style.textAlign
    };
  });
  expect(alignment.alignItems).toBe("center");
  expect(alignment.justifyContent).toBe("center");
  expect(alignment.textAlign).toBe("center");
}

async function expectTextCenteredInBox(locator) {
  await expect(locator).toBeVisible();
  const alignment = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return {
      display: style.display,
      alignItems: style.alignItems,
      justifyItems: style.justifyItems,
      textAlign: style.textAlign,
      horizontalOffset: Math.abs((text.left + (text.width / 2)) - (box.left + (box.width / 2)))
    };
  });
  expect(alignment.display).toBe("grid");
  expect(alignment.alignItems).toBe("center");
  expect(alignment.justifyItems).toBe("center");
  expect(alignment.textAlign).toBe("center");
  expect(alignment.horizontalOffset).toBeLessThanOrEqual(1);
}

async function openPlatformView(page, name) {
  const toggle = page.locator('button[aria-label="Open platform menu"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("main.platform-main")).toHaveAttribute("aria-hidden", "true");
  const item = page.getByRole("button", { name, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("main.platform-main")).not.toHaveAttribute("aria-hidden", "true");
}

async function openWorkspaceView(page, name) {
  const toggle = page.locator('button[aria-label="Open workspace menu"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("main.leader-main")).toHaveAttribute("aria-hidden", "true");
  const item = page.getByRole("button", { name, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("main.leader-main")).not.toHaveAttribute("aria-hidden", "true");
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

    await expect(page.locator(".platform-stat-card")).toHaveCount(0);
    const platoonGrid = page.getByRole("region", { name: "Platoon workspaces" });
    const platoonCard = page.locator(".platform-platoon-card").filter({ hasText: "MS Platoon" }).first();
    await expect(platoonCard).toBeVisible();
    await expectMinFontSize(platoonCard.getByRole("heading", { name: "MS Platoon" }), 17);
    await expectTextCenteredInBox(platoonCard.locator(".tenant-avatar"));
    await expectChipTextCentered(platoonCard.locator(".status-pill"));
    await expectMinTargetSize(platoonCard.getByRole("button", { name: "Copy link for MS Platoon" }), { width: 44, height: 44 });
    await expectMinTargetSize(platoonCard.getByRole("link", { name: /Enter MS Platoon workspace/i }), { height: 48 });
    await expectContained(platoonGrid);
    await expectContained(platoonCard);
    await expectContained(page.locator("main"));

    const navToggle = page.getByRole("button", { name: "Open platform menu" });
    await navToggle.click();
    await expect(page.locator("main.platform-main")).toHaveAttribute("aria-hidden", "true");
    const supportNavItem = page.getByRole("button", { name: "Support", exact: true });
    await expectMinTargetSize(supportNavItem, { height: 54 });
    await expectMinFontSize(supportNavItem, 16);
    await supportNavItem.click();
    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "tm.lewisbenson@gmail.com" })).toBeVisible();
    await expectContained(page.locator("main"));

    await openPlatformView(page, "Settings");
    await expect(page.getByRole("heading", { name: "Platform settings", exact: true })).toBeVisible();
    const setup = page.locator(".platform-setup-details").first();
    await setup.locator("summary").click();
    await expectMinTargetSize(setup.getByRole("combobox", { name: "Platoon setup" }), { height: 44 });
    await expectContained(setup);
    const createPlatoonTrigger = page.getByRole("button", { name: "Create platoon" }).first();
    await createPlatoonTrigger.click();
    const createDialog = page.getByRole("dialog", { name: "Create platoon" });
    await expectWithinViewport(page, createDialog);
    await expectContained(createDialog);
    await expect(createDialog.getByText(/add its leader after permanent account setup is connected/i)).toBeVisible();
    await expect(createDialog.getByLabel("Platoon admin email")).toBeDisabled();
    await expect(createDialog.getByLabel("Platoon admin name")).toBeDisabled();
    await expect(createDialog.getByLabel("Platoon name")).toBeFocused();
    await expectMinTargetSize(createDialog.getByRole("button", { name: "Close create platoon" }), { width: 44, height: 44 });
    await expectMinTargetSize(createDialog.getByRole("button", { name: "Create platoon", exact: true }), { height: 48 });
    await expectMinTargetSize(createDialog.getByRole("button", { name: "Cancel" }), { height: 48 });
    await page.keyboard.press("Shift+Tab");
    await expect(createDialog.getByRole("button", { name: "Close create platoon" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(createDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(createDialog.getByRole("button", { name: "Close create platoon" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(createDialog).toBeHidden();
    await expect(createPlatoonTrigger).toBeFocused();

    await openPlatformView(page, "Users");
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    const addUser = page.getByRole("button", { name: "Add user", exact: true });
    await expect(addUser).toBeVisible();
    const accessRow = page.getByRole("table", { name: "Platform users" }).getByRole("row").filter({ hasText: "QA NCO" }).filter({ hasText: "MS Platoon" });
    for (const label of ["Role", "Status"]) {
      await expect(accessRow.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
    }
    await expectMinTargetSize(accessRow.getByRole("combobox", { name: /Role for/ }), { height: 44 });
    await expectMinTargetSize(accessRow.getByRole("combobox", { name: /Status for/ }), { height: 44 });
    await expect(accessRow.getByRole("link", { name: "Open platoon" })).toHaveCount(0);
    expect(await accessRow.evaluate(row => Math.ceil(row.getBoundingClientRect().height))).toBeLessThanOrEqual(220);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(accessRow).toBeVisible();
    expect(await accessRow.evaluate(row => getComputedStyle(row).gridTemplateColumns.split(" ").length)).toBe(1);
    await expectInsideHorizontally(page.getByRole("table", { name: "Platform users" }), accessRow);
    await expectContained(page.locator("main"));
  });

  test("permanent Team access stays compact and honest when provisioning is not connected", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    await openWorkspaceView(page, "Team");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    await expect(page.getByText("Add teammate", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
    const addTeammate = page.locator(".add-teammate-card");
    await expect(addTeammate).not.toHaveAttribute("open", "");
    await addTeammate.locator(".add-teammate-summary").click();
    await expect(page.getByText("Permanent account setup is not connected yet.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open inventories" })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);

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

  test("platform workspace cards stay contained throughout the mobile drawer breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);

    const topbar = page.locator(".platform-topbar");
    const accountTrigger = page.getByRole("button", { name: "Open account actions" });
    await expectContained(topbar);
    await expect(page.locator(".platform-mobile-title")).toBeVisible();
    await expect(page.locator(".platform-topbar-refresh")).toBeHidden();
    await expect(page.locator(".platform-topbar-signout")).toBeHidden();
    await expectContained(accountTrigger);
    await expectWithinViewport(page, accountTrigger);
    await accountTrigger.click();
    const accountMenu = page.getByRole("region", { name: "Account menu" });
    await expectWithinViewport(page, accountMenu);
    for (const action of ["Refresh platform", "App portal", "Diagnostics", "Copy diagnostics", "Sign out"]) {
      await expectMinTargetSize(accountMenu.getByRole("button", { name: action, exact: true }), { height: 44 });
    }
    await page.keyboard.press("Escape");

    const grid = page.getByRole("region", { name: "Platoon workspaces" });
    const card = page.locator(".platform-platoon-card").filter({ hasText: "MS Platoon" }).first();
    await expectInsideHorizontally(grid, card);
    await expectMinTargetSize(card.getByRole("link", { name: /Enter MS Platoon workspace/i }), { height: 44 });
    await expectMinTargetSize(card.getByRole("button", { name: "Copy link for MS Platoon" }), { height: 44 });
    await expectContained(page.locator("main"));
  });

  test("tenant toolbar, drawer navigation, reports, and inventory cards stay usable", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Active inventory" })).toBeVisible();
    await expectWithinViewport(page, page.locator(".leader-topbar"));
    await expectContained(page.locator("main"));

    await expect(page.getByRole("button", { name: "Upload packet" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start new inventory" })).toHaveCount(0);

    await openWorkspaceView(page, "Workspace Settings");
    await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible();
    await expectContained(page.locator("main"));

    await openWorkspaceView(page, "Reports");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const reportRow = page.locator(".reports-table-row").first();
    await expect(reportRow).toBeVisible();
    for (const label of ["Inventory", "Item", "Outcome", "Proof status", "Location / serial"]) {
      await expect(reportRow.locator(".mobile-field-label").getByText(label, { exact: true })).toBeVisible();
    }
    await expectContained(page.locator("main"));

    await openWorkspaceView(page, "Dashboard");
    const activeInventory = page.getByRole("region", { name: "Active inventory", exact: true });
    const activeInventorySelect = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
    await expect(activeInventorySelect).toBeVisible();
    await activeInventorySelect.selectOption({ label: "July sensitive items" });
    await expect(activeInventorySelect.locator("option:checked")).toHaveText("July sensitive items");
    await expect(page.getByRole("region", { name: "Pending inventory results", exact: true })).toHaveCount(0);
    await activeInventory.getByRole("button", { name: "Open inventory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    await expectWithinViewport(page, page.getByRole("searchbox", { name: "Search inventory items" }));
    await expect(page.getByRole("heading", { name: "Leader Dashboard", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to dashboard", exact: true })).toBeVisible();
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    const assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
    for (const name of [/^Unclaimed\b/, /^Mine\b/, /^Others\b/]) {
      await expectMinTargetSize(assignmentLists.getByRole("button", { name }), { height: 48 });
    }
    await assignmentLists.getByRole("button", { name: /^Unclaimed\b/ }).click();
    const sessionRow = inventoryWorkspace.locator(".session-item", { hasText: "Generator" });
    await expect(sessionRow).toBeVisible();
    await expect(sessionRow.getByRole("button", { name: "Found", exact: true })).toBeHidden();
    await expect(sessionRow.getByRole("button", { name: "Claim item" })).toBeVisible();
    await expectMinTargetSize(sessionRow.getByRole("button", { name: "Claim item" }), { height: 44 });
    await expect(sessionRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(page.getByRole("dialog"), "inventory items should not require a generic item dialog").toHaveCount(0);
    const inlineControls = sessionRow.locator(".session-item-inline-manage");
    await expect(inlineControls.getByRole("heading", { name: "Leader controls" })).toBeVisible();
    await expectMinTargetSize(inlineControls.getByRole("combobox", { name: "Assign to" }), { height: 44 });
    await expectMinTargetSize(inlineControls.getByRole("combobox", { name: "Set result" }), { height: 44 });
    const sessionMain = inventoryWorkspace.locator(".session-main");
    const sessionSidebar = inventoryWorkspace.locator(".session-sidebar");
    const [mainBox, sidebarBox] = await Promise.all([sessionMain.boundingBox(), sessionSidebar.boundingBox()]);
    expect(mainBox.y).toBeLessThan(sidebarBox.y);
    const toolsSummary = inventoryWorkspace.locator(".session-tools > summary");
    const [rowBox, toolsBox] = await Promise.all([sessionRow.boundingBox(), toolsSummary.boundingBox()]);
    expect(rowBox.y).toBeLessThan(toolsBox.y);
    await expectContained(sessionRow);
    await expectContained(page.locator("main"));
  });

  test("compact 360px headers keep every primary control inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await seedQaRootSession(page);

    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    for (const control of [
      page.getByRole("button", { name: "Open workspace menu" }),
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

  test("newsletter navigation, header, and subscriber review stay orderly at 360px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await seedQaRootSession(page);
    await page.route("**/api/newsletter/admin", async route => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          issues: [],
          contentBlocks: [],
          deliveries: [],
          subscribers: [{
            id: "mobile-pending-subscriber",
            displayName: "Lewis Benson",
            email: "mobile-review@876en.test",
            platoon: "Soldier",
            supervisorName: "Me",
            status: "pending",
            createdAt: "2026-07-17T12:00:00.000Z",
            lastSubscribedAt: "2026-07-17T12:00:00.000Z"
          }],
          subscriberStats: { pending: 1, active: 0, rejected: 0, unsubscribed: 0, total: 1 },
          deliverySettings: { emailConfigured: true }
        })
      });
    });

    await page.goto(NEWSLETTER_URL);
    await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();

    const topbar = page.locator(".newsletter-shell .platform-topbar");
    const menuToggle = page.locator('button[aria-label="Open newsletter menu"]');
    await expectContained(topbar);
    await expectWithinViewport(page, menuToggle);
    await expectWithinViewport(page, page.locator(".newsletter-user-card"));
    await expect(menuToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".newsletter-sidebar")).toHaveAttribute("aria-hidden", "true");

    await menuToggle.click();
    await expect(menuToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("main.platform-main")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("button", { name: "Close newsletter menu" }).last()).toBeFocused();
    const subscribersNav = page.getByRole("button", { name: "Subscribers", exact: true });
    await expectMinTargetSize(subscribersNav, { height: 54 });
    await subscribersNav.click();
    await expect(menuToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("main.platform-main")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".newsletter-sidebar")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("heading", { name: "Subscribers", exact: true, level: 1 })).toBeVisible();

    const subscriberRow = page.locator(".newsletter-subscriber-table-row", { hasText: "Lewis Benson" });
    await expectContained(subscriberRow);
    await expectChipTextCentered(subscriberRow.locator(".status-pill"));
    const viewDetails = subscriberRow.getByRole("button", { name: "View details", exact: true });
    await expectMinTargetSize(viewDetails, { height: 44 });
    await viewDetails.click();
    const subscriberDialog = page.getByRole("dialog", { name: "Lewis Benson" });
    await expectContained(subscriberDialog);
    await expect(subscriberDialog.getByText("mobile-review@876en.test", { exact: true })).toBeVisible();
    await expectMinTargetSize(subscriberDialog.getByRole("button", { name: "Approve subscriber", exact: true }), { height: 44 });
    await expectMinTargetSize(subscriberDialog.getByRole("button", { name: "Reject request", exact: true }), { height: 44 });
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

test.describe("intermediate inventory layout", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Intermediate desktop widths are covered once in Chromium.");
  });

  test("keeps inventory hierarchy and actions usable from 900px through 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedQaRootSession(page);
    await page.goto("http://qa-search-desktop.localhost:5175/#/admin");
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Open inventories", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    const session = page.locator(".session-row", { hasText: "Search behavior fixture" });
    await expect(session).toBeVisible();
    await session.click();
    const currentInventory = page.getByRole("combobox", { name: "Current inventory", exact: true });
    if (await currentInventory.isVisible()) {
      await expect(currentInventory.locator("option:checked")).toHaveText("Search behavior fixture");
    } else {
      await expect(page.locator(".session-summary").getByText("Search behavior fixture", { exact: true })).toBeVisible();
    }
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await inventoryWorkspace.getByRole("group", { name: "Work assignment lists" }).getByRole("button", { name: /^Unclaimed\b/ }).click();

    const row = inventoryWorkspace.locator(".session-item", { hasText: "Quiet Generator" });
    const actions = row.locator(".session-item-actions");
    const inlineControls = row.locator(".session-item-inline-manage");
    const sessionMain = inventoryWorkspace.locator(".session-main");
    const sessionSidebar = inventoryWorkspace.locator(".session-sidebar");
    const [wideMainBox, wideSidebarBox] = await Promise.all([sessionMain.boundingBox(), sessionSidebar.boundingBox()]);
    expect(wideMainBox.x).toBeLessThan(wideSidebarBox.x);

    for (const width of [1024, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
      await expectInsideHorizontally(row, actions);
      await expect(row.getByRole("button", { name: "Found", exact: true })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Not found", exact: true })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Claim item", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await expect(inlineControls.getByRole("heading", { name: "Leader controls" })).toBeVisible();
      await expectInsideHorizontally(row, inlineControls);
      const [mainBox, sidebarBox] = await Promise.all([sessionMain.boundingBox(), sessionSidebar.boundingBox()]);
      expect(mainBox.y).toBeLessThan(sidebarBox.y);
    }

    await expect(page.getByRole("dialog"), "resizing inline inventory work must not open a dialog").toHaveCount(0);
  });

  test("keeps the Users table readable without horizontal panning on compact desktops", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await seedQaRootSession(page);
    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Users", exact: true }).click();

    const userTable = page.getByRole("table", { name: "Platform users" });
    await expect(userTable).toBeVisible();
    for (const width of [1024, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
      await expect.poll(() => userTable.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      const firstUserRow = userTable.locator(".platform-table-row").first();
      await expect(firstUserRow).toBeVisible();
      await expect(firstUserRow.locator(".mobile-field-label").getByText("Role", { exact: true })).toBeVisible();
      await expect(firstUserRow.locator(".mobile-field-label").getByText("Status", { exact: true })).toBeVisible();
    }
  });
});
