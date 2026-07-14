import path from "node:path";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const PACKET_FIXTURE = path.resolve("output/pdf/army-packet-clean.pdf");

async function signInAsPlatoonAdmin(page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openWorkspaceView(page, name, heading = name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function captureStep(page, testInfo, name) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

test.describe("recorded packet and session regression", () => {
  test("packet source survives import, closeout, and workspace navigation", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const sessionName = `QA recorded flow ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await captureStep(page, testInfo, "01-dashboard");

    await page.getByRole("button", { name: "Start new inventory" }).click();
    const startDialog = page.getByRole("dialog", { name: "Start inventory" });
    await expect(startDialog).toBeVisible();
    await startDialog.getByLabel("Session name").fill(sessionName);
    await startDialog.getByRole("button", { name: "Start session" }).click();

    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.locator("option", { hasText: sessionName })).toHaveCount(1);
    await packetDialog.getByRole("button", { name: "Continue" }).click();
    await expect(packetDialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await packetDialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(packetDialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    await expect(packetDialog.getByText("army-packet-clean.pdf")).toBeVisible();
    await expect(packetDialog.getByText(/27 ready to import/)).toBeVisible();
    await captureStep(page, testInfo, "02-packet-review");

    await packetDialog.getByRole("button", { name: "Import 27 rows" }).click();
    await expect(packetDialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
    await captureStep(page, testInfo, "03-import-complete");
    await packetDialog.getByRole("button", { name: "Open session" }).click();

    await expect(packetDialog).toBeHidden();
    await expect(page.locator(".session-summary", { hasText: sessionName })).toBeVisible();
    const importHistory = page.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(importHistory).toBeVisible();
    await expect(importHistory).toContainText("application/pdf");
    await expect(importHistory).toContainText(/\d+ KB/);
    await expect(importHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(importHistory.getByRole("link", { name: "Source" })).toBeVisible();
    await captureStep(page, testInfo, "04-session-with-source-history");

    await page.getByRole("button", { name: "Close out" }).click();
    const closeDialog = page.getByRole("dialog", { name: "Close this session?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close session" }).click();
    await expect(closeDialog).toBeHidden();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.locator(".session-list > .session-group .session-row", { hasText: sessionName })).toHaveCount(0);

    await openWorkspaceView(page, "Dashboard", "Leader Dashboard");
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "05-dashboard-after-closeout");

    await openWorkspaceView(page, "Inventory Sessions", "Sessions");
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    const archive = page.locator(".session-archive");
    await archive.locator("summary").click();
    const archivedSession = archive.locator(".session-row", { hasText: sessionName });
    await expect(archivedSession).toBeVisible();
    await archivedSession.click();

    const persistedHistory = page.locator(".packet-import-history-row", { hasText: "army-packet-clean.pdf" }).first();
    await expect(persistedHistory).toContainText("application/pdf");
    await expect(persistedHistory).toContainText(/\d+ KB/);
    await expect(persistedHistory).toContainText("uploaded by QA Platoon Admin");
    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await captureStep(page, testInfo, "06-closed-session-history");
  });
});
