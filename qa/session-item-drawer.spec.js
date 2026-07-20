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

async function createInlineScenario(request, projectName) {
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
  await responseJson(await request.patch(`${API_URL}/session-items/${sessionItemId}/inventory-match`, {
    headers: qaHeaders(qaAdmin),
    data: { action: "confirm" }
  }));

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
  const requestMessage = `Need a clear item photo for ${suffix}.`;
  await responseJson(await request.patch(`${API_URL}/submissions/${initial.submission.id}/review`, {
    headers: qaHeaders(qaAdmin),
    data: { decision: "rejected", note: requestMessage, returnAssignment: "submitter" }
  }));

  const serialPhoto = await uploadPhoto(request, `serial-${suffix}`, "Readable serial plate", "serial");
  const note = "Serial plate and final location confirmed.";
  const serialNumber = `DRAWER-${suffix.toUpperCase()}`;
  const final = await submitProof(request, sessionItemId, {
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
    requestMessage,
    submissionId: final.submission.id
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
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Open inventories", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
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

test.describe("inline session item work", () => {
  test("contributors see one awaiting-review state and can withdraw before review", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const scenario = await createInlineScenario(request, `pending-${testInfo.project.name}`);

    await signInAsContributor(page);
    await openSessions(page);
    await selectSession(page, scenario);
    const workspace = page.getByRole("region", { name: "Inventory workspace" });
    await workspace.getByRole("group", { name: "Work assignment lists" })
      .getByRole("button", { name: /^Mine\b/ })
      .click();

    const row = workspace.locator(".session-item", { hasText: scenario.title });
    await expect(row.locator(".session-proof-state").getByText("Pending review", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Withdraw submission", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Review proof" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);
    await expect(row.locator(".proof-form")).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(page.locator(".session-item-drawer")).toHaveCount(0);
    await expect(page.getByRole("dialog"), "reading an item row must not require a dialog").toHaveCount(0);

    await row.getByRole("button", { name: "Withdraw submission", exact: true }).click();
    await expect(page.locator(".session-panel").getByRole("status")).toContainText("Submission withdrawn. You can update the proof and submit it again.");
    await expect(row.getByRole("button", { name: "Add proof", exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Add proof", exact: true }).click();
    const proofDialog = page.getByRole("dialog", { name: `Add proof for ${scenario.title}` });
    await expect(proofDialog).toBeVisible();
    await expect(proofDialog.locator(".proof-form")).toBeVisible();
    await expect(page.locator(".session-item-drawer")).toHaveCount(0);
    await proofDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(proofDialog).toBeHidden();

    const withdrawnDetail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin)
    }));
    const withdrawnSubmission = withdrawnDetail.items
      .find(item => item.id === scenario.sessionItemId)
      ?.submissions.find(submission => submission.id === scenario.submissionId);
    expect(withdrawnSubmission?.reviewState).toBe("withdrawn");
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));
  });

  test("shows saved relationships, proof history, and leader actions inline without technical links", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const scenario = await createInlineScenario(request, testInfo.project.name);

    await signInAsAdmin(page);
    await openSessions(page);
    await selectSession(page, scenario);
    const workspace = page.getByRole("region", { name: "Inventory workspace" });
    await workspace.getByRole("group", { name: "Work assignment lists" })
      .getByRole("button", { name: /^Others\b/ })
      .click();

    const row = workspace.locator(".session-item", { hasText: scenario.title });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(page.locator(".session-item-drawer")).toHaveCount(0);
    await expect(page.getByRole("dialog"), "the complete item context should be visible in the row").toHaveCount(0);
    const knownItem = row.getByRole("region", { name: `Saved record for ${scenario.title}` });
    await expect(knownItem.getByRole("heading", { name: "Previous inventory" })).toBeVisible();
    await expect(row).toContainText(scenario.lin);
    await expect(knownItem).toContainText("Cage 9, radio shelf");
    const knownImage = knownItem.locator("img").first();
    await expect(knownImage).toBeVisible();
    await expect.poll(() => knownImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBeTruthy();

    await expect(row.locator(".session-item-provenance")).toHaveCount(0);
    await expect(row).not.toContainText(scenario.sourceName);
    await expect(row.getByRole("link", { name: /Open source|Source/i })).toHaveCount(0);
    await expect(row.locator('a[href*="/packet-imports/"]')).toHaveCount(0);

    const proofHistory = row.getByRole("region", { name: `Proof history for ${scenario.title}` });
    await expect(proofHistory.getByRole("heading", { name: "Proof history" })).toBeVisible();
    await expect(proofHistory).toContainText("2 submissions");
    await expect(proofHistory.getByText(scenario.note, { exact: true })).toBeVisible();
    await expect(proofHistory.getByText(`Serial: ${scenario.serialNumber}`, { exact: true })).toBeVisible();
    await expect(proofHistory.getByText(scenario.requestMessage, { exact: false })).toBeVisible();
    const reviewProofButton = row.getByRole("button", { name: "Review proof" });
    await expect(reviewProofButton).toBeVisible();
    await expect(row.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);

    await reviewProofButton.click();
    const reviewDialog = page.getByRole("dialog", { name: "Review proof", exact: true });
    await expect(reviewDialog).toBeVisible();
    await expect(reviewDialog.locator(".review-card", { hasText: scenario.packetLine })).toBeVisible();
    await expect(reviewDialog.locator(".review-card")).toHaveCount(1);
    await reviewDialog.getByRole("button", { name: "Close review", exact: true }).click();
    await expect(reviewDialog).toBeHidden();
    await expect(reviewProofButton).toBeFocused();

    const evidenceButton = proofHistory.getByRole("button", { name: "View Item photo: Readable serial plate" });
    await evidenceButton.click();
    const viewer = page.getByRole("dialog", { name: "Evidence photo" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(scenario.requestMessage, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(evidenceButton).toBeFocused();

    const leaderTools = row.getByRole("region", { name: `Manage ${scenario.title}` });
    await expect(leaderTools.getByRole("heading", { name: "Leader controls" })).toBeVisible();
    const assignment = leaderTools.getByRole("combobox", { name: "Assign to" });
    await expect(assignment).toHaveValue(scenario.ncoMemberId);
    await assignment.selectOption("");
    await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item assignment cleared.");
    await expect(assignment).toHaveValue("");
    await assignment.selectOption(scenario.ncoMemberId);
    await expect(page.locator(".session-panel").getByRole("status")).toContainText("Item assigned.");

    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    if (testInfo.project.name === "mobile-chrome") {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
    }

    const screenshotPath = testInfo.outputPath("session-item-inline-context.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("session-item-inline-context", { path: screenshotPath, contentType: "image/png" });

    await responseJson(await request.patch(`${API_URL}/submissions/${scenario.submissionId}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved", saveItem: false }
    }));
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
        data: { status: "found" }
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
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    await selectSession(page, scenario, { closed: true });
    const completedItems = page.locator(".session-completed-items");
    if (!(await completedItems.evaluate(element => element.open))) {
      await completedItems.locator("summary").click();
    }
    const completedRow = completedItems.locator(".session-completed-item", { hasText: scenario.title });
    await expect(completedRow).toBeVisible();
    await expect(completedRow.getByRole("button", { name: /Open details|Open item/i })).toHaveCount(0);
    await expect(completedRow.getByRole("region", { name: `Saved record for ${scenario.title}` })).toBeVisible();
    await expect(completedRow.getByRole("region", { name: `Proof history for ${scenario.title}` })).toContainText(scenario.note);
    await expect(completedRow.locator(".session-item-provenance")).toHaveCount(0);
    await expect(completedRow.locator('a[href*="/packet-imports/"]')).toHaveCount(0);
    await expect(completedRow.getByRole("region", { name: `Manage ${scenario.title}` })).toHaveCount(0);
    await expect(completedRow.getByRole("button", { name: "Review proof" })).toHaveCount(0);
    await expect(completedRow.getByRole("button", { name: /Add proof|Respond with proof/ })).toHaveCount(0);
    await expect(page.getByRole("dialog"), "completed item history should remain inline and read-only").toHaveCount(0);
  });
});
