import path from "node:path";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const PACKET_FIXTURE = path.resolve("output/pdf/army-packet-clean.pdf");

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

test.describe("PDF packet import", () => {
  test("platoon admin can upload an Army-style PDF and review parsed rows", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await page.getByRole("button", { name: "Upload packet" }).click();

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose file PDF, CSV, text, or image up to 10MB" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PACKET_FIXTURE);

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible({ timeout: 45_000 });
    await expect(dialog.getByText(/27 ready to import/)).toBeVisible();
    await expect(dialog.getByText(/27 rows found/)).toBeVisible();
    await expect(dialog.locator(".packet-confidence.low")).toHaveCount(0);
    await expect(dialog.locator("textarea").first()).toHaveValue(/COMBAT LIFESAVER|RADIAC SET|ARMAMENT SUBSYS/);
    await expect(dialog.getByRole("button", { name: "Import 27 rows" })).toBeVisible();
  });
});
