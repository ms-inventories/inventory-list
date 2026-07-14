import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PHOTO_DATA_URL = `data:image/jpeg;base64,${fs.readFileSync(path.resolve("assets/dagr.jpg")).toString("base64")}`;

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

const qaNco = {
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

async function uploadPhoto(request, label, caption, kind, identity = qaNco) {
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(identity),
    data: {
      fileName: `${label}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: PHOTO_DATA_URL,
      caption,
      kind,
      purpose: label.startsWith("reference-") ? "inventory_reference" : "evidence"
    }
  }));
  return upload.photo;
}

async function submitProof(request, sessionItemId, data) {
  return responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(qaNco),
    data
  }));
}

async function createDrawerScenario(request, projectName) {
  const suffix = `${projectName.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const lin = `D${String(Date.now()).slice(-8)}`;
  const title = `Drawer Test Radio ${suffix}`;
  const armyName = `RADIO SET: DRAWER TEST ${suffix}`;
  const packetLine = `000000001 ${lin} ${armyName}`;
  const sourceName = `drawer-source-${suffix}.txt`;
  const referencePhoto = await uploadPhoto(request, `reference-${suffix}`, "Known item reference", "general", qaAdmin);

  await responseJson(await request.post(`${API_URL}/inventory/items`, {
    headers: qaHeaders(qaAdmin),
    data: {
      title,
      commonName: title,
      armyName,
      lin,
      nsn: `5820-${String(Date.now()).slice(-9)}`,
      description: "Portable test radio with handset and battery tray.",
      currentLocation: "Cage 9, radio shelf",
      metadata: { imageUrl: referencePhoto.url },
      mediaUploadIds: [referencePhoto.uploadId]
    }
  }));

  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: `QA drawer ${suffix}`, status: "active" }
  }));

  const sourceBuffer = Buffer.from(`${packetLine}\n`, "utf8");
  const bulk = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items/bulk`, {
    headers: qaHeaders(qaAdmin),
    data: {
      items: [{ packetLine, expectedQty: 2, locationHint: "Cage 9 staging area" }],
      importBatch: {
        sourceName,
        sourceMimeType: "text/plain",
        extractedText: sourceBuffer.toString("utf8"),
        sourceFile: {
          fileName: sourceName,
          mimeType: "text/plain",
          size: sourceBuffer.length,
          dataUrl: `data:text/plain;base64,${sourceBuffer.toString("base64")}`
        }
      }
    }
  }));
  const sessionItemId = bulk.sessionItems[0].id;

  const members = await responseJson(await request.get(`${API_URL}/tenant/members`, {
    headers: qaHeaders(qaAdmin)
  }));
  const ncoMember = members.members.find(member => member.email === qaNco.email);
  expect(ncoMember?.id).toBeTruthy();
  await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/assignment`, {
    headers: qaHeaders(qaAdmin),
    data: { memberId: ncoMember.id }
  }));

  const widePhoto = await uploadPhoto(request, `wide-${suffix}`, "Initial wide photo", "general");
  const initial = await submitProof(request, sessionItemId, {
    status: "found",
    locationText: "Cage 9",
    note: "Initial photo did not show the data plate.",
    photos: [{ uploadId: widePhoto.uploadId, caption: widePhoto.caption, kind: widePhoto.kind }]
  });
  const requestMessage = `Need a clear serial photo for ${suffix}.`;
  await responseJson(await request.post(`${API_URL}/submissions/${initial.submission.id}/evidence-requests`, {
    headers: qaHeaders(qaAdmin),
    data: { message: requestMessage, requestedFields: ["serial_photo"] }
  }));

  const serialPhoto = await uploadPhoto(request, `serial-${suffix}`, "Readable serial plate", "serial");
  const note = "Serial plate and final location confirmed.";
  const serialNumber = `DRAWER-${suffix.toUpperCase()}`;
  await submitProof(request, sessionItemId, {
    status: "found",
    locationText: "Cage 9, radio shelf",
    serialNumber,
    note,
    photos: [{ uploadId: serialPhoto.uploadId, caption: serialPhoto.caption, kind: serialPhoto.kind }]
  });

  return {
    sessionId: session.session.id,
    sessionName: session.session.name,
    sessionItemId,
    ncoMemberId: ncoMember.id,
    title,
    armyName,
    lin,
    packetLine,
    sourceName,
    note,
    serialNumber,
    requestMessage
  };
}

async function signInAsAdmin(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function signInAsContributor(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "NCO" }).click();
  await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
}

async function openSessions(page) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole("button", { name: "Inventory Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
}

async function selectSession(page, scenario, { closed = false } = {}) {
  if (closed) {
    const archive = page.locator(".session-archive");
    if (!(await archive.evaluate(element => element.open))) await archive.locator("summary").click();
  }
  const sessionButton = page.locator(".session-row", { hasText: scenario.sessionName });
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();
  await expect(page.locator(".session-summary", { hasText: scenario.sessionName })).toBeVisible();
}

test.describe("session item details", () => {
  test("contributors see a single awaiting-review state after submitting proof", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const scenario = await createDrawerScenario(request, `pending-${testInfo.project.name}`);

    await signInAsContributor(page);
    await openSessions(page);
    await selectSession(page, scenario);
    await page.getByRole("button", { name: /^Mine\b/ }).click();

    const row = page.locator(".session-item", { hasText: scenario.title });
    await expect(row.getByText("Awaiting review", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Review proof" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);
    await expect(row.locator(".proof-form")).toHaveCount(0);

    await row.getByRole("button", { name: `Open details for ${scenario.title}` }).click();
    const drawer = page.getByRole("dialog", { name: scenario.title });
    await expect(drawer.getByText("Awaiting review", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Review proof" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);
    await expect(drawer.locator(".proof-form")).toHaveCount(0);

    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));
  });

  test("centralizes row history, source, evidence, and permitted actions", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const scenario = await createDrawerScenario(request, testInfo.project.name);

    await signInAsAdmin(page);
    await openSessions(page);
    await selectSession(page, scenario);
    await page.getByRole("button", { name: /^Others\b/ }).click();

    const row = page.locator(".session-item", { hasText: scenario.title });
    const detailsButton = row.getByRole("button", { name: `Open details for ${scenario.title}` });
    await expect(detailsButton).toHaveAttribute("aria-haspopup", "dialog");
    await detailsButton.click();

    let drawer = page.getByRole("dialog", { name: scenario.title });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(scenario.packetLine, { exact: true }).first()).toBeVisible();

    const inventoryDetails = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Inventory details" });
    await expect(inventoryDetails).not.toHaveAttribute("open", "");
    await inventoryDetails.locator("summary").click();
    await expect(inventoryDetails.getByText(scenario.packetLine, { exact: true })).toBeVisible();
    await expect(inventoryDetails.getByText("QA NCO", { exact: true })).toBeVisible();

    const knownItem = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Known item" });
    await expect(knownItem).not.toHaveAttribute("open", "");
    await knownItem.locator("summary").click();
    await expect(knownItem.getByText(scenario.armyName, { exact: true })).toBeVisible();
    await expect(knownItem.getByText(scenario.lin, { exact: true })).toBeVisible();
    await expect(drawer.getByText("Cage 9, radio shelf", { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText("QA NCO", { exact: true }).first()).toBeVisible();

    const packetSource = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Packet source" });
    await expect(packetSource).not.toHaveAttribute("open", "");
    await packetSource.locator("summary").click();
    await expect(drawer.getByText(scenario.sourceName, { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open source" })).toHaveAttribute("href", /\/media\//);

    const proofHistory = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Proof history" });
    await expect(drawer.getByText("2 submissions", { exact: true })).toBeVisible();
    await expect(proofHistory).not.toHaveAttribute("open", "");
    await proofHistory.locator("summary").click();
    await expect(drawer.getByText(scenario.note, { exact: true })).toBeVisible();
    await expect(drawer.getByText(`Serial: ${scenario.serialNumber}`, { exact: true })).toBeVisible();
    await expect(proofHistory.getByText(scenario.requestMessage, { exact: false })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Review proof" })).toBeVisible();

    const knownImage = drawer.getByRole("link", { name: "Open known item photo 1" }).locator("img");
    await expect.poll(() => knownImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBeTruthy();

    const evidenceButton = drawer.getByRole("button", { name: "View Serial photo: Readable serial plate" });
    await evidenceButton.click();
    const viewer = page.getByRole("dialog", { name: "Evidence photo" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(scenario.requestMessage, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(evidenceButton).toBeFocused();

    await expect(drawer.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);

    const leaderTools = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Manage item" });
    await expect(leaderTools).not.toHaveAttribute("open", "");
    await leaderTools.locator("summary").click();
    const assignment = leaderTools.getByRole("combobox");
    await expect(assignment).toHaveValue(scenario.ncoMemberId);
    await assignment.selectOption("");
    await expect(drawer.getByRole("status")).toContainText("Row assignment cleared.");
    await expect(assignment).toHaveValue("");
    await assignment.selectOption(scenario.ncoMemberId);
    await expect(drawer.getByRole("status")).toContainText("Row assigned.");

    const viewport = page.viewportSize();
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox.x).toBeGreaterThanOrEqual(0);
    expect(drawerBox.y).toBeGreaterThanOrEqual(0);
    expect(drawerBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(drawerBox.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    if (testInfo.project.name === "mobile-chrome") {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
    }

    const screenshotPath = testInfo.outputPath("session-item-drawer.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("session-item-drawer", { path: screenshotPath, contentType: "image/png" });

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(detailsButton).toBeFocused();

    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));

    const closedSessionMutations = [
      () => request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
        headers: qaHeaders(qaAdmin),
        data: { memberId: null }
      }),
      () => request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/direct-check`, {
        headers: qaHeaders(qaAdmin),
        data: { status: "approved" }
      }),
      () => request.post(`${API_URL}/session-items/${scenario.sessionItemId}/submissions`, {
        headers: qaHeaders(qaNco),
        data: { status: "found", note: "Should be blocked" }
      })
    ];
    for (const mutate of closedSessionMutations) {
      const response = await mutate();
      expect(response.status()).toBe(409);
      const body = await response.json();
      expect(body.code).toBe("conflict");
      expect(body.error).toBe("Closed sessions are read-only.");
    }

    await page.reload();
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await openSessions(page);
    await selectSession(page, scenario, { closed: true });
    await page.getByRole("button", { name: /^Others\b/ }).click();
    await page.locator(".session-item", { hasText: scenario.title }).getByRole("button", { name: `Open details for ${scenario.title}` }).click();
    drawer = page.getByRole("dialog", { name: scenario.title });
    await expect(drawer).toBeVisible();
    const closedLeaderTools = drawer.locator("details.session-detail-disclosure").filter({ hasText: "Manage item" });
    await closedLeaderTools.locator("summary").click();
    await expect(closedLeaderTools.getByRole("combobox")).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "Found" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Not found" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Review proof" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);
  });
});
