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

async function uploadPhoto(request, { label, caption, kind }) {
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(qaNco),
    data: {
      fileName: `${label}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: PHOTO_DATA_URL,
      caption,
      kind
    }
  }));
  return upload.photo;
}

async function createSubmission(request, sessionItemId, data) {
  return responseJson(await request.post(`${API_URL}/session-items/${sessionItemId}/submissions`, {
    headers: qaHeaders(qaNco),
    data
  }));
}

async function createViewerScenario(request, projectName) {
  const suffix = `${projectName.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const packetLine = `QA-PHOTO-${suffix.toUpperCase()} RADIO SET`;
  const session = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: `QA photo viewer ${suffix}`, status: "active" }
  }));
  const item = await responseJson(await request.post(`${API_URL}/inventory/sessions/${session.session.id}/items`, {
    headers: qaHeaders(qaAdmin),
    data: { packetLine, expectedQty: 1, locationHint: "Cage 7, upper shelf" }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${item.sessionItem.id}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));

  const firstPhoto = await uploadPhoto(request, {
    label: `wide-${suffix}`,
    caption: "Initial wide view",
    kind: "general"
  });
  const firstSubmission = await createSubmission(request, item.sessionItem.id, {
    status: "found",
    locationText: "Cage 7",
    note: "Initial wide view only.",
    photos: [{ uploadId: firstPhoto.uploadId, caption: firstPhoto.caption, kind: firstPhoto.kind }]
  });

  const requestMessage = `Need the serial plate and exact shelf location for ${suffix}.`;
  await responseJson(await request.patch(`${API_URL}/submissions/${firstSubmission.submission.id}/review`, {
    headers: qaHeaders(qaAdmin),
    data: { decision: "rejected", note: requestMessage, returnAssignment: "submitter" }
  }));

  const photoDefinitions = [
    { label: `serial-${suffix}`, caption: "Serial data plate", kind: "serial" },
    { label: `location-${suffix}`, caption: "Upper shelf placement", kind: "location" },
    { label: `general-${suffix}`, caption: "Complete radio set", kind: "general" }
  ];
  const uploadedPhotos = [];
  for (const definition of photoDefinitions) {
    uploadedPhotos.push(await uploadPhoto(request, definition));
  }

  const note = "Serial and placement photos attached.";
  const serialNumber = `VIEW-${suffix.toUpperCase()}`;
  await createSubmission(request, item.sessionItem.id, {
    status: "found",
    locationText: "Cage 7, upper shelf",
    serialNumber,
    note,
    photos: uploadedPhotos.map(photo => ({
      uploadId: photo.uploadId,
      caption: photo.caption,
      kind: photo.kind
    }))
  });

  return {
    packetLine,
    requestMessage,
    note,
    serialNumber
  };
}

async function signInAndOpenReviewQueue(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Platoon admin" }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

  await page.getByRole("region", { name: "Dashboard review results" })
    .getByRole("button", { name: "Open review queue", exact: true })
    .first()
    .click();
  await expect(page.getByRole("region", { name: "Review queue", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review Queue", exact: true })).toBeVisible();
}

test.describe("proof photo viewer", () => {
  test("opens labeled evidence in an accessible mobile-friendly lightbox", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const scenario = await createViewerScenario(request, testInfo.project.name);

    await signInAndOpenReviewQueue(page);
    const card = page.locator(".review-card", { hasText: scenario.packetLine });
    await expect(card).toBeVisible();

    const itemThumbnail = card.getByRole("button", { name: "View Item photo: Serial data plate" }).first();
    await expect(itemThumbnail).toBeVisible();
    await expect(card.getByRole("button", { name: "View Location photo: Upper shelf placement" }).first()).toBeVisible();
    await expect(card.getByRole("button", { name: "View Item photo: Complete radio set" }).first()).toBeVisible();

    const pageCount = page.context().pages().length;
    await itemThumbnail.click();
    expect(page.context().pages()).toHaveLength(pageCount);

    const viewer = page.getByRole("dialog", { name: "Evidence photo" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Item photo", { exact: true }).first()).toBeVisible();
    await expect(viewer.getByText("Serial data plate", { exact: true })).toBeVisible();
    await expect(viewer.getByText(scenario.note, { exact: true })).toBeVisible();
    await expect(viewer.getByText(scenario.requestMessage, { exact: true })).toBeVisible();
    await expect(viewer.getByText("Cage 7, upper shelf", { exact: true })).toBeVisible();
    await expect(viewer.getByText(scenario.serialNumber, { exact: true })).toBeVisible();
    const counter = viewer.locator(".proof-viewer-count");
    await expect(counter).toHaveText(/^[1-3] of 3$/);

    const mainImage = viewer.locator(".proof-viewer-image-scroll img");
    await expect(mainImage).toHaveAttribute("alt", new RegExp(`Item photo: Serial data plate for ${scenario.packetLine}`));
    await expect.poll(() => mainImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBeTruthy();

    const zoomButton = viewer.getByRole("button", { name: "Zoom photo" });
    await expect(zoomButton).toHaveAttribute("aria-pressed", "false");
    await zoomButton.click();
    await expect(viewer.getByRole("button", { name: "Fit photo" })).toHaveAttribute("aria-pressed", "true");
    await expect(viewer.locator(".proof-viewer-image-scroll")).toHaveClass(/zoomed/);

    const firstPosition = Number((await counter.textContent()).split(" ")[0]);
    await viewer.getByRole("button", { name: "Next photo" }).click();
    const secondPosition = firstPosition % 3 + 1;
    await expect(counter).toHaveText(`${secondPosition} of 3`);
    await expect(viewer.locator(".proof-viewer-image-scroll")).not.toHaveClass(/zoomed/);

    await page.keyboard.press("ArrowRight");
    await expect(counter).toHaveText(`${secondPosition % 3 + 1} of 3`);

    await viewer.getByRole("button", { name: "Show Location photo: Upper shelf placement" }).click();
    await expect(viewer.getByText("Location photo", { exact: true }).first()).toBeVisible();
    await expect(viewer.getByText("Upper shelf placement", { exact: true })).toBeVisible();

    const viewport = page.viewportSize();
    const viewerBox = await viewer.boundingBox();
    expect(viewerBox.x).toBeGreaterThanOrEqual(0);
    expect(viewerBox.y).toBeGreaterThanOrEqual(0);
    expect(viewerBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(viewerBox.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();

    const screenshotPath = testInfo.outputPath("proof-photo-viewer.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("proof-photo-viewer", { path: screenshotPath, contentType: "image/png" });

    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(itemThumbnail).toBeFocused();
  });
});
