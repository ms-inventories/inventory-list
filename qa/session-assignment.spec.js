import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

const qaNcoIdentity = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function seedQaSession(page, identity) {
  await page.goto(TENANT_URL);
  await page.evaluate(qaIdentity => {
    sessionStorage.clear();
    localStorage.setItem("inventory.qa.identity", JSON.stringify(qaIdentity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
  await page.goto("about:blank");
}

async function openSessions(page) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await page.getByRole("button", { name: "Inventory Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
}

async function createSession(page, name) {
  const sessionCreate = page.locator(".session-create").first();
  const sessionSummary = sessionCreate.locator("summary");
  const sessionName = sessionCreate.locator("#sessionName");
  if (!(await sessionName.isVisible())) {
    await sessionSummary.scrollIntoViewIfNeeded();
    await sessionSummary.click({ force: true });
    await expect(sessionCreate).toHaveJSProperty("open", true);
  }
  await sessionName.scrollIntoViewIfNeeded();
  await expect(sessionName).toBeVisible();
  await sessionName.fill(name);
  await page.locator(".session-create-form").getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator(".session-row", { hasText: name })).toHaveCount(1);
}

async function addPacketRows(page) {
  await page.locator(".packet-wizard-entry").getByRole("button", { name: "Upload packet" }).click();
  const dialog = page.getByRole("dialog", { name: "Upload packet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.locator("textarea").fill([
    "000002115 W34648 TOOL KIT CARPENTERS: ENGINEER SQUAD",
    "0000186033 M05000 TAMPER,VIBRATING TYPE,INTERNAL COMBUST"
  ].join("\n"));
  await dialog.getByRole("button", { name: "Review rows" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
  await dialog.getByRole("button", { name: /Import 2 rows?/ }).click();
  await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
  await dialog.getByRole("button", { name: "Open session" }).click();
}

test.describe("session assignment", () => {
  test("platoon admins can assign rows and contributors can filter their work", async ({ page }, testInfo) => {
    const sessionName = `QA assignment ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openSessions(page);
    await createSession(page, sessionName);
    await addPacketRows(page);

    const toolKitRow = page.locator(".session-item", { hasText: "Tool Kit" }).first();
    if (testInfo.project.name === "mobile-chrome") {
      await expect(toolKitRow.locator(".session-assignment-control")).toBeHidden();
      await expect(toolKitRow.getByRole("button", { name: "Found", exact: true })).toBeHidden();
      await expect(toolKitRow.getByRole("button", { name: "Not found", exact: true })).toBeHidden();
      await expect(toolKitRow.getByRole("button", { name: /Proof/ })).toBeVisible();
      await toolKitRow.getByRole("button", { name: /Open details for/ }).click();
      const drawer = page.getByRole("dialog");
      await drawer.locator("footer").getByRole("combobox").selectOption({ label: "QA NCO" });
      await expect(drawer.getByRole("status")).toContainText("Row assigned.");
      await drawer.getByRole("button", { name: "Close item details" }).click();
    } else {
      await expect(toolKitRow.locator(".session-assignment-control select")).toBeVisible();
      await expect(toolKitRow.getByRole("button", { name: "Found", exact: true })).toBeVisible();
      await toolKitRow.locator(".session-assignment-control select").selectOption({ label: "QA NCO" });
    }
    await expect(toolKitRow.getByText("Assigned to QA NCO")).toBeVisible();

    await seedQaSession(page, qaNcoIdentity);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await openSessions(page);
    await page.locator(".session-row", { hasText: sessionName }).click();
    await page.getByRole("button", { name: /My work/ }).click();

    await expect(page.getByText("Assigned to QA NCO")).toBeVisible();
    await expect(page.getByText("TOOL KIT CARPENTERS")).toBeVisible();
    await page.getByRole("button", { name: /Available/ }).click();
    const generatorRow = page.locator(".session-item", { hasText: "TAMPER,VIBRATING" }).first();
    if (testInfo.project.name === "mobile-chrome") {
      await expect(generatorRow.getByRole("button", { name: "Claim item" })).toBeHidden();
      await generatorRow.getByRole("button", { name: /Open details for/ }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Claim item" }).click();
      await expect(drawer.getByRole("status")).toContainText("Item claimed.");
      await drawer.getByRole("button", { name: "Close item details" }).click();
    } else {
      await expect(generatorRow.getByRole("button", { name: "Claim item" })).toBeVisible();
      await generatorRow.getByRole("button", { name: "Claim item" }).click();
    }
    await expect(generatorRow.getByText("Assigned to QA NCO")).toBeVisible();
    await page.getByRole("button", { name: /My work/ }).click();
    await expect(page.locator(".session-item", { hasText: "TAMPER,VIBRATING" })).toBeVisible();
  });
});
