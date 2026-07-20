import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

function qaHeaders() {
  return {
    "X-Dev-Sub": qaAdmin.sub,
    "X-Dev-Email": qaAdmin.email,
    "X-Dev-Name": qaAdmin.name,
    "X-Dev-Groups": qaAdmin.groups.join(","),
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

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createScenario(request, projectName) {
  const suffix = `${projectName.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const sessionName = `QA action states ${suffix}`;
  const packetLine = `QA-ACTION-${suffix.toUpperCase()} RADIO SET`;
  const sessionData = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(),
    data: { name: sessionName, status: "active" }
  }));
  const itemData = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionData.session.id}/items`, {
    headers: qaHeaders(),
    data: { packetLine, expectedQty: 1, locationHint: "QA mutation shelf" }
  }));

  return {
    sessionId: sessionData.session.id,
    sessionName,
    sessionItemId: itemData.sessionItem.id,
    packetLine
  };
}

async function seedQaAdminSession(page) {
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

async function openScenario(page, scenario) {
  await seedQaAdminSession(page);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();

  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
  await expect.poll(async () => {
    if (await selector.count()) return selector.locator(`option[value="${scenario.sessionId}"]`).count();
    return (await activeInventory.textContent())?.includes(scenario.sessionName) ? 1 : 0;
  }).toBe(1);
  if (await selector.count()) await selector.selectOption(scenario.sessionId);
  await expect.poll(async () => {
    if (await selector.count()) return selector.locator("option:checked").textContent();
    return activeInventory.getByRole("heading", { level: 2 }).textContent();
  }).toContain(scenario.sessionName);

  const row = page.locator(".session-item", { hasText: scenario.packetLine });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
  await expect(page.getByRole("dialog"), "leader item controls should be inline").toHaveCount(0);
  const leaderControls = row.getByRole("region", { name: `Manage ${scenario.packetLine}` });
  await expect(leaderControls.getByRole("heading", { name: "Leader controls" })).toBeVisible();
  return { row, leaderControls, panel: page.locator(".session-panel") };
}

test.describe("session async action states", () => {
  test("locks direct checks and close mutations through delay, failure, and retry", async ({ page, request }, testInfo) => {
    test.setTimeout(75_000);
    const scenario = await createScenario(request, testInfo.project.name);
    const directFailureGate = deferred();
    const closeFailureGate = deferred();
    const directRequestId = `qa-direct-${testInfo.project.name}`;
    const closeRequestId = `qa-close-${testInfo.project.name}`;
    let directRequests = 0;
    const directStatuses = [];
    let closeRequests = 0;

    await page.route("**/api/session-items/*/direct-check", async route => {
      directRequests += 1;
      directStatuses.push(route.request().postDataJSON()?.status);
      if (directRequests === 1) {
        await directFailureGate.promise;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "X-Request-ID": directRequestId },
          body: JSON.stringify({
            error: "The server could not complete this request.",
            code: "internal_error",
            requestId: directRequestId
          })
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/inventory/sessions/*", async route => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }

      const body = route.request().postDataJSON();
      if (body.status === "closed") {
        closeRequests += 1;
        if (closeRequests === 1) {
          await closeFailureGate.promise;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            headers: { "X-Request-ID": closeRequestId },
            body: JSON.stringify({
              error: "The server could not complete this request.",
              code: "internal_error",
              requestId: closeRequestId
            })
          });
          return;
        }
      }

      await route.continue();
    });

    const { row, leaderControls, panel } = await openScenario(page, scenario);
    const resultSelect = leaderControls.getByRole("combobox", { name: "Set result" });
    await resultSelect.selectOption("found");
    await expect(resultSelect).toBeDisabled();
    await expect.poll(() => directRequests).toBe(1);
    expect(directRequests).toBe(1);
    expect(directStatuses).toEqual(["found"]);

    directFailureGate.resolve();
    await expect(panel.getByRole("alert")).toContainText(
      "The server could not complete this request."
    );
    await expect(resultSelect).toBeEnabled();

    await resultSelect.selectOption("not_found");
    await expect.poll(() => directRequests).toBe(2);
    expect(directStatuses).toEqual(["found", "not_found"]);
    await expect(panel.getByRole("status")).toContainText("Item updated.");
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("dialog"), "direct checks must not open an item dialog").toHaveCount(0);

    const inventoryTools = page.locator(".session-tools");
    if (!(await inventoryTools.evaluate(element => element.open))) {
      await inventoryTools.locator(".session-tools-heading").click();
    }
    await inventoryTools.getByRole("button", { name: "Close inventory", exact: true }).click();
    let closeDialog = page.getByRole("dialog", { name: "Close this inventory?" });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close inventory", exact: true }).click();
    const closing = closeDialog.getByRole("button", { name: "Closing...", exact: true });
    await expect(closing).toBeDisabled();
    await expect(closeDialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect.poll(() => closeRequests).toBe(1);
    await closing.evaluate(button => button.click());
    await page.waitForTimeout(100);
    expect(closeRequests).toBe(1);

    closeFailureGate.resolve();
    await expect(closeDialog).toBeVisible();
    await expect(closeDialog.getByRole("alert")).toContainText(
      "The server could not complete this request."
    );
    await expect(closeDialog.getByRole("button", { name: "Close inventory", exact: true })).toBeEnabled();

    await closeDialog.getByRole("button", { name: "Close inventory", exact: true }).click();
    await expect.poll(() => closeRequests).toBe(2);
    await expect(closeDialog).toBeHidden();
    await expect(page.getByText("Inventory closed.", { exact: true })).toBeVisible();

    await expect(
      page.getByRole("region", { name: "Active inventory" }),
      "a closed session must disappear from the dashboard without a page reload"
    ).not.toContainText(scenario.sessionName);
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to dashboard", exact: true })).toHaveCount(0);
  });
});
