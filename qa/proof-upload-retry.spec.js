import { expect, test } from "@playwright/test";
import { Client } from "pg";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const QA_DATABASE_URL = process.env.QA_DATABASE_URL || "postgres://inventory:inventory@localhost:55432/inventory_qa";

function testIdentity(testInfo, label) {
  const suffix = `${label}-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${testInfo.workerIndex}-${Date.now()}`;
  return {
    suffix,
    identity: {
      sub: `qa-proof-upload-${suffix}`,
      email: `qa-proof-upload-${suffix}@876en.test`,
      name: `QA Proof Upload ${label}`,
      groups: ["876en-admins"]
    }
  };
}

function identityHeaders(identity) {
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

async function createClaimedItem(request, identity, suffix) {
  const sessionData = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: identityHeaders(identity),
    data: { name: `QA proof upload ${suffix}`, status: "active" }
  }));
  const packetLine = `QA-PROOF-UPLOAD-${suffix.toUpperCase()}`;
  const itemData = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionData.session.id}/items`, {
    headers: identityHeaders(identity),
    data: { packetLine, expectedQty: 1 }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${itemData.sessionItem.id}/assignment`, {
    headers: identityHeaders(identity),
    data: { memberId: "self" }
  }));

  return {
    sessionId: sessionData.session.id,
    sessionName: sessionData.session.name,
    sessionItemId: itemData.sessionItem.id,
    packetLine
  };
}

async function seedBrowserIdentity(page, identity) {
  await page.addInitScript(value => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(value));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

async function openProofForm(page, scenario) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue" })).toBeVisible();
  await page.locator(".session-row", { hasText: scenario.sessionName }).click();

  const workspace = page.getByRole("region", { name: "Inventory workspace" });
  const assignmentLists = workspace.getByRole("group", { name: "Work assignment lists" });
  await assignmentLists.getByRole("button", { name: /^Mine\b/ }).click();
  const row = page.locator(".session-item", { hasText: scenario.packetLine });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
  await expect(page.getByRole("dialog"), "viewing assigned work must not open a generic item dialog").toHaveCount(0);
  await row.getByRole("button", { name: "Add proof" }).click();

  const proofDialog = page.getByRole("dialog", { name: `Add proof for ${scenario.packetLine}` });
  const proofForm = proofDialog.locator(".proof-form");
  await expect(proofForm).toBeVisible();
  return { proofDialog, proofForm };
}

function photoFile(name) {
  return {
    name,
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  };
}

async function closeSession(request, scenario, identity) {
  if (!scenario?.sessionId) return;
  await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/direct-check`, {
    headers: identityHeaders(identity),
    data: { status: "found", note: "QA cleanup" }
  });
  await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
    headers: identityHeaders(identity),
    data: { status: "closed" }
  });
}

test.describe("proof upload retry and cleanup", () => {
  test("a failed proof submission retries without uploading the selected photo again", async ({ page, request }, testInfo) => {
    const { suffix, identity } = testIdentity(testInfo, "retry");
    const scenario = await createClaimedItem(request, identity, suffix);
    let submissionAttempts = 0;
    let photoUploadRequests = 0;

    try {
      await seedBrowserIdentity(page, identity);
      page.on("request", browserRequest => {
        if (browserRequest.method() === "POST" && new URL(browserRequest.url()).pathname === "/api/uploads/photos") {
          photoUploadRequests += 1;
        }
      });
      await page.route(`**/api/session-items/${scenario.sessionItemId}/submissions`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        submissionAttempts += 1;
        if (submissionAttempts === 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary proof failure", code: "qa_forced_failure" })
          });
        }
        return route.continue();
      });

      const { proofDialog, proofForm } = await openProofForm(page, scenario);
      await proofForm.getByLabel("Add item photos").setInputFiles(photoFile("retry-proof.jpg"));
      const submitButton = proofForm.getByRole("button", { name: "Submit proof", exact: true });
      await submitButton.click();

      await expect(proofForm.getByRole("button", { name: "Sending evidence...", exact: true })).toBeDisabled();
      await expect(proofForm.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await expect(proofForm.getByPlaceholder("Where you found or checked it")).toBeDisabled();
      await expect.poll(() => submissionAttempts).toBe(1);
      await proofForm.evaluate(form => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(50);
      expect(submissionAttempts).toBe(1);

      await expect(page.getByRole("alert").first()).toContainText("Temporary proof failure");
      await expect(page.getByRole("alert").first()).toContainText("uploaded photos will be reused when you retry");
      expect(photoUploadRequests).toBe(1);
      expect(submissionAttempts).toBe(1);

      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
      await expect(proofDialog).toBeHidden();
      expect(photoUploadRequests).toBe(1);
      expect(submissionAttempts).toBe(2);
    } finally {
      await closeSession(request, scenario, identity);
    }
  });

  test("remove and cancel discard photos staged by a failed submission", async ({ page, request }, testInfo) => {
    const { suffix, identity } = testIdentity(testInfo, "discard");
    const scenario = await createClaimedItem(request, identity, suffix);
    const stagedUploadIds = [];
    const discardedUploadIds = [];

    try {
      await seedBrowserIdentity(page, identity);
      await page.route("**/api/uploads/photos/*", async route => {
        if (route.request().method() === "DELETE") {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        await route.continue();
      });
      await page.route(`**/api/session-items/${scenario.sessionItemId}/submissions`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Forced proof validation failure", code: "qa_forced_failure" })
        });
      });
      page.on("response", async response => {
        const pathname = new URL(response.url()).pathname;
        if (response.request().method() === "POST" && pathname === "/api/uploads/photos" && response.ok()) {
          const body = await response.json();
          stagedUploadIds.push(body.photo.uploadId);
        }
        if (response.request().method() === "DELETE" && pathname.startsWith("/api/uploads/photos/") && response.ok()) {
          const body = await response.json();
          discardedUploadIds.push(body.uploadId);
        }
      });

      const { proofDialog, proofForm } = await openProofForm(page, scenario);
      const firstPhoto = "remove-staged-proof.jpg";
      await proofForm.getByLabel("Add item photos").setInputFiles(photoFile(firstPhoto));
      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
      await expect(page.getByRole("alert").first()).toContainText("Forced proof validation failure");
      await expect.poll(() => stagedUploadIds.length).toBe(1);

      await proofForm.getByRole("button", { name: `Remove ${firstPhoto}` }).click();
      await expect(proofForm.getByRole("button", { name: `Removing ${firstPhoto}` })).toBeDisabled();
      await expect(proofForm.getByText("Removing photo...", { exact: true })).toBeVisible();
      await expect(proofForm.getByRole("button", { name: "Submit proof", exact: true })).toBeDisabled();
      await expect(proofForm.getByRole("list", { name: "Selected proof photos" })).toHaveCount(0);
      await expect.poll(() => discardedUploadIds).toEqual([stagedUploadIds[0]]);

      const secondPhoto = "cancel-staged-proof.jpg";
      await proofForm.getByLabel("Add item photos").setInputFiles(photoFile(secondPhoto));
      await proofForm.getByRole("button", { name: "Submit proof", exact: true }).click();
      await expect(page.getByRole("alert").first()).toContainText("Forced proof validation failure");
      await expect.poll(() => stagedUploadIds.length).toBe(2);

      await proofForm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(proofForm.getByRole("button", { name: "Canceling...", exact: true })).toBeDisabled();
      await expect(proofForm.getByRole("button", { name: "Submit proof", exact: true })).toBeDisabled();
      await expect(proofDialog).toBeHidden();
      await expect.poll(() => discardedUploadIds).toEqual(stagedUploadIds);

      const database = new Client({ connectionString: QA_DATABASE_URL });
      await database.connect();
      try {
        const stored = await database.query("SELECT id FROM media_uploads WHERE id = ANY($1::uuid[])", [stagedUploadIds]);
        expect(stored.rows).toHaveLength(0);
      } finally {
        await database.end();
      }
    } finally {
      await closeSession(request, scenario, identity);
    }
  });
});
