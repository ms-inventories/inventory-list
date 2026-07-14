import fs from "node:fs";
import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const PHOTO_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

function qaHeaders(identity, tenantSlug = "ms") {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": tenantSlug
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function createSession(request, name, tenantSlug = "ms", identity = qaAdmin) {
  return (await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { name, status: "active" }
  }))).session;
}

async function createItem(request, sessionId, packetLine, tenantSlug = "ms", identity = qaAdmin) {
  return (await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionId}/items`, {
    headers: qaHeaders(identity, tenantSlug),
    data: { packetLine, expectedQty: 1, locationHint: `Shelf for ${packetLine}` }
  }))).sessionItem;
}

async function directCheck(request, itemId, status) {
  await responseJson(await request.patch(`${API_URL}/session-items/${itemId}/direct-check`, {
    headers: qaHeaders(qaAdmin),
    data: { status }
  }));
}

async function submitResult(request, itemId, status, marker) {
  await responseJson(await request.patch(`${API_URL}/session-items/${itemId}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));
  let photos = [];
  if (status === "found") {
    const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
      headers: qaHeaders(qaNco),
      data: {
        fileName: `report-${marker}.png`,
        mimeType: "image/png",
        dataUrl: PHOTO_DATA_URL,
        caption: `Report proof ${marker}`,
        kind: "general",
        purpose: "evidence"
      }
    }));
    photos = [{ uploadId: upload.photo.uploadId, kind: "general" }];
  }
  return (await responseJson(await request.post(`${API_URL}/session-items/${itemId}/submissions`, {
    headers: qaHeaders(qaNco),
    data: {
      status,
      locationText: `Report location ${marker}`,
      serialNumber: `REPORT-${marker}`,
      note: `Report note ${marker}`,
      photos
    }
  }))).submission;
}

async function signInAndOpenReports(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
}

test.describe("cross-session reports", () => {
  test("filters outcomes and proof work, exports safe CSV, and prints the selected report", async ({ page, request }, testInfo) => {
    test.setTimeout(75_000);
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
    const activeName = `QA Reports Active ${suffix}`;
    const closedName = `QA Reports Closed ${suffix}`;
    const foundMarker = `REPORT-FOUND-${suffix}`;
    const formulaMarker = `=REPORT-FORMULA-${suffix}`;
    const missingMarker = `REPORT-MISSING-${suffix}`;
    const pendingMarker = `REPORT-PENDING-${suffix}`;
    const approvedMissingMarker = `REPORT-APPROVED-MISSING-${suffix}`;
    const foreignMarker = `FOREIGN-REPORT-${suffix}`;

    const active = await createSession(request, activeName);
    const found = await createItem(request, active.id, foundMarker);
    const formula = await createItem(request, active.id, formulaMarker);
    const missing = await createItem(request, active.id, missingMarker);
    const pending = await createItem(request, active.id, pendingMarker);
    await directCheck(request, found.id, "found");
    await directCheck(request, formula.id, "found");
    await directCheck(request, missing.id, "not_found");
    await submitResult(request, pending.id, "found", suffix);

    const closed = await createSession(request, closedName);
    const approvedMissing = await createItem(request, closed.id, approvedMissingMarker);
    const approvedSubmission = await submitResult(request, approvedMissing.id, "not_found", `${suffix}-missing`);
    await responseJson(await request.patch(`${API_URL}/submissions/${approvedSubmission.id}/review`, {
      headers: qaHeaders(qaAdmin),
      data: { decision: "approved", note: "Missing outcome confirmed." }
    }));
    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${closed.id}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));

    const foreign = await createSession(request, `Foreign ${suffix}`, "qa-other", qaRoot);
    await createItem(request, foreign.id, foreignMarker, "qa-other", qaRoot);

    const apiReport = await responseJson(await request.get(`${API_URL}/inventory/reports`, {
      headers: qaHeaders(qaAdmin)
    }));
    expect(apiReport.rows.some(item => item.packetLine === foundMarker)).toBeTruthy();
    expect(apiReport.rows.some(item => item.packetLine === approvedMissingMarker)).toBeTruthy();
    expect(apiReport.rows.some(item => item.packetLine === foreignMarker)).toBeFalsy();

    await signInAndOpenReports(page);
    const results = page.getByRole("region", { name: "Report results" });
    await expect(results.getByText(foundMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(approvedMissingMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(foreignMarker, { exact: true })).toHaveCount(0);

    await page.getByRole("combobox", { name: "Session", exact: true }).selectOption(active.id);
    await expect(results.getByText(foundMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(approvedMissingMarker, { exact: true })).toHaveCount(0);

    const filters = page.getByRole("group", { name: "Proof status and outcome filters" });
    const allResults = filters.getByRole("button", { name: /^All\b/ });
    const foundResults = filters.getByRole("button", { name: /Found/ });
    await expect(allResults).toHaveAttribute("aria-pressed", "true");
    await foundResults.click();
    await expect(foundResults).toHaveAttribute("aria-pressed", "true");
    await expect(allResults).toHaveAttribute("aria-pressed", "false");
    await expect(results.getByText(foundMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(formulaMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(missingMarker, { exact: true })).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("qa-reports-active");
    const downloadPath = await download.path();
    const csv = fs.readFileSync(downloadPath, "utf8");
    expect(csv).toContain(foundMarker);
    expect(csv).toContain(`"'${formulaMarker}"`);
    expect(csv).not.toContain(missingMarker);
    expect(csv).not.toContain(foreignMarker);

    await filters.getByRole("button", { name: /Missing/ }).click();
    await expect(results.getByText(missingMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(foundMarker, { exact: true })).toHaveCount(0);

    await page.getByRole("combobox", { name: "Session", exact: true }).selectOption(closed.id);
    await expect(results.getByText(approvedMissingMarker, { exact: true })).toBeVisible();
    await expect(results.getByText("Not found", { exact: true }).first()).toBeVisible();

    await page.getByRole("combobox", { name: "Session", exact: true }).selectOption(active.id);
    await filters.getByRole("button", { name: /Proof work/ }).click();
    await expect(results.getByText(pendingMarker, { exact: true })).toBeVisible();
    await expect(results.getByText(foundMarker, { exact: true })).toHaveCount(0);

    await page.evaluate(() => {
      window.__reportPrints = [];
      window.print = () => window.__reportPrints.push(document.querySelector(".reports-page")?.innerText || "");
    });
    const reportMoreActions = page.getByRole("button", { name: "More actions", exact: true });
    if (await reportMoreActions.isVisible()) await reportMoreActions.click();
    await page.getByRole("button", { name: "Print summary" }).click();
    await expect.poll(() => page.evaluate(() => window.__reportPrints.length)).toBe(1);
    const printText = await page.evaluate(() => window.__reportPrints[0]);
    expect(printText).toContain(pendingMarker);
    expect(printText).not.toContain(foundMarker);
    expect(printText).not.toContain(foreignMarker);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
  });

  test("contributors cannot open reports", async ({ page, request }) => {
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.locator("summary").filter({ hasText: "QA users" }).click();
    await page.getByRole("button", { name: "NCO" }).click();
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await expect(page.getByRole("button", { name: "Reports", exact: true })).toHaveCount(0);
    expect((await request.get(`${API_URL}/inventory/reports`, { headers: qaHeaders(qaNco) })).status()).toBe(403);
  });
});
