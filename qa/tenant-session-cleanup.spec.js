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
}

async function createBlankInventory(page, inventoryName) {
  const inventoryCreate = page.locator("details.session-create");
  if (!(await inventoryCreate.evaluate(element => element.open))) {
    await inventoryCreate.locator("summary").click();
  }
  await inventoryCreate.getByLabel("Inventory name").fill(inventoryName);
  await inventoryCreate.getByRole("button", { name: "Start inventory", exact: true }).click();
  const inventoryRow = page.locator(".session-row", { hasText: inventoryName });
  await expect(inventoryRow).toHaveCount(1);
  await inventoryRow.click();
  await expect(page.locator(".session-summary", { hasText: inventoryName })).toBeVisible();
}

test.describe("tenant inventory cleanup", () => {
  test("platoon admin can delete an abandoned empty inventory without stale errors", async ({ page }) => {
    const sessionName = `QA cleanup ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    await createBlankInventory(page, sessionName);

    await expect(page.getByRole("button", { name: new RegExp(`${sessionName}.*0 items`) }).first()).toBeVisible();
    const inventoryTools = page.locator("details.session-tools");
    if (!(await inventoryTools.evaluate(element => element.open))) {
      await inventoryTools.locator("summary").click();
    }
    await inventoryTools.getByRole("button", { name: "Delete empty inventory" }).click();

    const deleteDialog = page.getByRole("dialog", { name: "Delete empty inventory?" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete inventory" }).click();
    await expect(deleteDialog).toBeHidden();

    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(sessionName) })).toHaveCount(0);
  });
});
