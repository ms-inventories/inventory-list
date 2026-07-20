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

async function selectDashboardInventory(page, session) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
  const singleInventoryHeading = activeInventory.getByRole("heading", { name: session.name, exact: true });
  await expect.poll(async () => {
    if (await selector.count()) return selector.locator(`option[value="${session.id}"]`).count();
    return (await singleInventoryHeading.count()) ? 1 : 0;
  }).toBe(1);
  if (await selector.count()) {
    await selector.selectOption(session.id);
    await expect(selector).toHaveValue(session.id);
  } else {
    await expect(singleInventoryHeading).toBeVisible();
  }
  return activeInventory;
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

      await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
      const inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
      await expect(inventoryWorkspace).toBeVisible();
      await expect(page.getByRole("region", { name: "Active inventory" })).toContainText(session.name);
      await expect.poll(() => inventoryWorkspace.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
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

      let itemRow = page.locator(".session-item", { hasText: packetLine });
      await expect(itemRow).toBeVisible();
      await expect(itemRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
      await itemRow.getByRole("button", { name: "Claim item" }).click();
      await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item claimed. It is now in Mine.");
      await expect(page.getByRole("dialog"), "claiming work must not open the item or proof form").toHaveCount(0);

      itemRow = page.locator(".session-item", { hasText: packetLine });
      await expect(itemRow.getByRole("button", { name: "Add proof", exact: true })).toBeVisible();
      await itemRow.getByRole("button", { name: "Add proof", exact: true }).click();
      const proofDialog = page.getByRole("dialog", { name: `Add proof for ${packetLine}` });
      const proofForm = proofDialog.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      await proofForm.getByRole("combobox", { name: "Inventory result" }).selectOption("not_found");
      await proofForm.getByRole("textbox", { name: "Location" }).fill("Temporary crew QA location");
      await proofForm.getByRole("textbox", { name: "Note" }).fill("Checked the assigned area; the item was not present.");
      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
      await expect(proofDialog).toBeHidden();

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

  test("leader generates and revokes a code in the selected inventory", async ({ page, request }, testInfo) => {
    if (testInfo.project.name === "mobile-chrome") await page.setViewportSize({ width: 360, height: 640 });
    const session = await createActiveSession(request, `Crew dialog ${testInfo.project.name} ${Date.now()}`);
    await seedAdminBrowserSession(page);

    try {
      await page.goto(TENANT_URL);
      await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
      const activeInventory = await selectDashboardInventory(page, session);
      await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
      await activeInventory.getByRole("button", { name: "Invite crew" }).click();

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
