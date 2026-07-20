import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaPlatoonAdmin = {
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

async function seedQaTenantSession(page, identity = qaPlatoonAdmin) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

async function openTenant(page, identity = qaPlatoonAdmin) {
  await seedQaTenantSession(page, identity);
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: identity === qaPlatoonAdmin ? "Leader Dashboard" : "Inventory Dashboard" })).toBeVisible();
}

test.describe("Tenant notifications", () => {
  test("bell opens a notification panel with useful workspace actions", async ({ page }) => {
    await openTenant(page);

    await page.getByRole("button", { name: "Notifications" }).click();

    const panel = page.getByRole("region", { name: "Notifications" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Notifications", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Refresh alerts" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Open sessions" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Open review queue" })).toBeVisible();

    await panel.getByRole("button", { name: "Open sessions" }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Open review queue" }).click();
    await expect(page.getByRole("region", { name: "Review queue", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Review queue", exact: true })).toBeVisible();
  });

  test("rejections kept with the submitter open the exact assigned session item", async ({ page, request }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    const sessionName = `QA notification ${suffix}`;
    const packetLine = `QA-NOTIFICATION-${suffix.toUpperCase()}`;
    const requestNote = `Show the serial plate for ${suffix}.`;
    let sessionId = "";

    try {
      const sessionData = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
        headers: qaHeaders(qaPlatoonAdmin),
        data: { name: sessionName, status: "active" }
      }));
      sessionId = sessionData.session.id;
      const itemData = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionId}/items`, {
        headers: qaHeaders(qaPlatoonAdmin),
        data: { packetLine, expectedQty: 1 }
      }));
      const members = await responseJson(await request.get(`${API_URL}/tenant/members`, {
        headers: qaHeaders(qaPlatoonAdmin)
      }));
      const ncoMember = members.members.find(member => member.email === qaNco.email);
      expect(ncoMember?.id).toBeTruthy();
      await responseJson(await request.patch(`${API_URL}/session-items/${itemData.sessionItem.id}/assignment`, {
        headers: qaHeaders(qaPlatoonAdmin),
        data: { memberId: ncoMember.id }
      }));
      const submission = await responseJson(await request.post(`${API_URL}/session-items/${itemData.sessionItem.id}/submissions`, {
        headers: qaHeaders(qaNco),
        data: { status: "not_found", note: `Initial check for ${suffix}` }
      }));
      await responseJson(await request.patch(`${API_URL}/submissions/${submission.submission.id}/review`, {
        headers: qaHeaders(qaPlatoonAdmin),
        data: { decision: "rejected", note: requestNote, returnAssignment: "submitter" }
      }));

      await openTenant(page, qaNco);
      await page.getByRole("button", { name: /^Notifications/ }).click();
      const notification = page.locator(".leader-notification-item", { hasText: requestNote });
      await expect(notification).toBeVisible();
      await notification.click();

      await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
      await expect(page.locator(".session-summary").getByText(sessionName, { exact: true })).toBeVisible();
      const returnedItem = page.locator(".session-item", { hasText: packetLine });
      await expect(returnedItem).toBeVisible();
      await expect(returnedItem.locator(".session-proof-request", { hasText: requestNote }).first()).toBeVisible();
      await expect(returnedItem.getByRole("button", { name: "Respond", exact: true })).toBeVisible();
    } finally {
      if (sessionId) {
        await request.patch(`${API_URL}/inventory/sessions/${sessionId}`, {
          headers: qaHeaders(qaPlatoonAdmin),
          data: { status: "closed" }
        });
      }
    }
  });
});
