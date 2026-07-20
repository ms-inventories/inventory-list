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

async function createBlankInventory(page, inventoryName) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  await activeInventory.getByRole("button", { name: /^(Start another inventory|Start inventory)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Start inventory" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Create blank inventory" }).check();
  await dialog.getByLabel("Inventory name").fill(inventoryName);
  await dialog.getByRole("button", { name: "Start inventory", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectSelectedInventory(page, inventoryName);
}

test.describe("tenant inventory cleanup", () => {
  test("platoon admin can delete an abandoned empty inventory without stale errors", async ({ page }) => {
    const sessionName = `QA cleanup ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openInventoryWorkspace(page);
    await createBlankInventory(page, sessionName);

    await expectSelectedInventory(page, sessionName);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText("0 items");
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    const inventoryActionsTrigger = inventoryWorkspace.getByRole("button", {
      name: `Inventory actions for ${sessionName}`,
      exact: true
    });
    await expect(inventoryActionsTrigger).toHaveAttribute("aria-expanded", "false");
    await inventoryActionsTrigger.click();
    const inventoryActions = inventoryWorkspace.getByRole("group", {
      name: `Manage inventory ${sessionName}`,
      exact: true
    });
    await expect(inventoryActions).toBeVisible();
    await inventoryActions.getByRole("button", { name: "Delete empty inventory" }).click();

    const deleteDialog = page.getByRole("dialog", { name: "Delete empty inventory?" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete inventory" }).click();
    await expect(deleteDialog).toBeHidden();

    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Active inventory" })).not.toContainText(sessionName);
  });
});
