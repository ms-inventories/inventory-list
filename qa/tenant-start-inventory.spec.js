import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

async function openInventoryWorkspace(page) {
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
}

async function expectSelectedInventory(page, name) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
  await expect.poll(async () => {
    if (await selector.count()) return selector.locator("option:checked").textContent();
    const heading = activeInventory.getByRole("heading", { name, exact: true });
    return (await heading.count()) ? heading.textContent() : "";
  }).toContain(name);
}

async function openNewInventoryForm(page, source) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  await activeInventory.getByRole("button", { name: /^(Start another inventory|Start inventory)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Start inventory" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: source }).check();
  const inventoryName = dialog.getByLabel("Inventory name");
  await expect(inventoryName).toBeVisible();
  return {
    dialog,
    inventoryName,
    startButton: dialog.getByRole("button", { name: "Start inventory", exact: true })
  };
}

test.describe("tenant inventory creation", () => {
  test("platoon admin can create a blank inventory from the dashboard workspace", async ({ page }) => {
    const inventoryName = `QA start ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);

    const inventoryCreate = await openNewInventoryForm(page, "Create blank inventory");
    await inventoryCreate.inventoryName.fill(inventoryName);
    await inventoryCreate.startButton.click();

    await expect(inventoryCreate.dialog).toBeHidden();
    await expectSelectedInventory(page, inventoryName);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText("0 items");
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to dashboard", exact: true })).toHaveCount(0);
  });

  test("platoon admin can start a new inventory from packet import", async ({ page }) => {
    const inventoryName = `QA packet ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    const inventoryCreate = await openNewInventoryForm(page, "Upload packet now");
    await inventoryCreate.inventoryName.fill(inventoryName);
    await inventoryCreate.startButton.click();
    await expect(inventoryCreate.dialog).toBeHidden();
    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(packetDialog.getByText("Inventory", { exact: true })).toHaveCount(0);
    await expect(packetDialog.getByRole("button", { name: "Choose source" })).toHaveCount(0);
    await expectSelectedInventory(page, inventoryName);
  });

  test("starting inventory locks the form and retries without duplicate inventories", async ({ page }, testInfo) => {
    const retryInventoryName = `Retry inventory ${testInfo.project.name} ${Date.now()}`;
    let releaseFirstStart;
    const firstStartGate = new Promise(resolve => {
      releaseFirstStart = resolve;
    });
    let startAttempts = 0;
    await page.route("**/api/inventory/sessions", async route => {
      if (route.request().method() !== "POST") return route.continue();
      startAttempts += 1;
      if (startAttempts === 1) {
        await firstStartGate;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary inventory start failure" })
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "qa-start-retry-session", name: retryInventoryName, status: "active" } })
      });
    });

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    const inventoryCreate = await openNewInventoryForm(page, "Create blank inventory");
    const inventoryName = inventoryCreate.inventoryName;
    await inventoryName.fill(retryInventoryName);
    const startButton = inventoryCreate.startButton;
    await startButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => startAttempts).toBe(1);
    await expect(inventoryCreate.dialog.getByRole("button", { name: "Starting..." })).toBeDisabled();
    await expect(inventoryName).toBeDisabled();
    releaseFirstStart();
    await expect(inventoryCreate.dialog.getByRole("alert")).toContainText("Temporary inventory start failure");
    expect(startAttempts).toBe(1);

    await inventoryCreate.dialog.getByRole("button", { name: "Start inventory", exact: true }).click();
    await expect(inventoryCreate.dialog).toBeHidden();
    expect(startAttempts).toBe(2);
  });
});
