import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInAsPlatoonAdmin(page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openSessions(page) {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
}

async function openNewSessionForm(page) {
  const sessionCreate = page.locator(".session-create").first();
  const sessionName = sessionCreate.locator("#sessionName");
  await sessionCreate.evaluate(element => {
    element.open = true;
  });
  await sessionName.scrollIntoViewIfNeeded();
  await expect(sessionName).toBeVisible();
  return sessionName;
}

async function createEmptySession(page, name) {
  const sessionName = await openNewSessionForm(page);
  await sessionName.fill(name);
  await page.locator(".session-create-form").getByRole("button", { name: "Start inventory", exact: true }).click();
  const inventoryRow = page.locator(".session-row", { hasText: name });
  await expect(inventoryRow).toHaveCount(1);
  await inventoryRow.click();
  await expect(page.locator(".session-summary", { hasText: name })).toBeVisible();
}

async function openInventoryTools(page) {
  const tools = page.locator("details.session-tools");
  await expect(tools).toBeVisible();
  if (!(await tools.evaluate(element => element.open))) {
    await tools.locator(":scope > summary").click();
  }
  return tools;
}

test.describe("session lifecycle", () => {
  test("reuses duplicate empty inventories and can delete the draft", async ({ page }, testInfo) => {
    const sessionName = `QA duplicate ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);

    await createEmptySession(page, sessionName);
    const duplicateName = await openNewSessionForm(page);
    await duplicateName.fill(sessionName);
    await page.locator(".session-create-form").getByRole("button", { name: "Start inventory", exact: true }).click();

    await expect(page.locator(".session-row", { hasText: sessionName })).toHaveCount(1);
    await expect(page.getByText(/already an empty inventory/i)).toBeVisible();

    const inventoryTools = await openInventoryTools(page);
    await inventoryTools.getByRole("button", { name: "Delete empty inventory" }).click();
    await expect(page.getByRole("dialog", { name: "Delete empty inventory?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete inventory" }).click();

    await expect(page.locator(".session-row", { hasText: sessionName })).toHaveCount(0);
    await expect(page.getByText(`Deleted empty inventory ${sessionName}.`)).toBeVisible();
  });

  test("requires confirmation before closing an inventory with packet items", async ({ page }, testInfo) => {
    const sessionName = `QA closeout ${testInfo.project.name} ${Date.now()}`;
    const packetLin = `${testInfo.project.name.startsWith("mobile") ? "M" : "C"}${String(Date.now() % 100000).padStart(5, "0")}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);
    await createEmptySession(page, sessionName);

    await page.getByRole("region", { name: "Inventory workspace" })
      .getByRole("button", { name: "Add items from packet", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Choose source" }).click();
    await dialog.locator("textarea").fill(`000009148 ${packetLin} QA CLOSEOUT TEST ITEM`);
    await dialog.getByRole("button", { name: "Review items" }).click();
    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
    await dialog.getByRole("button", { name: "Import 1 item" }).click();
    await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
    await dialog.getByRole("button", { name: "Open inventory" }).click();

    const inventoryTools = await openInventoryTools(page);
    await inventoryTools.getByRole("button", { name: "Close inventory", exact: true }).click();
    let closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog", { name: "Close this inventory?" })).toHaveCount(0);

    await inventoryTools.getByRole("button", { name: "Close inventory", exact: true }).click();
    closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await closeDialog.getByRole("button", { name: "Close inventory" }).click();

    await expect(page.getByRole("dialog", { name: "Close this inventory?" })).toHaveCount(0);
    await page.locator(".session-archive summary").click();
    await expect(page.locator(".session-archive .session-row", { hasText: sessionName })).toBeVisible();
  });

  test("clears a stale inventory load error after refresh", async ({ page }) => {
    let failNextSessionList = false;
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      const isSessionList = /\/api\/inventory\/sessions\/?$/.test(url.pathname);
      if (isSessionList && failNextSessionList && route.request().method() === "GET") {
        failNextSessionList = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal server error" })
        });
        return;
      }

      await route.continue();
    });

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);

    failNextSessionList = true;
    await page.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(page.getByText("Internal server error")).toBeVisible();
    await page.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
  });
});
