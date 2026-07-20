import path from "node:path";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const PACKET_FIXTURE = path.resolve("output/pdf/army-packet-clean.pdf");

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

async function openPacketUpload(page) {
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  const workspace = page.getByRole("region", { name: "Inventory workspace" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();

  const inventoryActionsTrigger = workspace.getByRole("button", { name: /^Inventory actions for / }).first();
  const inventoryActions = workspace.getByRole("group", { name: /^Manage inventory / }).first();
  const dialog = page.getByRole("dialog", { name: "Upload packet" });

  await expect.poll(async () => {
    if (await dialog.isVisible()) return true;

    try {
      if (await inventoryActionsTrigger.isVisible()) {
        if ((await inventoryActionsTrigger.getAttribute("aria-expanded")) !== "true") {
          await inventoryActionsTrigger.click({ timeout: 1_000 });
        }
        const addPacket = inventoryActions.getByRole("button", { name: "Add packet", exact: true });
        if (await addPacket.isVisible()) await addPacket.click({ timeout: 1_000 });
      }
    } catch {
      // The selected inventory may finish loading between checks.
    }

    return dialog.isVisible();
  }, { timeout: 15_000, intervals: [100, 200, 500] }).toBe(true);
  await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
  await expect(dialog.getByText("Inventory", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Choose source" })).toHaveCount(0);
  return dialog;
}

test.describe("PDF packet import", () => {
  test("defaults to the active inventory when the inventory list finishes loading", async ({ page }) => {
    let releaseSessionList;
    const sessionListGate = new Promise(resolve => {
      releaseSessionList = resolve;
    });
    let sessionListReleased = false;
    let blockedSessionListRequests = 0;

    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      const isSessionList = /\/api\/inventory\/sessions\/?$/.test(url.pathname);
      if (!sessionListReleased && isSessionList && route.request().method() === "GET") {
        blockedSessionListRequests += 1;
        await sessionListGate;
      }
      await route.continue();
    });

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await expect.poll(() => blockedSessionListRequests).toBeGreaterThan(0);
    await expect(page.getByRole("region", { name: "Active inventory" })).toContainText("Loading inventory...");
    sessionListReleased = true;
    releaseSessionList();

    const dialog = await openPacketUpload(page);
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(page.getByText("Name the inventory first.")).toHaveCount(0);
  });

  test("keeps packet source usable when the background inventory refresh loses its connection", async ({ page }) => {
    test.setTimeout(60_000);
    let abortedDetailRequests = 0;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    const dialog = await openPacketUpload(page);

    await page.route("**/api/inventory/sessions/*", async route => {
      const url = new URL(route.request().url());
      const isSessionDetail = /^\/api\/inventory\/sessions\/[0-9a-f-]{36}\/?$/.test(url.pathname);
      if (isSessionDetail && route.request().method() === "GET") {
        abortedDetailRequests += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.locator(".leader-topbar-refresh").evaluate(button => button.click());
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect.poll(() => abortedDetailRequests).toBeGreaterThan(0);
    await expect(dialog.getByText("Could not reach the inventory API.", { exact: false })).toHaveCount(0);

    const chooseFileButton = dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" });
    await expect(chooseFileButton).toBeEnabled();
    const fileChooserPromise = page.waitForEvent("filechooser");
    await chooseFileButton.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    await expect(dialog.getByText(/27 ready to import/)).toBeVisible();
  });

  test("platoon admin can upload an Army-style PDF and review parsed items", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    const parserSummary = dialog.getByLabel("Packet parser summary");
    await expect(parserSummary.getByText("PDF", { exact: true })).toBeVisible();
    await expect(parserSummary.getByText("army-packet-clean.pdf")).toBeVisible();
    await expect(parserSummary.getByText("Items ready")).toBeVisible();
    await expect(parserSummary.getByText("Skipped page text")).toBeVisible();
    await expect(dialog.getByText("Ignored text")).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText(/items? ready.*headers or page text were skipped/i);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByText(/27 ready to import/)).toBeVisible();
    await expect(dialog.getByText(/27 items found/)).toBeVisible();
    await expect(dialog.locator(".packet-confidence.low")).toHaveCount(0);
    const confidence = dialog.locator(".packet-confidence").first();
    await expect(confidence).toHaveAttribute("aria-label", /import confidence.*show explanation/i);
    await confidence.click();
    await expect(confidence.locator("xpath=..").getByRole("note")).toContainText(/confidence.*recognized the packet text/i);
    await expect(dialog.locator(".packet-row-number").first()).toHaveText("1");
    await expect(dialog.locator("textarea").first()).toHaveValue(/COMBAT LIFESAVER|RADIAC SET|ARMAMENT SUBSYS/);
    await expect(dialog.getByRole("button", { name: "Import 27 items" })).toBeVisible();
  });

  test("explains a PDF reader asset failure without blaming the inventory API", async ({ page }) => {
    test.setTimeout(60_000);
    let blockedWorkerRequests = 0;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await page.route("**/*pdf.worker*", async route => {
      const url = new URL(route.request().url());
      if (/pdf\.worker(?:\.min)?[^/]*\.(?:mjs|js)$/i.test(url.pathname)) {
        blockedWorkerRequests += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    const fileChooserPromise = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect.poll(() => blockedWorkerRequests).toBeGreaterThan(0);
    await expect(dialog.getByRole("alert")).toContainText("The PDF reader could not start.");
    await expect(dialog.getByRole("alert")).not.toContainText("inventory API");
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" })).toBeEnabled();
  });

  test("rejects unsupported packet files before parsing", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await openPacketUpload(page);
    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "unsupported.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("not a packet")
    });

    await expect(page.getByText("Choose a PDF, CSV, text file, or JPEG/PNG/WebP/GIF image.")).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toHaveCount(0);
  });

  test("packet import locks conflicting actions and retries without duplicate requests", async ({ page }) => {
    test.setTimeout(60_000);
    let importAttempts = 0;
    await page.route("**/api/inventory/sessions/*/items/bulk", async route => {
      if (route.request().method() !== "POST") return route.continue();
      importAttempts += 1;
      if (importAttempts === 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary packet import failure" })
        });
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          sessionItems: [{ id: "ea1f9ddf-8703-46df-ab2b-a24112589fa0" }],
          possibleMatchCount: 0
        })
      });
    });

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    const sourceText = dialog.getByPlaceholder(/Paste hand-receipt text/);
    await sourceText.fill("000009148 R20684 RADIAC SET: AN/VDR-2");
    await dialog.getByRole("button", { name: "Review items" }).click();

    const importButton = dialog.getByRole("button", { name: "Import 1 item" });
    await importButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => importAttempts).toBe(1);
    await expect(dialog.getByRole("button", { name: "Importing..." })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close packet wizard" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Back" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Clear" })).toBeDisabled();
    await expect(dialog.locator(".packet-review-line").first()).toBeDisabled();

    await expect(dialog.getByRole("alert")).toContainText("Temporary packet import failure");
    expect(importAttempts).toBe(1);

    await dialog.getByRole("button", { name: "Import 1 item" }).click();
    await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
    expect(importAttempts).toBe(2);
  });

  test("keeps reviewed packet items when a successful response does not confirm every save", async ({ page }) => {
    test.setTimeout(60_000);
    let importAttempts = 0;
    await page.route("**/api/inventory/sessions/*/items/bulk", async route => {
      if (route.request().method() !== "POST") return route.continue();
      importAttempts += 1;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ sessionItems: [], possibleMatchCount: 0 })
      });
    });

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    const sourceText = dialog.getByPlaceholder(/Paste hand-receipt text/);
    await sourceText.fill("000009148 R20684 RADIAC SET: AN/VDR-2");
    await dialog.getByRole("button", { name: "Review items" }).click();

    const packetRow = dialog.locator(".packet-review-line").first();
    const locationHint = dialog.locator(".packet-review-row").first().getByLabel("Location hint");
    await locationHint.fill("Vault 2, rack 4");
    await dialog.getByRole("button", { name: "Import 1 item" }).click();

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("couldn't confirm that any items were saved");
    await expect(dialog.getByText("Pasted packet text", { exact: true })).toBeVisible();
    await expect(packetRow).toHaveValue(/R20684 RADIAC SET/);
    await expect(locationHint).toHaveValue("Vault 2, rack 4");
    await expect(dialog.getByText("army-packet-clean.pdf")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Import 1 item" })).toBeEnabled();
    expect(importAttempts).toBe(1);
  });
});
