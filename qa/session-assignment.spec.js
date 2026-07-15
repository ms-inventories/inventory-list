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
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
  }
  await page.getByRole("button", { name: "Inventory Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
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
  await page.locator(".session-create-form").getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.locator(".session-row", { hasText: name })).toHaveCount(1);
}

async function addPacketRows(page) {
  await page.locator(".packet-wizard-entry").getByRole("button", { name: "Upload packet" }).click();
  const dialog = page.getByRole("dialog", { name: "Upload packet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Choose source" }).click();
  await dialog.locator("textarea").fill([
    "000002115 W34648 TOOL KIT CARPENTERS: ENGINEER SQUAD",
    "0000186033 M05000 TAMPER,VIBRATING TYPE,INTERNAL COMBUST"
  ].join("\n"));
  await dialog.getByRole("button", { name: "Review rows" }).click();
  await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
  await dialog.getByRole("button", { name: /Import 2 rows?/ }).click();
  await expect(dialog.getByRole("heading", { name: "Packet imported" })).toBeVisible();
  await dialog.getByRole("button", { name: /^(Open session|Review matches)$/ }).click();
  await expect(dialog).toBeHidden();
  const itemDrawer = page.locator(".session-item-drawer");
  if (await itemDrawer.isVisible()) {
    await itemDrawer.getByRole("button", { name: "Close item details" }).click();
  }
}

test.describe("session assignment", () => {
  test("platoon admins can assign rows and contributors can filter their work", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const sessionName = `QA assignment ${testInfo.project.name} ${Date.now()}`;

    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await openSessions(page);
    await createSession(page, sessionName);
    await addPacketRows(page);

    const toolKitRow = page.locator(".session-item", { hasText: "Tool Kit" }).first();
    await expect(toolKitRow.locator(".session-assignment-control")).toHaveCount(0);
    await expect(toolKitRow.getByRole("button", { name: "Found", exact: true })).toHaveCount(0);
    await expect(toolKitRow.getByRole("button", { name: "Not found", exact: true })).toHaveCount(0);
    await expect(toolKitRow.getByRole("button", { name: "Claim item" })).toBeVisible();
    await toolKitRow.getByRole("button", { name: /Open details for/ }).click();
    const assignmentDrawer = page.getByRole("dialog");
    const leaderTools = assignmentDrawer.locator("details.session-detail-disclosure").filter({ hasText: "Manage item" });
    await leaderTools.locator("summary").click();
    await leaderTools.getByRole("combobox").selectOption({ label: "QA NCO" });
    await expect(assignmentDrawer.getByRole("status")).toContainText("Row assigned.");
    await assignmentDrawer.getByRole("button", { name: "Close item details" }).click();
    await expect(toolKitRow.getByText("Assigned to QA NCO")).toBeVisible();

    await seedQaSession(page, qaNcoIdentity);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await openSessions(page);
    await page.locator(".session-row", { hasText: sessionName }).click();
    await page.getByRole("button", { name: /^Mine\b/ }).click();

    const assignedToolKitRow = page.locator(".session-item", { hasText: "TOOL KIT CARPENTERS" }).first();
    await expect(assignedToolKitRow).toBeVisible();
    await expect(assignedToolKitRow.getByText("Assigned to QA NCO", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Unclaimed\b/ }).click();
    const generatorRow = page.locator(".session-item", { hasText: "TAMPER,VIBRATING" }).first();
    if (testInfo.project.name === "mobile-chrome") {
      await expect(generatorRow.getByRole("button", { name: "Claim item" })).toBeVisible();
      await generatorRow.getByRole("button", { name: "Claim item" }).click();
      await expect(page.getByRole("dialog").getByRole("status")).toContainText("Item claimed.");
    } else {
      await expect(generatorRow.getByRole("button", { name: "Claim item" })).toBeVisible();
      await generatorRow.getByRole("button", { name: "Claim item" }).click();
    }
    await expect(generatorRow.getByText("Assigned to QA NCO")).toBeVisible();
    await expect(generatorRow.locator(".proof-form")).toHaveCount(0);
    const proofDrawer = page.getByRole("dialog");
    await expect(proofDrawer).toBeVisible();
    const claimedProofForm = proofDrawer.locator(".proof-form");
    await expect(claimedProofForm).toBeVisible();
    await claimedProofForm.getByRole("button", { name: "Cancel" }).click();
    await expect(proofDrawer).toBeHidden();
    await page.getByRole("button", { name: /^Unclaimed\b/ }).click();
    await expect(page.getByText("No items available to claim", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show mine", exact: true }).click();
    await expect(page.getByText("No items available to claim", { exact: true })).toHaveCount(0);
    const mineGeneratorRow = page.locator(".session-item", { hasText: "TAMPER,VIBRATING" });
    await expect(mineGeneratorRow).toBeVisible();
    await expect(mineGeneratorRow.locator(".proof-form")).toHaveCount(0);
    await mineGeneratorRow.getByRole("button", { name: "Add proof" }).click();
    const reopenedProofDrawer = page.getByRole("dialog");
    await expect(reopenedProofDrawer.locator(".proof-form")).toBeVisible();
    await expect(mineGeneratorRow.locator(".proof-form")).toHaveCount(0);
    await reopenedProofDrawer.locator(".proof-form").getByRole("button", { name: "Cancel" }).click();
    await expect(reopenedProofDrawer).toBeHidden();

    const sessions = await responseJson(await request.get(`${API_URL}/inventory/sessions`, {
      headers: qaHeaders(qaAdminIdentity)
    }));
    const session = sessions.sessions.find(candidate => candidate.name === sessionName);
    expect(session?.id).toBeTruthy();
    const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${session.id}`, {
      headers: qaHeaders(qaAdminIdentity)
    }));
    const generator = detail.items.find(item => item.packetLine.includes("TAMPER,VIBRATING"));
    const toolKit = detail.items.find(item => item.packetLine.includes("TOOL KIT CARPENTERS"));
    expect(generator?.id).toBeTruthy();
    expect(toolKit?.id).toBeTruthy();
    await responseJson(await request.patch(`${API_URL}/session-items/${generator.id}/direct-check`, {
      headers: qaHeaders(qaAdminIdentity),
      data: { status: "approved" }
    }));

    await page.reload();
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await openSessions(page);
    await page.locator(".session-row", { hasText: sessionName }).click();
    const sessionResults = page.getByRole("region", { name: "Session row results" });
    for (const name of [/^Mine\b/, /^Unclaimed\b/, /^Others\b/]) {
      await page.getByRole("button", { name }).click();
      await expect(sessionResults.getByText(/TAMPER,VIBRATING/)).toHaveCount(0);
    }
    const completed = page.locator(".session-completed-items");
    await completed.locator("summary").click();
    await expect(completed.getByText(/TAMPER,VIBRATING/)).toBeVisible();
    await expect(completed.getByRole("button", { name: /Open details for completed item/ })).toBeVisible();
    const sessionSearch = page.getByRole("searchbox", { name: "Search current session rows" });
    await sessionSearch.fill("TAMPER,VIBRATING");
    await expect(page.getByText("No matching items", { exact: true })).toHaveCount(0);
    await expect(completed.getByText(/TAMPER,VIBRATING/)).toBeVisible();

    await responseJson(await request.patch(`${API_URL}/session-items/${toolKit.id}/direct-check`, {
      headers: qaHeaders(qaAdminIdentity),
      data: { status: "approved" }
    }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await openSessions(page);
    await page.locator(".session-row", { hasText: sessionName }).click();
    await expect(page.locator(".session-completed-items")).toHaveAttribute("open", "");
    await expect(page.locator(".session-completed-items").getByText(/TOOL KIT CARPENTERS/)).toBeVisible();

    await request.patch(`${API_URL}/inventory/sessions/${session.id}`, {
      headers: qaHeaders(qaAdminIdentity),
      data: { status: "closed" }
    });
  });
});
