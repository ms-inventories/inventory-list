import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

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

function testSuffix(testInfo, label) {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${label}-${project}-${testInfo.workerIndex}-${Date.now()}`;
}

function syntheticPlatformAdmin(suffix) {
  return {
    sub: `qa-claim-root-${suffix}`,
    email: `qa-claim-root-${suffix}@876en.test`,
    name: `QA Claim Root ${suffix}`,
    groups: ["876en-admins"]
  };
}

async function createSessionItem(request, identity, suffix) {
  const sessionData = await responseJson(await request.post(`${API_URL}/inventory/sessions`, {
    headers: qaHeaders(identity),
    data: { name: `QA claim ${suffix}`, status: "active" }
  }));
  const itemData = await responseJson(await request.post(`${API_URL}/inventory/sessions/${sessionData.session.id}/items`, {
    headers: qaHeaders(identity),
    data: { packetLine: `QA-CLAIM-${suffix.toUpperCase()}`, expectedQty: 1 }
  }));

  return {
    sessionId: sessionData.session.id,
    sessionItemId: itemData.sessionItem.id
  };
}

async function sessionItem(request, scenario, identity = qaAdmin) {
  const detail = await responseJson(await request.get(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
    headers: qaHeaders(identity)
  }));
  return detail.items.find(item => item.id === scenario.sessionItemId);
}

async function closeSession(request, scenario, identity) {
  if (!scenario?.sessionId) return;
  await request.patch(`${API_URL}/inventory/sessions/${scenario.sessionId}`, {
    headers: qaHeaders(identity),
    data: { status: "closed" }
  });
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

test.describe("session claim API", () => {
  test("resolves a synthetic platform membership self claim to the authenticated user", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "synthetic");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);
    const me = await responseJson(await request.get(`${API_URL}/me`, {
      headers: qaHeaders(platformAdmin)
    }));

    expect(me.membership.id).toBe("authentik:ms:platform-admin");
    expect(me.membership.user_id).toBe(me.user.id);

    const claim = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(platformAdmin),
      data: { memberId: "self" }
    }));

    expect(claim.assignment.assignedTo).toBe(me.user.id);
    expect(claim.assignment.assignedToEmail).toBe(platformAdmin.email);
    expect(claim.assignment.assignedToName).toBe(platformAdmin.name);

    const saved = await sessionItem(request, scenario, platformAdmin);
    expect(saved.assignedTo).toBe(me.user.id);
    expect(saved.assignedToEmail).toBe(platformAdmin.email);
    await closeSession(request, scenario, platformAdmin);
  });

  test("preserves the first owner when another user tries to self claim", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "conflict");
    const scenario = await createSessionItem(request, qaAdmin, suffix);
    const challenger = syntheticPlatformAdmin(`${suffix}-challenger`);

    const firstClaim = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: "self" }
    }));
    expect(firstClaim.assignment.assignedToEmail).toBe(qaNco.email);

    const conflictingClaim = await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(challenger),
      data: { memberId: "self" }
    });
    expect(conflictingClaim.status()).toBe(409);
    expect(await conflictingClaim.json()).toMatchObject({
      code: "conflict",
      error: "This row is already assigned to another user."
    });

    const saved = await sessionItem(request, scenario);
    expect(saved.assignedTo).toBe(firstClaim.assignment.assignedTo);
    expect(saved.assignedToEmail).toBe(qaNco.email);
    await closeSession(request, scenario, qaAdmin);
  });

  test("keeps UUID reassignment admin-only while owners can release their item", async ({ request }, testInfo) => {
    const suffix = testSuffix(testInfo, "authorization");
    const scenario = await createSessionItem(request, qaAdmin, suffix);
    const memberData = await responseJson(await request.get(`${API_URL}/tenant/members`, {
      headers: qaHeaders(qaAdmin)
    }));
    const ncoMember = memberData.members.find(member => member.email === qaNco.email);
    const adminMember = memberData.members.find(member => member.email === qaAdmin.email);
    expect(ncoMember?.id).toBeTruthy();
    expect(adminMember?.id).toBeTruthy();

    const assigned = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaAdmin),
      data: { memberId: ncoMember.id }
    }));
    expect(assigned.assignment.assignedToEmail).toBe(qaNco.email);

    const contributorClear = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: null }
    }));
    expect(contributorClear.assignment.assignedTo).toBeNull();
    expect(contributorClear.assignment.assignedToEmail).toBeNull();

    const contributorReassign = await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaNco),
      data: { memberId: adminMember.id }
    });
    expect(contributorReassign.status()).toBe(403);
    expect(await contributorReassign.json()).toMatchObject({ code: "access_denied" });

    const released = await sessionItem(request, scenario);
    expect(released.assignedTo).toBeNull();
    expect(released.assignedToEmail).toBeNull();

    const cleared = await responseJson(await request.patch(`${API_URL}/session-items/${scenario.sessionItemId}/assignment`, {
      headers: qaHeaders(qaAdmin),
      data: { memberId: null }
    }));
    expect(cleared.assignment.assignedTo).toBeNull();
    expect(cleared.assignment.assignedToEmail).toBeNull();
    await closeSession(request, scenario, qaAdmin);
  });

  test("synthetic users can claim from the UI and continue directly into proof", async ({ page, request }, testInfo) => {
    const suffix = testSuffix(testInfo, "ui");
    const platformAdmin = syntheticPlatformAdmin(suffix);
    const scenario = await createSessionItem(request, platformAdmin, suffix);

    try {
      await seedBrowserIdentity(page, platformAdmin);
      await page.goto("http://ms.localhost:5175/#/admin");
      await page.getByRole("heading", { name: "Leader Dashboard" }).waitFor();

      const activeInventory = page.getByRole("region", { name: "Active inventory" });
      const selector = activeInventory.getByRole("combobox", { name: "Active inventory" });
      await selector.selectOption(scenario.sessionId);
      await activeInventory.getByRole("button", { name: "Open session" }).click();

      const row = page.locator(".session-item", { hasText: `QA-CLAIM-${suffix.toUpperCase()}` });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /Open details for/ }).click();
      const drawer = page.getByRole("dialog", { name: `QA-CLAIM-${suffix.toUpperCase()}` });
      await drawer.getByRole("button", { name: "Claim item" }).click();

      await expect(drawer.getByRole("status")).toContainText("Item claimed.");
      await expect(row.locator(".proof-form")).toHaveCount(0);
      const proofForm = drawer.locator(".proof-form");
      await expect(proofForm).toBeVisible();
      const foundOutcome = proofForm.getByRole("button", { name: "Found", exact: true });
      const missingOutcome = proofForm.getByRole("button", { name: "Not found", exact: true });
      await expect(foundOutcome).toHaveAttribute("aria-pressed", "true");
      await missingOutcome.click();
      await expect(missingOutcome).toHaveAttribute("aria-pressed", "true");
      await expect(foundOutcome).toHaveAttribute("aria-pressed", "false");
      await expect(proofForm.getByRole("textbox", { name: "Location" })).toBeVisible();
      await expect(proofForm.getByRole("textbox", { name: "Serial number" })).toBeVisible();
      await expect(proofForm.getByRole("textbox", { name: "Note" })).toBeVisible();
      const photoInput = proofForm.getByLabel("Add proof photos");
      await expect(photoInput).toBeEnabled();
      await expect(photoInput).toHaveAttribute("multiple", "");
      const drawerBeforePhotos = await drawer.boundingBox();
      const photoNames = [1, 2, 3].map(index =>
        `proof-photo-${index}-with-an-intentionally-long-filename-that-must-not-expand-the-item-drawer.jpg`
      );
      await photoInput.setInputFiles(photoNames.map(name => ({
        name,
        mimeType: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
      })));
      const selectedPhotos = proofForm.getByRole("list", { name: "Selected proof photos" });
      await expect(selectedPhotos.getByRole("listitem")).toHaveCount(3);
      await expect(proofForm.getByLabel("Add another proof photo")).toBeDisabled();
      for (const name of photoNames) {
        await expect(proofForm.getByText(name, { exact: true })).toBeVisible();
      }
      const viewport = page.viewportSize();
      const drawerBox = await drawer.boundingBox();
      expect(Math.abs(drawerBox.x - drawerBeforePhotos.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(drawerBox.y - drawerBeforePhotos.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(drawerBox.width - drawerBeforePhotos.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(drawerBox.height - drawerBeforePhotos.height)).toBeLessThanOrEqual(1);
      expect(drawerBox.x).toBeGreaterThanOrEqual(0);
      expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(drawerBox.y).toBeGreaterThanOrEqual(0);
      expect(drawerBox.y + drawerBox.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      expect(await proofForm.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )).toBeTruthy();
      await expect(page.getByRole("group", { name: "Work assignment lists" }).getByRole("button", { name: /^Mine\b/ })).toHaveClass(/active/);
      await expect(page.getByText("Validation failed", { exact: true })).toHaveCount(0);

      const saved = await sessionItem(request, scenario, platformAdmin);
      expect(saved.assignedToEmail).toBe(platformAdmin.email);
    } finally {
      await closeSession(request, scenario, platformAdmin);
    }
  });
});
