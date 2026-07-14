import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInAsPlatoonAdmin(page) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openSessions(page) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await page.getByRole("button", { name: "Inventory Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
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
  await page.locator(".session-create-form").getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.locator(".session-row", { hasText: name })).toHaveCount(1);
}

test.describe("session lifecycle", () => {
  test("reuses duplicate empty sessions and can delete the draft", async ({ page }, testInfo) => {
    const sessionName = `QA duplicate ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);

    await createEmptySession(page, sessionName);
    await createEmptySession(page, sessionName);

    await expect(page.locator(".session-row", { hasText: sessionName })).toHaveCount(1);
    await expect(page.getByText(/already an empty session/i)).toBeVisible();

    await page.getByRole("button", { name: "Delete draft" }).click();
    await expect(page.getByRole("dialog", { name: "Delete draft session?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete session" }).click();

    await expect(page.locator(".session-row", { hasText: sessionName })).toHaveCount(0);
    await expect(page.getByText(`Deleted empty session ${sessionName}.`)).toBeVisible();
  });

  test("requires confirmation before closing a session with packet rows", async ({ page }, testInfo) => {
    const sessionName = `QA closeout ${testInfo.project.name} ${Date.now()}`;
    const packetLin = `${testInfo.project.name.startsWith("mobile") ? "M" : "C"}${String(Date.now() % 100000).padStart(5, "0")}`;

    await page.goto(TENANT_URL);
    await signInAsPlatoonAdmin(page);
    await openSessions(page);
    await createEmptySession(page, sessionName);

    await page.locator(".packet-wizard-entry").getByRole("button", { name: "Upload packet" }).click();
    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Choose source" }).click();
    await dialog.locator("textarea").fill(`000009148 ${packetLin} QA CLOSEOUT TEST ITEM`);
    await dialog.getByRole("button", { name: "Review rows" }).click();
    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
    await dialog.getByRole("button", { name: /Import 1 rows?/ }).click();
    await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
    await dialog.getByRole("button", { name: "Open session" }).click();

    await page.getByRole("button", { name: "Close out" }).click();
    await expect(page.getByRole("dialog", { name: "Close this session?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog", { name: "Close this session?" })).toHaveCount(0);

    await page.getByRole("button", { name: "Close out" }).click();
    await page.getByRole("button", { name: "Close session" }).click();

    await expect(page.getByRole("dialog", { name: "Close this session?" })).toHaveCount(0);
    await page.locator(".session-archive summary").click();
    await expect(page.locator(".session-archive .session-row", { hasText: sessionName })).toBeVisible();
  });

  test("clears a stale session load error after refresh", async ({ page }) => {
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
    await page.getByRole("button", { name: "Refresh sessions" }).click();
    await expect(page.getByText("Internal server error")).toBeVisible();
    await page.getByRole("button", { name: "Refresh sessions" }).click();
    await expect(page.getByText("Internal server error")).toHaveCount(0);
  });
});
