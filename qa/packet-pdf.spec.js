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
  const moreActions = page.getByRole("button", { name: "More actions", exact: true });
  if (await moreActions.isVisible()) await moreActions.click();
  const uploadPacket = page.getByRole("button", { name: "Upload packet" });
  await expect(uploadPacket).toBeVisible();
  await uploadPacket.click();
}

test.describe("PDF packet import", () => {
  test("uses an open session when the session list finishes loading after the wizard opens", async ({ page }) => {
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
    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => blockedSessionListRequests).toBeGreaterThan(0);
    sessionListReleased = true;
    releaseSessionList();

    await expect(dialog.getByText("Use an open session")).toBeVisible();
    const continueButton = dialog.getByRole("button", { name: "Continue" });
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();
    await expect(page.getByText("Name the inventory session first.")).toHaveCount(0);
  });

  test("platoon admin can upload an Army-style PDF and review parsed rows", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await openPacketUpload(page);

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    const parserSummary = dialog.getByLabel("Packet parser summary");
    await expect(parserSummary.getByText("PDF", { exact: true })).toBeVisible();
    await expect(parserSummary.getByText("army-packet-clean.pdf")).toBeVisible();
    await expect(parserSummary.getByText("Rows ready")).toBeVisible();
    await expect(parserSummary.getByText("Ignored")).toBeVisible();
    await expect(dialog.getByText("Ignored text")).toBeVisible();
    await expect(dialog.getByText(/27 ready to import/)).toBeVisible();
    await expect(dialog.getByText(/27 rows found/)).toBeVisible();
    await expect(dialog.locator(".packet-confidence.low")).toHaveCount(0);
    await expect(dialog.locator("textarea").first()).toHaveValue(/COMBAT LIFESAVER|RADIAC SET|ARMAMENT SUBSYS/);
    await expect(dialog.getByRole("button", { name: "Import 27 rows" })).toBeVisible();
  });

  test("rejects unsupported packet files before parsing", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await openPacketUpload(page);
    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue" }).click();
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
});
