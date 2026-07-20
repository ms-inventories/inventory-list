import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInAsPlatoonAdmin(page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openSessions(page) {
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
}

async function expectSelectedInventory(page, name) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
  await expect.poll(async () => {
    const heading = activeInventory.getByRole("heading", { name, exact: true });
    if (await heading.isVisible()) return heading.textContent();
    return (await selector.isVisible()) ? selector.locator("option:checked").textContent() : "";
  }).toContain(name);
}

async function openNewSessionForm(page) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  await activeInventory.getByRole("button", { name: /^(Start another inventory|Start inventory)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Start inventory" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Create blank inventory" }).check();
  const sessionName = dialog.getByLabel("Inventory name");
  await expect(sessionName).toBeVisible();
  return { dialog, sessionName };
}

async function createEmptySession(page, name) {
  const { dialog, sessionName } = await openNewSessionForm(page);
  await sessionName.fill(name);
  await dialog.getByRole("button", { name: "Start inventory", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectSelectedInventory(page, name);
}

async function openInventoryTools(page) {
  const tools = page.locator("details.session-tools");
  await expect(tools).toBeVisible();
  if (!(await tools.evaluate(element => element.open))) {
    await tools.locator(":scope > summary").click();
  }
  return tools;
}

async function mockSelectedInventoryRemoval(page, { targetItemCount }) {
  const target = {
    id: `lifecycle-target-${targetItemCount ? "close" : "delete"}`,
    name: targetItemCount ? "Selected close inventory" : "Selected delete inventory",
    status: "active",
    itemCount: targetItemCount,
    completedCount: 0,
    foundCount: 0,
    needsReviewCount: 0,
    createdAt: "2026-07-20T16:00:00.000Z",
    startedAt: "2026-07-20T16:00:00.000Z"
  };
  const fallback = {
    ...target,
    id: `lifecycle-fallback-${targetItemCount ? "close" : "delete"}`,
    name: targetItemCount ? "Close fallback inventory" : "Delete fallback inventory",
    itemCount: 1,
    createdAt: "2026-07-20T15:00:00.000Z",
    startedAt: "2026-07-20T15:00:00.000Z"
  };
  const targetPacketLine = targetItemCount ? "SELECTED-CLOSE-QUEUE-ROW" : "";
  const fallbackPacketLine = targetItemCount ? "CLOSE-FALLBACK-QUEUE-ROW" : "DELETE-FALLBACK-QUEUE-ROW";
  const itemFor = (session, packetLine) => ({
    id: `${session.id}-item`,
    sessionId: session.id,
    packetLine,
    expectedQty: 1,
    status: "unchecked",
    assignedTo: null,
    assignedToEmail: null,
    assignedToName: null,
    inventoryItem: null,
    submissions: []
  });
  let targetExists = true;
  let targetStatus = "active";

  await page.route("**/api/inventory/sessions", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      sessions: [
        ...(targetExists ? [{ ...target, status: targetStatus }] : []),
        fallback
      ]
    })
  }));
  await page.route(`**/api/inventory/sessions/${target.id}`, async route => {
    if (route.request().method() === "DELETE") {
      targetExists = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
      return;
    }
    if (route.request().method() === "PATCH") {
      targetStatus = route.request().postDataJSON()?.status || targetStatus;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: { ...target, status: targetStatus }, crewAccessRevoked: 0 })
      });
      return;
    }
    await route.fulfill({
      status: targetExists ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(targetExists ? {
        session: { ...target, status: targetStatus },
        items: targetPacketLine ? [itemFor(target, targetPacketLine)] : [],
        importBatches: []
      } : { error: "Inventory not found" })
    });
  });
  await page.route(`**/api/inventory/sessions/${fallback.id}`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      session: fallback,
      items: [itemFor(fallback, fallbackPacketLine)],
      importBatches: []
    })
  }));

  return { target, fallback, targetPacketLine, fallbackPacketLine };
}

test.describe("session lifecycle", () => {
  test("reuses duplicate empty inventories and can delete the inventory", async ({ page }, testInfo) => {
    const sessionName = `QA duplicate ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);

    await createEmptySession(page, sessionName);
    const { dialog: duplicateDialog, sessionName: duplicateName } = await openNewSessionForm(page);
    await duplicateName.fill(sessionName);
    await duplicateDialog.getByRole("button", { name: "Start inventory", exact: true }).click();

    await expect(duplicateDialog).toBeHidden();
    await expect(page.getByText(`Opened existing inventory ${sessionName}.`, { exact: true })).toBeVisible();
    await expectSelectedInventory(page, sessionName);
    const selector = page.getByRole("region", { name: "Active inventory" })
      .getByRole("combobox", { name: "Active inventory", exact: true });
    if (await selector.isVisible()) await expect(selector.locator("option", { hasText: sessionName })).toHaveCount(1);

    const inventoryTools = await openInventoryTools(page);
    await inventoryTools.getByRole("button", { name: "Delete empty inventory" }).click();
    await expect(page.getByRole("dialog", { name: "Delete empty inventory?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete inventory" }).click();

    await expect(page.getByRole("region", { name: "Active inventory" })).not.toContainText(sessionName);
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
    await expect(dialog.getByRole("heading", { name: "Add the packet source", exact: true })).toBeVisible();
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
    await expect(page.getByRole("region", { name: "Active inventory" })).not.toContainText(sessionName);
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  });

  test("closing the selected inventory aligns the dashboard and queue on the open fallback", async ({ page }) => {
    const scenario = await mockSelectedInventoryRemoval(page, { targetItemCount: 1 });

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);
    await expectSelectedInventory(page, scenario.target.name);

    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(inventoryWorkspace.locator(".session-item", { hasText: scenario.targetPacketLine })).toBeVisible();
    const inventoryTools = await openInventoryTools(page);
    await inventoryTools.getByRole("button", { name: "Close inventory", exact: true }).click();
    const closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close inventory", exact: true }).click();

    await expect(closeDialog).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText(scenario.fallback.name);
    await expect(
      inventoryWorkspace.locator(".session-item", { hasText: scenario.fallbackPacketLine }),
      "the queue should converge on the same fallback inventory shown by the dashboard"
    ).toBeVisible();
    await expect(inventoryWorkspace.getByText(scenario.targetPacketLine, { exact: true })).toHaveCount(0);
  });

  test("deleting the selected empty inventory aligns the dashboard and queue on the open fallback", async ({ page }) => {
    const scenario = await mockSelectedInventoryRemoval(page, { targetItemCount: 0 });

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);
    await expectSelectedInventory(page, scenario.target.name);

    const inventoryTools = await openInventoryTools(page);
    await inventoryTools.getByRole("button", { name: "Delete empty inventory" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete empty inventory?" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete inventory" }).click();

    await expect(deleteDialog).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText(scenario.fallback.name);
    const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await expect(
      inventoryWorkspace.locator(".session-item", { hasText: scenario.fallbackPacketLine }),
      "the queue should converge on the same fallback inventory shown by the dashboard"
    ).toBeVisible();
    await expect(page.getByText(`Deleted empty inventory ${scenario.target.name}.`)).toBeVisible();
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
