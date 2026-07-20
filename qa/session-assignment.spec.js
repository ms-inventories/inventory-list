import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaAdminIdentity = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

const qaNcoIdentity = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

function qaHeaders(identity) {
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
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
}

async function createSession(page, name) {
  const sessionCreate = page.locator(".session-create").first();
  const sessionName = sessionCreate.locator("#sessionName");
  if (!(await sessionName.isVisible())) {
    await sessionCreate.evaluate(element => {
      element.open = true;
    });
  }
  await sessionName.scrollIntoViewIfNeeded();
  await expect(sessionName).toBeVisible();
  await sessionName.fill(name);
  await page.locator(".session-create-form").getByRole("button", { name: "Start inventory", exact: true }).click();
  const inventoryRow = page.locator(".session-row", { hasText: name });
  await expect(inventoryRow).toHaveCount(1);
  await inventoryRow.click();
  await expect(page.locator(".session-summary", { hasText: name })).toBeVisible();
}

async function addPacketRows(page) {
  await page.getByRole("region", { name: "Inventory workspace" })
    .getByRole("button", { name: "Add items from packet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Upload packet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await dialog.locator("textarea").fill([
    "000002115 W34648 TOOL KIT CARPENTERS: ENGINEER SQUAD",
    "0000186033 M05000 TAMPER,VIBRATING TYPE,INTERNAL COMBUST"
  ].join("\n"));
  await dialog.getByRole("button", { name: "Review items" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
  await dialog.getByRole("button", { name: "Import 2 items" }).click();
  await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
  await dialog.getByRole("button", { name: /^(Open inventory|Review matches)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".session-item-drawer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
}

test.describe("session assignment", () => {
  test("platoon admins can assign items and contributors can filter their work", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const sessionName = `QA assignment ${testInfo.project.name} ${Date.now()}`;
    let cleanupSessionId = "";

    try {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openSessions(page);
    await createSession(page, sessionName);
    const createdSessions = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(qaAdminIdentity)
    }));
    cleanupSessionId = createdSessions.sessions.find(candidate => candidate.name === sessionName)?.id || "";
    expect(cleanupSessionId).toBeTruthy();
    await addPacketRows(page);

    let inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    let assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
    const toolKitRow = inventoryWorkspace.locator(".session-item", { hasText: "Tool Kit" }).first();
    await expect(toolKitRow.getByRole("button", { name: "Found", exact: true })).toHaveCount(0);
    await expect(toolKitRow.getByRole("button", { name: "Not found", exact: true })).toHaveCount(0);
    await expect(toolKitRow.getByRole("button", { name: "Claim item" })).toBeVisible();
    await expect(toolKitRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(page.getByRole("dialog"), "assignment controls should remain inline").toHaveCount(0);
    const leaderTools = toolKitRow.getByRole("region", { name: /Manage / });
    await expect(leaderTools.getByRole("heading", { name: "Leader controls" })).toBeVisible();
    await leaderTools.getByRole("combobox", { name: "Assign to" }).selectOption({ label: "QA NCO" });
    await expect(inventoryWorkspace.locator(".session-panel").getByRole("status")).toContainText("Item assigned.");
    await expect(toolKitRow.getByText("Assigned to QA NCO")).toBeVisible();

    await seedQaSession(page, qaNcoIdentity);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open inventory", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Open inventory", exact: true }).first().click();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
    await inventoryWorkspace.locator(".session-row", { hasText: sessionName }).click();
    await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();

    const assignedToolKitRow = inventoryWorkspace.locator(".session-item", { hasText: "Tool Kit" }).first();
    await expect(assignedToolKitRow).toBeVisible();
    await expect(assignedToolKitRow.getByText("Assigned to QA NCO", { exact: true })).toBeVisible();
    await assignmentLists.getByRole("button", { name: /^Unclaimed\b/ }).click();
    const generatorRow = inventoryWorkspace.locator(".session-item", { hasText: "TAMPER,VIBRATING" }).first();
    await expect(generatorRow.getByRole("button", { name: "Claim item" })).toBeVisible();
    await generatorRow.getByRole("button", { name: "Claim item" }).click();
    await expect(inventoryWorkspace.locator(".session-panel").getByRole("status")).toContainText("Item claimed. It is now in Mine.");
    await expect(page.getByRole("dialog"), "claiming must not open the item or proof form").toHaveCount(0);
    await expect(page.locator(".proof-form")).toHaveCount(0);
    await assignmentLists.getByRole("button", { name: /^Unclaimed\b/ }).click();
    await expect(inventoryWorkspace.getByText("No items available to claim", { exact: true })).toBeVisible();
    await inventoryWorkspace.getByRole("button", { name: "Show mine", exact: true }).click();
    await expect(inventoryWorkspace.getByText("No items available to claim", { exact: true })).toHaveCount(0);
    const mineGeneratorRow = inventoryWorkspace.locator(".session-item", { hasText: "TAMPER,VIBRATING" });
    await expect(mineGeneratorRow).toBeVisible();
    await expect(mineGeneratorRow.getByText("Assigned to QA NCO")).toBeVisible();
    await expect(mineGeneratorRow.locator(".proof-form")).toHaveCount(0);
    await mineGeneratorRow.getByRole("button", { name: "Add proof" }).click();
    const proofDialog = page.getByRole("dialog", { name: /Add proof for .*TAMPER,VIBRATING/ });
    await expect(proofDialog.locator(".proof-form")).toBeVisible();
    await expect(mineGeneratorRow.locator(".proof-form")).toHaveCount(0);
    await proofDialog.locator(".proof-form").getByRole("button", { name: "Cancel" }).click();
    await expect(proofDialog).toBeHidden();

    const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${cleanupSessionId}`, {
      headers: qaHeaders(qaAdminIdentity)
    }));
    const generator = detail.items.find(item => item.packetLine.includes("TAMPER,VIBRATING"));
    const toolKit = detail.items.find(item => item.packetLine.includes("TOOL KIT CARPENTERS"));
    expect(generator?.id).toBeTruthy();
    expect(toolKit?.id).toBeTruthy();
    await responseJson(await request.patch(`${API_URL}/session-items/${generator.id}/direct-check`, {
      headers: qaHeaders(qaAdminIdentity),
      data: { status: "found" }
    }));

    await page.reload();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    assignmentLists = inventoryWorkspace.getByRole("group", { name: "Work assignment lists" });
    await inventoryWorkspace.locator(".session-row", { hasText: sessionName }).click();
    const sessionResults = inventoryWorkspace.getByRole("region", { name: "Inventory items" });
    for (const name of [/^Mine\b/, /^Unclaimed\b/, /^Others\b/]) {
      await assignmentLists.getByRole("button", { name }).click();
      await expect(sessionResults.getByText(/TAMPER,VIBRATING/)).toHaveCount(0);
    }
    const completed = inventoryWorkspace.locator(".session-completed-items");
    await completed.locator("summary").click();
    await expect(completed.getByText(/TAMPER,VIBRATING/)).toBeVisible();
    await expect(completed.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(completed.locator(".session-completed-item", { hasText: "TAMPER,VIBRATING" })).toBeVisible();
    await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();
    const sessionSearch = page.getByRole("searchbox", { name: "Search inventory items" });
    await expect(sessionSearch).toBeVisible();
    await sessionSearch.fill("TAMPER,VIBRATING");
    await expect(page.getByText("No matching items", { exact: true })).toHaveCount(0);
    await expect(completed.getByText(/TAMPER,VIBRATING/)).toBeVisible();

    await responseJson(await request.patch(`${API_URL}/session-items/${toolKit.id}/direct-check`, {
      headers: qaHeaders(qaAdminIdentity),
      data: { status: "found" }
    }));
    await page.reload();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    inventoryWorkspace = page.getByRole("region", { name: "Inventory workspace" });
    await inventoryWorkspace.locator(".session-row", { hasText: sessionName }).click();
    await expect(inventoryWorkspace.locator(".session-completed-items")).toHaveAttribute("open", "");
    await expect(inventoryWorkspace.locator(".session-completed-items").getByText("Tool Kit", { exact: true })).toBeVisible();

    } finally {
      if (!cleanupSessionId) {
        const sessions = await request.get(`${API_URL}/inventory/sessions`, { headers: qaHeaders(qaAdminIdentity) });
        if (sessions.ok()) {
          const payload = await sessions.json();
          cleanupSessionId = payload.sessions?.find(candidate => candidate.name === sessionName)?.id || "";
        }
      }
      if (cleanupSessionId) {
        await request.patch(`${API_URL}/inventory/sessions/${cleanupSessionId}`, {
          headers: qaHeaders(qaAdminIdentity),
          data: { status: "closed" }
        });
      }
    }
  });
});
