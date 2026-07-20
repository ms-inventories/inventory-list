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

async function createPriorHistoryScenario(request, projectName) {
  const suffix = `${projectName.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const lin = `R${String(Date.now()).slice(-4)}Y`;
  const itemName = `PHOTO RECOVERY RADIO ${suffix.toUpperCase()}`;
  const history = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: `QA prior photo ${suffix}`, status: "active" }
  }));
  const historyItem = await responseJson(await request.post(`${API_URL}/inventory/sessions/${history.session.id}/items`, {
    headers: qaHeaders(qaAdmin),
    data: { packetLine: `000000001 ${lin} ${itemName}`, expectedQty: 1 }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${historyItem.sessionItem.id}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));
  const upload = await responseJson(await request.post(`${API_URL}/uploads/photos`, {
    headers: qaHeaders(qaNco),
    data: {
      fileName: `prior-photo-${suffix}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: PHOTO_DATA_URL,
      caption: "Previous inventory radio",
      kind: "general"
    }
  }));
  const submission = await responseJson(await request.post(
    `${API_URL}/session-items/${historyItem.sessionItem.id}/submissions`,
    {
      headers: qaHeaders(qaNco),
      data: {
        status: "found",
        locationText: "Cage 4, left shelf",
        photos: [{
          uploadId: upload.photo.uploadId,
          caption: upload.photo.caption,
          kind: upload.photo.kind
        }]
      }
    }
  ));
  await responseJson(await request.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
    headers: qaHeaders(qaAdmin),
    data: { decision: "approved", saveItem: false }
  }));
  await responseJson(await request.patch(`${API_URL}/inventory/sessions/${history.session.id}`, {
    headers: qaHeaders(qaAdmin),
    data: { status: "closed" }
  }));

  const active = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(qaAdmin),
    data: { name: `QA active photo ${suffix}`, status: "active" }
  }));
  const activeItem = await responseJson(await request.post(`${API_URL}/inventory/sessions/${active.session.id}/items`, {
    headers: qaHeaders(qaAdmin),
    data: { packetLine: `000000099 ${lin} ${itemName}`, expectedQty: 1 }
  }));
  await responseJson(await request.patch(`${API_URL}/session-items/${activeItem.sessionItem.id}/assignment`, {
    headers: qaHeaders(qaNco),
    data: { memberId: "self" }
  }));

  return {
    activeSessionId: active.session.id,
    activeSessionName: active.session.name,
    itemName
  };
}

async function signInAsNco(page) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "NCO" }).click();
  await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pending inventory results" })).toHaveCount(0);
}

async function openSession(page, sessionName) {
  const activeInventory = page.getByRole("region", { name: "Active inventory" });
  const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
  await expect(selector).toBeVisible();
  await selector.selectOption({ label: sessionName });
  await activeInventory.getByRole("button", { name: "Open inventory", exact: true }).click();
  await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
  await expect(page.locator(".session-summary", { hasText: sessionName })).toBeVisible();
}

test.describe("protected history images", () => {
  test("renews an expired photo session once and replaces terminal failures cleanly", async ({ page, request, context }, testInfo) => {
    test.setTimeout(90_000);
    const scenario = await createPriorHistoryScenario(request, testInfo.project.name);
    await signInAsNco(page);
    const hiddenSessionItemsStyle = await page.addStyleTag({
      content: ".session-item { display: none !important; }"
    });
    await openSession(page, scenario.activeSessionName);

    const workspace = page.getByRole("region", { name: "Inventory workspace" });
    const tabs = workspace.getByRole("group", { name: "Work assignment lists" });
    await tabs.getByRole("button", { name: /^Unclaimed\b/ }).click();
    await expect.poll(async () => (await context.cookies()).some(cookie => cookie.name === "inventory_media_ms")).toBeTruthy();
    const mediaCookie = (await context.cookies()).find(cookie => cookie.name === "inventory_media_ms");
    await context.addCookies([{
      name: mediaCookie.name,
      value: "expired-photo-session",
      domain: mediaCookie.domain,
      path: mediaCookie.path,
      httpOnly: true,
      secure: mediaCookie.secure,
      sameSite: mediaCookie.sameSite,
      expires: Math.floor(Date.now() / 1000) + 60
    }]);

    let renewalRequests = 0;
    page.on("request", requestEvent => {
      if (requestEvent.method() === "POST" && new URL(requestEvent.url()).pathname === "/api/media/session") {
        renewalRequests += 1;
      }
    });

    await hiddenSessionItemsStyle.evaluate(element => element.remove());
    await tabs.getByRole("button", { name: /^Mine\b/ }).click();
    const row = workspace.locator(".session-item", { hasText: scenario.itemName });
    await expect(row).toBeVisible();
    await expect(row.locator(".prior-inventory-snapshot")).toBeVisible();
    const images = row.locator("img[data-media-state]");
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(elements => elements.every(image => (
      image.dataset.mediaState === "ready"
      && image.complete
      && image.naturalWidth > 0
      && image.src.includes("media_retry=")
    )))).toBeTruthy();
    await expect.poll(() => renewalRequests).toBe(1);

    await row.getByRole("button", { name: "View previous inventory photo 1" }).click();
    const viewer = page.getByRole("dialog", { name: "Evidence photo" });
    const viewerImage = viewer.locator("img[data-media-state]");
    await expect(viewerImage).toBeVisible();
    await expect.poll(() => viewerImage.evaluate(image => (
      image.dataset.mediaState === "ready" && image.complete && image.naturalWidth > 0
    ))).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();

    await page.waitForTimeout(2_100);
    await page.route("**/media/tenants/ms/**", route => route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Photo unavailable" })
    }));
    await tabs.getByRole("button", { name: /^Unclaimed\b/ }).click();
    await expect(row).toBeHidden();
    await tabs.getByRole("button", { name: /^Mine\b/ }).click();
    const unavailableImages = workspace.locator(".session-item", { hasText: scenario.itemName }).locator("img[data-media-state]");
    await expect(unavailableImages).toHaveCount(2);
    await expect.poll(() => unavailableImages.evaluateAll(elements => elements.every(image => (
      image.dataset.mediaState === "unavailable"
      && image.complete
      && image.naturalWidth > 0
      && image.src.startsWith("data:image/svg+xml")
    )))).toBeTruthy();
    await expect.poll(() => renewalRequests).toBe(2);
    await page.waitForTimeout(500);
    expect(renewalRequests).toBe(2);

    await responseJson(await request.patch(`${API_URL}/inventory/sessions/${scenario.activeSessionId}`, {
      headers: qaHeaders(qaAdmin),
      data: { status: "closed" }
    }));
  });
});
