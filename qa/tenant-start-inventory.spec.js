import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

test.describe("tenant start inventory wizard", () => {
  test("platoon admin can create a blank inventory session from the dashboard", async ({ page }) => {
    const sessionName = `QA start ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "Start new inventory" }).click();

    const dialog = page.getByRole("dialog", { name: "Start inventory" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Upload packet now")).toBeVisible();
    await dialog.getByLabel("Session name").fill(sessionName);
    await dialog.getByText("Create blank session").click();
    await dialog.getByRole("button", { name: "Start session" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`${sessionName}.*0 rows`) }).first()).toBeVisible();
  });

  test("platoon admin can start a session and continue to packet upload", async ({ page }) => {
    const sessionName = `QA packet ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await page.getByRole("button", { name: "Start new inventory" }).click();

    const startDialog = page.getByRole("dialog", { name: "Start inventory" });
    await expect(startDialog).toBeVisible();
    await startDialog.getByLabel("Session name").fill(sessionName);
    await startDialog.getByRole("button", { name: "Start session" }).click();

    await expect(startDialog).toBeHidden();
    const packetDialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(packetDialog).toBeVisible();
    await expect(packetDialog.locator("option", { hasText: sessionName })).toHaveCount(1);
    await expect(packetDialog.getByRole("button", { name: "Continue" })).toBeVisible();
  });
});
