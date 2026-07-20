import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

async function openInventoryWorkspace(page) {
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
  await expect(page.locator(".session-summary")).toBeVisible();
}

async function openNewInventoryForm(page) {
  const inventoryCreate = page.locator("details.session-create");
  await expect(inventoryCreate).toBeVisible();
  if (!(await inventoryCreate.evaluate(element => element.open))) {
    await inventoryCreate.locator("summary").click();
  }
  await expect(inventoryCreate.getByLabel("Inventory name")).toBeVisible();
  return inventoryCreate;
}

async function openPacketUpload(page) {
  const workspace = page.getByRole("region", { name: "Inventory workspace" });
  const addItems = workspace.getByRole("button", { name: "Add items from packet", exact: true });
  const inventoryTools = workspace.locator("details.session-tools");
  const inventoryToolsSummary = inventoryTools.locator(":scope > summary");
  const startFromPacket = workspace.getByRole("button", { name: "Start inventory from packet", exact: true });
  const dialog = page.getByRole("dialog", { name: "Upload packet" });

  await expect.poll(async () => {
    if (await dialog.isVisible()) return true;

    try {
      if (await addItems.isVisible()) {
        await addItems.click({ timeout: 1_000 });
      } else if (await inventoryToolsSummary.isVisible()) {
        if (!(await inventoryTools.evaluate(element => element.open))) {
          await inventoryToolsSummary.click({ timeout: 1_000 });
        }
        const addPacket = inventoryTools.getByRole("button", { name: "Add packet", exact: true });
        if (await addPacket.isVisible()) await addPacket.click({ timeout: 1_000 });
      } else if (await startFromPacket.isVisible()) {
        await startFromPacket.click({ timeout: 1_000 });
      }
    } catch {
      // The inventory list may replace the empty state during this interaction.
    }

    return dialog.isVisible();
  }, { timeout: 15_000, intervals: [100, 200, 500] }).toBe(true);
}

test.describe("tenant inventory creation", () => {
  test("platoon admin can create a blank inventory from Manage inventories", async ({ page }) => {
    const inventoryName = `QA start ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);

    const inventoryCreate = await openNewInventoryForm(page);
    await inventoryCreate.getByLabel("Inventory name").fill(inventoryName);
    await inventoryCreate.getByRole("button", { name: "Start inventory", exact: true }).click();

    const inventoryRow = page.locator(".session-row", { hasText: inventoryName });
    await expect(inventoryRow).toHaveCount(1);
    await inventoryRow.click();
    await expect(page.locator(".session-summary", { hasText: inventoryName })).toContainText("0 items");
    await expect(page.getByRole("button", { name: new RegExp(`${inventoryName}.*0 items`) }).first()).toBeVisible();
    await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Active inventory" }),
      "the newly started inventory should appear on the dashboard without a page reload"
    ).toContainText(inventoryName);
  });

  test("platoon admin can start a new inventory from packet import", async ({ page }) => {
    const inventoryName = `QA packet ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    await openPacketUpload(page);

    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    const newInventoryChoice = packetDialog.locator("label.packet-choice", { hasText: "Start a new inventory" });
    await newInventoryChoice.getByRole("radio").check();
    await newInventoryChoice.locator("input.input").fill(inventoryName);
    await packetDialog.getByRole("button", { name: "Choose source" }).click();

    await expect(packetDialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(page.locator(".session-row", { hasText: inventoryName })).toHaveCount(1);
  });

  test("starting inventory locks the form and retries without duplicate inventories", async ({ page }) => {
    let startAttempts = 0;
    await page.route("**/api/inventory/sessions", async route => {
      if (route.request().method() !== "POST") return route.continue();
      startAttempts += 1;
      if (startAttempts === 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary inventory start failure" })
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "qa-start-retry-session", name: "Retry inventory", status: "active" } })
      });
    });

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    const inventoryCreate = await openNewInventoryForm(page);
    const inventoryName = inventoryCreate.getByLabel("Inventory name");
    await inventoryName.fill("Retry inventory");
    const startButton = inventoryCreate.getByRole("button", { name: "Start inventory", exact: true });
    await startButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => startAttempts).toBe(1);
    await expect(inventoryCreate.getByRole("button", { name: "Starting inventory..." })).toBeDisabled();
    await expect(inventoryName).toBeDisabled();
    await expect(page.locator(".session-panel").getByRole("alert")).toContainText("Temporary inventory start failure");
    expect(startAttempts).toBe(1);

    await inventoryCreate.getByRole("button", { name: "Start inventory" }).click();
    await expect(inventoryCreate.getByLabel("Inventory name")).toBeHidden();
    expect(startAttempts).toBe(2);
  });
});
