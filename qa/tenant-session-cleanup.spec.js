import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

async function createBlankSessionFromDashboard(page, sessionName) {
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Start new inventory" }).click();

  const dialog = page.getByRole("dialog", { name: "Start inventory" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session name").fill(sessionName);
  await dialog.getByText("Create blank session").click();
  await dialog.getByRole("button", { name: "Start session" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
}

test.describe("tenant session cleanup", () => {
  test("platoon admin can delete an abandoned empty session without stale errors", async ({ page }) => {
    const sessionName = `QA cleanup ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await createBlankSessionFromDashboard(page, sessionName);

    await expect(page.getByRole("button", { name: new RegExp(`${sessionName}.*0 rows`) }).first()).toBeVisible();
    await page.getByRole("button", { name: "Delete draft" }).click();

    const deleteDialog = page.getByRole("dialog", { name: "Delete draft session?" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete session" }).click();
    await expect(deleteDialog).toBeHidden();

    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(sessionName) })).toHaveCount(0);
  });
});
