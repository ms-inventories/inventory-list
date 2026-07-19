import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const JOIN_URL = process.env.QA_CREW_JOIN_URL || "http://ms.localhost:5175/#/join";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

function qaHeaders(identity = qaAdmin) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": "ms"
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function createActiveSession(request, name) {
  const data = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(),
    data: { name, status: "active" }
  }));
  return data.session;
}

async function createCrewCode(request, sessionId, displayName) {
  return responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionId}/crew-access`, {
    headers: qaHeaders(),
    data: { displayName }
  }));
}

async function closeSession(request, sessionId) {
  await request.patch(`${API_URL}/inventory/sessions/${sessionId}`, {
    headers: qaHeaders(),
    data: { status: "closed" }
  });
}

async function seedAdminBrowserSession(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaAdmin);
}

test.describe("temporary crew access", () => {
  test("one-time code opens only its inventory and logout returns to join", async ({ page, request }, testInfo) => {
    if (testInfo.project.name === "mobile-chrome") await page.setViewportSize({ width: 320, height: 640 });
    const session = await createActiveSession(request, `Crew join ${testInfo.project.name} ${Date.now()}`);
    const packetLine = `CREW-TASK-${testInfo.project.name}-${Date.now()}`;
    await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.id}/items`, {
      headers: qaHeaders(),
      data: { packetLine }
    }));
    const displayName = `Helper ${testInfo.project.name}`;
    const created = await createCrewCode(request, session.id, displayName);
    const privateJoinUrl = `${JOIN_URL}?invite=${encodeURIComponent(created.inviteToken)}`;

    try {
      expect(created.code).toMatch(/^\d{4}$/);
      expect(created.inviteToken).toMatch(/^[A-Za-z0-9_-]{24,160}$/);
      await page.goto(JOIN_URL);
      await expect(page.getByRole("status")).toContainText("private inventory link");
      await expect(page.getByLabel("4-digit code")).toBeDisabled();
      await page.goto(privateJoinUrl);
      await expect(page.getByRole("heading", { name: "Join inventory" })).toBeVisible();
      const codeInput = page.getByLabel("4-digit code");
      await expect(codeInput).toHaveAttribute("inputmode", "numeric");
      await expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
      const codeInputBox = await codeInput.boundingBox();
      expect(codeInputBox.width).toBeLessThanOrEqual(page.viewportSize().width);
      expect(codeInputBox.height).toBeGreaterThanOrEqual(48);
      await codeInput.fill(created.code);
      await page.getByRole("button", { name: "Join inventory" }).click();

      await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      await expect(activeInventory).toContainText(session.name);
      await expect.poll(() => activeInventory.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      if (testInfo.project.name === "mobile-chrome") {
        const sessionHeading = await activeInventory.getByRole("heading", { name: session.name }).boundingBox();
        const openSession = await activeInventory.getByRole("button", { name: "Open session" }).boundingBox();
        expect(openSession.y).toBeGreaterThanOrEqual(sessionHeading.y + sessionHeading.height);
      }
      const workspaceMenu = page.getByRole("button", { name: "Open workspace menu" });
      const mobileNavigation = await workspaceMenu.isVisible();
      if (mobileNavigation) await workspaceMenu.click();
      await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Inventory", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Review Queue", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Team", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Workspace Settings", exact: true })).toHaveCount(0);
      if (mobileNavigation) {
        await page.locator(".leader-brand").getByRole("button", { name: "Close menu" }).click();
      }

      await activeInventory.getByRole("button", { name: "Open session" }).click();
      const itemRow = page.locator(".session-item", { hasText: packetLine });
      await expect(itemRow).toBeVisible();
      await itemRow.getByRole("button", { name: "Claim item" }).click();
      const proofDrawer = page.getByRole("dialog", { name: packetLine });
      await expect(proofDrawer.getByRole("status")).toContainText("Item claimed.");
      const proofForm = proofDrawer.locator(".proof-form");
      await proofForm.getByRole("combobox", { name: "Inventory result" }).selectOption("not_found");
      await proofForm.getByRole("textbox", { name: "Location" }).fill("Temporary crew QA location");
      await proofForm.getByRole("textbox", { name: "Note" }).fill("Checked the assigned area; the item was not present.");
      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
      await expect(proofDrawer).toBeHidden();

      await page.getByRole("button", { name: "Open user menu" }).click();
      const userMenu = page.getByRole("region", { name: "User menu" });
      await expect(userMenu).toContainText(displayName);
      await expect(userMenu).toContainText("Crew member");
      await userMenu.getByRole("button", { name: "Leave inventory" }).click();

      await expect(page.getByRole("heading", { name: "Join inventory" })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("You left the inventory");
      await page.goto(privateJoinUrl);
      await page.getByLabel("4-digit code").fill(created.code);
      await page.getByRole("button", { name: "Join inventory" }).click();
      await expect(page.getByRole("status")).toContainText("invalid or no longer available");
    } finally {
      await closeSession(request, session.id);
    }
  });

  test("leader generates and revokes a code in the selected session", async ({ page, request }, testInfo) => {
    if (testInfo.project.name === "mobile-chrome") await page.setViewportSize({ width: 360, height: 640 });
    const session = await createActiveSession(request, `Crew dialog ${testInfo.project.name} ${Date.now()}`);
    await seedAdminBrowserSession(page);

    try {
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      const activeInventorySelector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      if (await activeInventorySelector.isVisible()) await activeInventorySelector.selectOption(session.id);
      await activeInventory.getByRole("button", { name: "Open session" }).click();
      await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
      await page.locator(".session-row", { hasText: session.name }).click();
      const summary = page.locator(".session-summary").filter({ hasText: session.name });
      await summary.getByRole("button", { name: "Invite crew" }).click();

      const dialog = page.getByRole("dialog", { name: "Invite crew" });
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
      expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
      await dialog.getByLabel("Helper name").fill("SPC Test Helper");
      await dialog.getByRole("button", { name: "Generate code" }).click();
      const code = (await dialog.locator("output.crew-code").textContent()).trim();
      expect(code).toMatch(/^\d{4}$/);
      expect(page.url()).not.toContain(code);
      await expect(dialog.getByText("Private link + PIN work once", { exact: false })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Copy invite" })).toBeVisible();

      await dialog.getByRole("button", { name: "Invite another" }).click();
      const crewRow = dialog.locator(".crew-access-row", { hasText: "SPC Test Helper" });
      await expect(crewRow).toContainText("Waiting");
      await crewRow.getByRole("button", { name: "Remove access" }).click();
      await expect(crewRow).toContainText("Removed");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();
    } finally {
      await closeSession(request, session.id);
    }
  });
});
