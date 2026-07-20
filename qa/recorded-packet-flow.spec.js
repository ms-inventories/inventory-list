import path from "node:path";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PACKET_FIXTURE = path.resolve("output/pdf/army-packet-clean.pdf");
const QA_HEADERS = {
  "X-Dev-Sub": "qa-lead",
  "X-Dev-Email": "qa-lead@876en.test",
  "X-Dev-Name": "QA Platoon Admin",
  "X-Dev-Groups": "876en-ms,876en-platoon-admin",
  "X-Tenant-Slug": "ms"
};

async function signInAsPlatoonAdmin(page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openInventoryWorkspace(page) {
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

async function createBlankInventory(page, name) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  await activeInventory.getByRole("button", { name: /^(Start another inventory|Start inventory)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Start inventory" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Create blank inventory" }).check();
  await dialog.getByLabel("Inventory name").fill(name);
  await dialog.getByRole("button", { name: "Start inventory", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectSelectedInventory(page, name);
}

async function openInventoryActions(page, inventoryName) {
  const workspace = page.getByRole("region", { name: "Inventory workspace" });
  const trigger = workspace.getByRole("button", { name: `Inventory actions for ${inventoryName}`, exact: true });
  const panel = workspace.getByRole("group", { name: `Manage inventory ${inventoryName}`, exact: true });

  await expect(workspace.getByText("Inventory tools", { exact: true })).toHaveCount(0);
  await expect(workspace.getByText("Close-out report", { exact: true })).toHaveCount(0);
  await expect(workspace.getByText("Inventory status", { exact: true })).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-controls", /.+/);
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  return { trigger, panel };
}

async function captureStep(page, testInfo, name) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

test.describe("recorded packet and inventory regression", () => {
  test("packet import history stays readable without exposing the stored source", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const sessionName = `QA recorded flow ${testInfo.project.name} ${Date.now()}`;
    let cleanupSessionId = "";
    const packetMediaRequests = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (/\/media\/tenants\/[^/]+\/packet-imports\//.test(pathname)) {
        packetMediaRequests.push(request.url());
      }
    });

    try {
    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await captureStep(page, testInfo, "01-dashboard");

    await openInventoryWorkspace(page);
    await createBlankInventory(page, sessionName);
    const sessionResponse = await request.get(`${API_URL}/inventory/sessions`, { headers: QA_HEADERS });
    if (!sessionResponse.ok()) throw new Error(await sessionResponse.text());
    const sessionPayload = await sessionResponse.json();
    cleanupSessionId = sessionPayload.sessions?.find(session => session.name === sessionName)?.id || "";
    expect(cleanupSessionId).toBeTruthy();

    const { panel: packetActions } = await openInventoryActions(page, sessionName);
    await packetActions.getByRole("button", { name: "Add packet", exact: true }).click();
    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(packetDialog.getByText("Inventory", { exact: true })).toHaveCount(0);
    await expect(packetDialog.getByRole("button", { name: "Choose source" })).toHaveCount(0);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await packetDialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(packetDialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    await expect(packetDialog.getByText("army-packet-clean.pdf")).toBeVisible();
    await expect(packetDialog.getByText(/27 ready to import/)).toBeVisible();
    const locationHints = packetDialog.getByLabel("Location hint");
    await expect(locationHints).toHaveCount(27);
    await locationHints.first().fill("Vault 2, rack 4");
    await captureStep(page, testInfo, "02-packet-review");

    await packetDialog.getByRole("button", { name: "Import 27 items" }).click();
    await expect(packetDialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
    await captureStep(page, testInfo, "03-import-complete");
    await packetDialog.getByRole("button", { name: /^(Open inventory|Review matches)$/ }).click();

    await expect(packetDialog).toBeHidden();
    await expect(page.locator(".session-item-drawer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expectSelectedInventory(page, sessionName);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText("27 items");
    const importedRow = page.locator(".session-item", { hasText: "Vault 2, rack 4" });
    await expect(importedRow).toHaveCount(1);
    let { trigger: inventoryActionsTrigger, panel: inventoryActions } = await openInventoryActions(page, sessionName);
    await expect(inventoryActions.getByRole("button", { name: /^Import history\b/ })).toBeVisible();
    await inventoryActions.getByRole("button", { name: /^Import history\b/ }).click();
    const importHistoryDialog = page.getByRole("dialog", { name: "Import history", exact: true });
    await expect(importHistoryDialog).toBeVisible();
    await expect(importHistoryDialog).toHaveAttribute("aria-modal", "true");
    await expect(inventoryActions).toHaveCount(0);
    const importHistory = importHistoryDialog.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(importHistory).toBeVisible();
    await expect(importHistory).not.toContainText("application/pdf");
    await expect(importHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(importHistory.getByRole("link", { name: /Open source|Source/i })).toHaveCount(0);
    await expect(importHistory.locator('a[href*="/packet-imports/"]')).toHaveCount(0);
    await expect(importHistoryDialog.getByRole("button", { name: "Review again" })).toHaveCount(0);
    await captureStep(page, testInfo, "04-session-with-source-history");
    await page.keyboard.press("Escape");
    await expect(importHistoryDialog).toBeHidden();
    await expect(inventoryActionsTrigger).toBeFocused();

    ({ panel: inventoryActions } = await openInventoryActions(page, sessionName));
    await inventoryActions.getByRole("button", { name: "Close inventory", exact: true }).click();
    const closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close inventory" }).click();
    await expect(closeDialog).toBeHidden();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Active inventory" })).not.toContainText(sessionName);
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "05-dashboard-after-closeout");

    const reopenResponse = await request.patch(`${API_URL}/inventory/sessions/${cleanupSessionId}`, {
      headers: QA_HEADERS,
      data: { status: "active" }
    });
    if (!reopenResponse.ok()) throw new Error(await reopenResponse.text());
    await page.reload();
    await openInventoryWorkspace(page);
    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const selector = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
    await expect.poll(async () => {
      if (await selector.count()) return selector.locator(`option[value="${cleanupSessionId}"]`).count();
      return (await activeInventory.textContent())?.includes(sessionName) ? 1 : 0;
    }).toBe(1);
    if (await selector.count()) await selector.selectOption(cleanupSessionId);
    await expectSelectedInventory(page, sessionName);
    await expect(page.getByText("Internal server error")).toHaveCount(0);

    ({ trigger: inventoryActionsTrigger, panel: inventoryActions } = await openInventoryActions(page, sessionName));
    await inventoryActions.getByRole("button", { name: /^Import history\b/ }).click();
    const persistedHistoryDialog = page.getByRole("dialog", { name: "Import history", exact: true });
    await expect(persistedHistoryDialog).toBeVisible();
    const persistedHistory = persistedHistoryDialog.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(persistedHistory).not.toContainText("application/pdf");
    await expect(persistedHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(persistedHistory.getByRole("link", { name: /Open source|Source/i })).toHaveCount(0);
    await expect(persistedHistory.locator('a[href*="/packet-imports/"]')).toHaveCount(0);
    await expect(persistedHistoryDialog.getByRole("button", { name: "Review again" })).toHaveCount(0);
    expect(packetMediaRequests, "normal item and provenance use must never navigate to raw packet media").toHaveLength(0);
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "06-persisted-session-history");
    await persistedHistoryDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(persistedHistoryDialog).toBeHidden();
    await expect(inventoryActionsTrigger).toBeFocused();
    } finally {
      if (cleanupSessionId) {
        await request.patch(`${API_URL}/inventory/sessions/${cleanupSessionId}`, {
          headers: QA_HEADERS,
          data: { status: "closed" }
        });
      }
    }
  });
});
