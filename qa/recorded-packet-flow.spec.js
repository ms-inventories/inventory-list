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

async function openSessionsFromNotifications(page) {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
}

async function createBlankInventory(page, name) {
  const inventoryCreate = page.locator("details.session-create");
  if (!(await inventoryCreate.evaluate(element => element.open))) {
    await inventoryCreate.locator("summary").click();
  }
  await inventoryCreate.getByLabel("Inventory name").fill(name);
  await inventoryCreate.getByRole("button", { name: "Start inventory", exact: true }).click();
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

    await openSessionsFromNotifications(page);
    await createBlankInventory(page, sessionName);
    const sessionResponse = await request.get(`${API_URL}/inventory/sessions`, { headers: QA_HEADERS });
    if (!sessionResponse.ok()) throw new Error(await sessionResponse.text());
    const sessionPayload = await sessionResponse.json();
    cleanupSessionId = sessionPayload.sessions?.find(session => session.name === sessionName)?.id || "";
    expect(cleanupSessionId).toBeTruthy();

    await page.getByRole("region", { name: "Inventory workspace" })
      .getByRole("button", { name: "Add items from packet", exact: true })
      .click();
    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.locator("option", { hasText: sessionName })).toHaveCount(1);
    await packetDialog.getByRole("button", { name: "Choose source" }).click();
    await expect(packetDialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

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
    const selectedSessionSummary = page.locator(".session-summary", { hasText: sessionName });
    await expect(selectedSessionSummary).toBeVisible();
    await expect(selectedSessionSummary).toContainText("27 items");
    const importedRow = page.locator(".session-item", { hasText: "Vault 2, rack 4" });
    await expect(importedRow).toHaveCount(1);
    const inventoryTools = await openInventoryTools(page);
    const importHistoryDisclosure = inventoryTools.locator("details.packet-import-history");
    await expect(importHistoryDisclosure).toBeVisible();
    await importHistoryDisclosure.locator("summary").click();
    const importHistory = page.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(importHistory).toBeVisible();
    await expect(importHistory).not.toContainText("application/pdf");
    await expect(importHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(importHistory.getByRole("link", { name: /Open source|Source/i })).toHaveCount(0);
    await expect(importHistory.locator('a[href*="/packet-imports/"]')).toHaveCount(0);
    await importHistory.getByRole("button", { name: "Review again" }).click();
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
    await expect(packetDialog.getByText("army-packet-clean.pdf")).toBeVisible();
    await packetDialog.getByRole("button", { name: "Close packet wizard" }).click();
    await expect(packetDialog).toBeHidden();
    await captureStep(page, testInfo, "04-session-with-source-history");

    await inventoryTools.getByRole("button", { name: "Close inventory", exact: true }).click();
    const closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close inventory" }).click();
    await expect(closeDialog).toBeHidden();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.locator(".session-list > .session-group .session-row", { hasText: sessionName })).toHaveCount(0);

    await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "05-dashboard-after-closeout");

    await openSessionsFromNotifications(page);
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    const archive = page.locator(".session-archive");
    await archive.locator("summary").click();
    const archivedSession = archive.locator(".session-row", { hasText: sessionName });
    await expect(archivedSession).toBeVisible();
    await archivedSession.click();

    const closedInventoryTools = await openInventoryTools(page);
    const persistedHistoryDisclosure = closedInventoryTools.locator("details.packet-import-history");
    await expect(persistedHistoryDisclosure).toBeVisible();
    await persistedHistoryDisclosure.locator("summary").click();
    const persistedHistory = page.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(persistedHistory).not.toContainText("application/pdf");
    await expect(persistedHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(persistedHistory.getByRole("link", { name: /Open source|Source/i })).toHaveCount(0);
    await expect(persistedHistory.locator('a[href*="/packet-imports/"]')).toHaveCount(0);
    expect(packetMediaRequests, "normal item and provenance use must never navigate to raw packet media").toHaveLength(0);
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "06-closed-session-history");
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
