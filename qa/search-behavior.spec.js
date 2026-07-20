import { expect, test } from "@playwright/test";

async function signIn(page, tenantSlug) {
  await page.goto(`http://${tenantSlug}.localhost:5175/#/admin`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Root admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
}

async function openWorkspaceTab(page, name) {
  const mobileMenu = page.getByRole("button", { name: "Open workspace menu" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  const tab = page.getByRole("button", { name, exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
}

test.describe("page-scoped search", () => {
  test("filters the loaded workspace collection with consistent normalized terms", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const tenantSlug = testInfo.project.name === "mobile-chrome" ? "qa-search-mobile" : "qa-search-desktop";
    await signIn(page, tenantSlug);

    const pendingResults = page.getByRole("region", { name: "Pending inventory results" });
    const dashboardReview = page.getByRole("region", { name: "Dashboard review results" });
    await expect(pendingResults).toBeHidden();
    await expect(dashboardReview.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();
    const sessionSearch = page.getByRole("searchbox", { name: "Search inventory items" });
    await expect(sessionSearch).toHaveValue("");

    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const activeInventorySelector = activeInventory.getByRole("combobox", { name: "Active inventory" });
    const singleInventoryHeading = activeInventory.getByRole("heading", { name: "Search behavior fixture", exact: true });
    await expect.poll(async () => {
      if (await activeInventorySelector.isVisible()) return "selector";
      if (await singleInventoryHeading.isVisible()) return "heading";
      return "loading";
    }).not.toBe("loading");
    if (await activeInventorySelector.isVisible()) {
      await activeInventorySelector.selectOption({ label: "Search behavior fixture" });
      await expect(activeInventorySelector.locator("option:checked")).toHaveText("Search behavior fixture");
    } else {
      await expect(singleInventoryHeading).toBeVisible();
    }
    await expect(page.getByRole("region", { name: "Inventory workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Work queue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Guidance", exact: true })).toHaveCount(0);
    await expect(sessionSearch).toHaveValue("");
    await sessionSearch.fill("battery SEARCH-SERIAL-20-684");
    const sessionResults = page.getByRole("region", { name: "Inventory items" });
    const radioSessionRow = sessionResults.locator(".session-item", { hasText: "Field Radio" });
    await expect(radioSessionRow.locator(".session-item-main > div > strong")).toHaveText("Field Radio");
    await expect(sessionResults.getByText("Quiet Generator", { exact: true })).toHaveCount(0);
    const assignmentLists = page.getByRole("group", { name: "Work assignment lists" });
    const unclaimedList = assignmentLists.getByRole("button", { name: /^Unclaimed\b/ });
    const othersList = assignmentLists.getByRole("button", { name: /^Others\b/ });
    await expect(unclaimedList).toHaveAttribute("aria-pressed", "true");
    await expect(othersList).toHaveAttribute("aria-pressed", "false");
    await othersList.click();
    await expect(othersList).toHaveAttribute("aria-pressed", "true");
    await expect(sessionResults.getByText("Field Radio", { exact: true })).toHaveCount(0);
    await unclaimedList.click();
    await expect(radioSessionRow.locator(".session-item-main > div > strong")).toHaveText("Field Radio");
    await expect(radioSessionRow.getByText("Needs review", { exact: true })).toBeVisible();
    await expect(radioSessionRow.getByText("needs_review", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(sessionSearch).toHaveValue("");
    const generatorSessionRow = sessionResults.locator(".session-item", { hasText: "Quiet Generator" });
    await expect(generatorSessionRow.locator(".session-item-main > div > strong")).toHaveText("Quiet Generator");
    await sessionSearch.fill("quiet generator");

    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: "Open review queue", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "Review queue", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Review queue", exact: true })).toBeVisible();
    const reviewSearch = page.getByRole("searchbox", { name: "Search review queue" });
    await expect(reviewSearch).toHaveValue("");
    await reviewSearch.fill("battery search-serial-20684");
    const reviewResults = page.getByRole("region", { name: "Review queue results" });
    await expect(reviewResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();
    await reviewSearch.fill("missing-review-result");
    await expect(reviewResults.getByText("No matching review work", { exact: true })).toBeVisible();
    await reviewResults.getByRole("button", { name: "Clear search" }).click();
    await expect(reviewSearch).toBeFocused();
    await expect(reviewResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();

    await page.getByRole("dialog", { name: "Review queue", exact: true })
      .getByRole("button", { name: "Close review", exact: true })
      .click();
    await expect(page.getByRole("searchbox", { name: "Search inventory items" })).toHaveValue("");
    await expect(dashboardReview.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();

    await openWorkspaceTab(page, "Team");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    const peoplePanel = page.locator(".people-panel");
    await expect(peoplePanel.getByRole("heading", { name: "Why you can access this platoon" })).toHaveCount(0);
    await expect(peoplePanel.getByText("Expected groups", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.getByText("Matched groups", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.getByText("Authentik", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.locator("code").filter({ hasText: /^876en-/ })).toHaveCount(0);
    const peopleSearch = page.getByRole("searchbox", { name: "Search teammates" });
    await expect(peopleSearch).toHaveValue("");
    await peopleSearch.fill("qa search helper contributor");
    const peopleResults = page.getByRole("region", { name: "People results" });
    await expect(peopleResults.getByText("QA Search Helper", { exact: true })).toBeVisible();
    await expect(peopleResults.getByText("QA Search Admin", { exact: true })).toHaveCount(0);
    await peopleSearch.fill("query must not carry into review");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: "Open review queue", exact: true })
      .click();
    await expect(page.getByRole("searchbox", { name: "Search review queue" })).toHaveValue("");
    await page.getByRole("dialog", { name: "Review queue", exact: true })
      .getByRole("button", { name: "Close review", exact: true })
      .click();

    await openWorkspaceTab(page, "Reports");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const reportSearch = page.getByRole("searchbox", { name: "Search reports" });
    await expect(reportSearch).toHaveValue("");
    await reportSearch.fill("connex G18-358");
    const reportResults = page.getByRole("table", { name: "Report results" });
    await expect(reportResults.getByRole("row", { name: /G18358 GENERATOR SET SEARCH FIXTURE/ })).toBeVisible();
    await expect(reportResults.getByRole("row", { name: /R20684 RADIO SET SEARCH FIXTURE/ })).toHaveCount(0);

    await expect(page.locator(".leader-nav").getByText("Inventory Guidance", { exact: true })).toHaveCount(0);
    await openWorkspaceTab(page, "Workspace Settings");
    await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);

    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  });
});
