import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

const PHOTO_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='180' viewBox='0 0 240 180'%3E%3Crect width='240' height='180' fill='%23dce8d8'/%3E%3Cpath d='M42 120h156v18H42zM70 52h100v60H70z' fill='%23376542'/%3E%3C/svg%3E";

function photo(id, caption) {
  return {
    id,
    url: PHOTO_URL,
    kind: "item",
    caption
  };
}

function equipmentFixture() {
  return {
    entries: [
      {
        key: "lin:63053N",
        displayName: "Cutting Machine Oxygen",
        lins: ["63053N"],
        nsns: ["3413-01-555-0198"],
        latestOutcome: "not_found",
        latestObservedAt: "2026-07-18T16:30:00.000Z",
        latestSessionName: "July inventory",
        latestSessionStatus: "active",
        lastFound: {
          locationText: "Motor pool, bay 4",
          observedAt: "2026-06-12T14:00:00.000Z",
          sessionName: "June inventory",
          sessionStatus: "closed",
          expectedQty: 1
        },
        locations: [
          {
            locationText: "Motor pool, bay 4",
            observedAt: "2026-06-12T14:00:00.000Z",
            sessionName: "June inventory",
            sessionStatus: "closed"
          },
          {
            locationText: "Cage 2, left wall",
            observedAt: "2026-05-07T13:00:00.000Z",
            sessionName: "May inventory",
            sessionStatus: "active"
          }
        ],
        photos: [
          photo("oxygen-1", "Data plate"),
          photo("oxygen-2", "Full equipment view"),
          photo("oxygen-3", "Storage position"),
          photo("oxygen-4", "Accessory case")
        ],
        photoContext: {
          sessionName: "June inventory",
          sessionStatus: "active",
          observedAt: "2026-06-12T14:00:00.000Z",
          locationText: "Motor pool, bay 4"
        },
        observationCount: 4,
        sessionCount: 3,
        savedAssetCount: 1
      },
      {
        key: "lin:G18358",
        displayName: "Field Generator",
        lins: ["G18358"],
        nsns: [],
        latestOutcome: "found",
        latestObservedAt: "2026-07-17T15:00:00.000Z",
        latestSessionName: "July inventory",
        latestSessionStatus: "active",
        lastFound: {
          locationText: "Generator shed",
          observedAt: "2026-07-17T15:00:00.000Z",
          sessionName: "July inventory",
          sessionStatus: "active",
          expectedQty: 2
        },
        locations: [],
        photos: [],
        photoContext: null,
        observationCount: 1,
        sessionCount: 1,
        savedAssetCount: 0
      }
    ],
    unlinkedActiveRows: [
      {
        id: "session-item-unmatched",
        sessionId: "session-july",
        sessionName: "July inventory",
        packetLine: "0000000099 GENERATOR FIELD SET UNKNOWN WORDING",
        expectedQty: 2
      }
    ],
    rememberedLinks: [
      {
        id: "remembered-old",
        sourcePacketLine: "OLD OXYGEN MACHINE WORDING",
        targetEntryKey: "lin:63053N",
        targetDisplayName: "Cutting Machine Oxygen",
        createdAt: "2026-07-01T12:00:00.000Z"
      }
    ],
    generatedAt: "2026-07-19T13:00:00.000Z"
  };
}

async function signIn(page, persona) {
  await page.goto(TENANT_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page.getByRole("heading", {
    name: persona === "NCO" ? "Inventory Dashboard" : "Leader Dashboard"
  })).toBeVisible();
}

async function openWorkspaceTab(page, name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  const tab = page.getByRole("button", { name, exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

test.describe("equipment library", () => {
  test("platoon admins can inspect approved history and maintain manual links", async ({ page }) => {
    const fixture = equipmentFixture();
    const postBodies = [];
    const deletedLinkIds = [];

    await page.route("**/api/inventory/equipment-library**", async route => {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname;

      if (method === "GET" && path.endsWith("/inventory/equipment-library")) {
        await fulfillJson(route, fixture);
        return;
      }

      if (method === "POST" && path.endsWith("/inventory/equipment-library/links")) {
        const body = request.postDataJSON();
        postBodies.push(body);
        fixture.unlinkedActiveRows = fixture.unlinkedActiveRows.filter(row => row.id !== body.sourceSessionItemId);
        fixture.rememberedLinks.push({
          id: "remembered-new",
          sourcePacketLine: "0000000099 GENERATOR FIELD SET UNKNOWN WORDING",
          targetEntryKey: body.targetEntryKey,
          targetDisplayName: "Field Generator",
          createdAt: "2026-07-19T14:00:00.000Z"
        });
        await fulfillJson(route, { link: fixture.rememberedLinks.at(-1) }, 201);
        return;
      }

      if (method === "DELETE" && path.includes("/inventory/equipment-library/links/")) {
        const linkId = decodeURIComponent(path.split("/").at(-1));
        deletedLinkIds.push(linkId);
        fixture.rememberedLinks = fixture.rememberedLinks.filter(link => link.id !== linkId);
        await fulfillJson(route, { ok: true });
        return;
      }

      await fulfillJson(route, { error: `Unexpected equipment library request: ${method} ${path}` }, 500);
    });

    await signIn(page, "Platoon admin");
    await openWorkspaceTab(page, "Equipment");

    await expect(page).toHaveURL(/#\/admin\/equipment$/);
    await expect(page.getByRole("heading", { name: "Equipment Library", exact: true })).toBeVisible();
    await expect(page.getByText("Automatically built from approved inventories.", { exact: false })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search equipment" })).toHaveAttribute(
      "placeholder",
      "Search equipment, LIN, NSN, or reported location..."
    );

    const oxygenCard = page.locator(".equipment-library-card", { hasText: "Cutting Machine Oxygen" });
    await expect(oxygenCard).toBeVisible();
    await expect(oxygenCard.getByText("LIN 63053N", { exact: false })).toBeVisible();
    await expect(oxygenCard.getByText("NSN 3413-01-555-0198", { exact: false })).toBeVisible();
    await expect(oxygenCard.getByText("Not found", { exact: true })).toBeVisible();
    await expect(oxygenCard.getByText("Last found", { exact: true })).toBeVisible();
    await expect(oxygenCard.getByText("Motor pool, bay 4", { exact: true })).toBeVisible();
    await expect(oxygenCard.getByText("Cage 2, left wall", { exact: true })).toBeVisible();
    await expect(oxygenCard.getByText("4 approved observations", { exact: true })).toBeVisible();
    await expect(oxygenCard.getByText("3 inventory sessions", { exact: true })).toBeVisible();
    await expect(oxygenCard.locator(".equipment-library-result-badges .equipment-open-inventory")).toHaveText("Open inventory");
    await expect(oxygenCard.locator(".equipment-last-found .equipment-open-inventory")).toHaveCount(0);
    const openPriorLocation = oxygenCard.locator(".equipment-prior-locations li", { hasText: "Cage 2, left wall" });
    await expect(openPriorLocation.locator(".equipment-open-inventory")).toHaveText("Open inventory");
    await expect(oxygenCard.getByRole("button", { name: /^View found photo/ })).toHaveCount(3);
    await expect(oxygenCard.getByRole("button", { name: /^(Add|Edit|Open)\b/i })).toHaveCount(0);

    const generatorCard = page.locator(".equipment-library-card", { hasText: "Field Generator" });
    await expect(generatorCard.locator(".equipment-last-found .equipment-open-inventory")).toHaveText("Open inventory");

    const firstPhoto = oxygenCard.getByRole("button", { name: "View found photo 1 for Cutting Machine Oxygen" });
    await firstPhoto.click();
    const viewer = page.getByRole("dialog", { name: "Equipment photo" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Approved found inventory", { exact: true })).toBeVisible();
    await expect(viewer.locator(".proof-viewer-source-line .equipment-open-inventory")).toHaveText("Open inventory");
    await expect(viewer.getByText("Motor pool, bay 4", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Close evidence viewer" }).click();
    await expect(viewer).toBeHidden();
    await expect(firstPhoto).toBeFocused();

    const unmatchedRow = page.locator(".equipment-exception-row", { hasText: "UNKNOWN WORDING" });
    await unmatchedRow.getByRole("button", { name: "Link to equipment" }).click();
    const linkDialog = page.getByRole("dialog", { name: "Link unmatched row" });
    await expect(linkDialog).toBeVisible();
    await linkDialog.getByLabel("Search equipment").fill("generator shed");
    const generatorChoice = linkDialog.getByRole("radio", { name: /Field Generator/ });
    await expect(generatorChoice).toBeVisible();
    await generatorChoice.check();
    await linkDialog.getByRole("button", { name: "Remember link" }).click();

    await expect(linkDialog).toBeHidden();
    await expect.poll(() => postBodies).toEqual([{
      sourceSessionItemId: "session-item-unmatched",
      targetEntryKey: "lin:G18358"
    }]);
    await expect(page.locator(".equipment-exception-row", { hasText: "UNKNOWN WORDING" })).toHaveCount(0);
    await expect(page.locator(".equipment-remembered-row", { hasText: "UNKNOWN WORDING" })).toBeVisible();

    const oldLink = page.locator(".equipment-remembered-row", { hasText: "OLD OXYGEN MACHINE WORDING" });
    await oldLink.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => deletedLinkIds).toEqual(["remembered-old"]);
    await expect(oldLink).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();

    await page.goBack();
    await expect(page).toHaveURL(/#\/admin$/);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });

  test("contributors cannot see or open the admin equipment library", async ({ page }) => {
    let equipmentRequestCount = 0;
    await page.route("**/api/inventory/equipment-library**", async route => {
      equipmentRequestCount += 1;
      await fulfillJson(route, { error: "Forbidden" }, 403);
    });

    await signIn(page, "NCO");
    const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await expect(page.getByRole("button", { name: "Equipment", exact: true })).toHaveCount(0);

    await page.goto(TENANT_URL.replace("#/admin", "#/admin/equipment"));
    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Equipment Library", exact: true })).toHaveCount(0);
    await expect.poll(() => equipmentRequestCount).toBe(0);
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });
});
