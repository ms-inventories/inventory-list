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
    await expect(pendingResults.getByText("Field Radio", { exact: true })).toBeVisible();
    await expect(dashboardReview.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();

    const dashboardSearch = page.getByRole("searchbox", { name: "Search dashboard" });
    await dashboardSearch.fill("left R20-684 radio");
    await expect(pendingResults.getByText("Field Radio", { exact: true })).toBeVisible();
    await expect(pendingResults.getByText("Quiet Generator", { exact: true })).toHaveCount(0);
    await dashboardSearch.fill("no-such-dashboard-row");
    await expect(pendingResults.getByText("No matching work", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(dashboardSearch).toBeFocused();
    await expect(pendingResults.getByText("Quiet Generator", { exact: true })).toBeVisible();

    await openWorkspaceTab(page, "Inventory Sessions");
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Guidance", exact: true })).toHaveCount(0);
    await expect(page.locator(".session-summary").getByText("Search behavior fixture", { exact: true })).toBeVisible();
    const sessionSearch = page.getByRole("searchbox", { name: "Search current session rows" });
    await expect(sessionSearch).toHaveValue("");
    await sessionSearch.fill("battery SEARCH-SERIAL-20-684");
    const sessionResults = page.getByRole("region", { name: "Session row results" });
    await expect(sessionResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();
    await expect(sessionResults.getByText(/G18358 GENERATOR SET SEARCH FIXTURE/)).toHaveCount(0);
    const assignmentLists = page.getByRole("group", { name: "Work assignment lists" });
    await assignmentLists.getByRole("button", { name: /Team/ }).click();
    await expect(sessionResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toHaveCount(0);
    await assignmentLists.getByRole("button", { name: /Available/ }).click();
    await expect(sessionResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(sessionSearch).toHaveValue("");
    await expect(sessionResults.getByText(/G18358 GENERATOR SET SEARCH FIXTURE/)).toBeVisible();

    await openWorkspaceTab(page, "Review Queue");
    await expect(page.getByRole("heading", { name: "Review Queue" })).toBeVisible();
    const reviewSearch = page.getByRole("searchbox", { name: "Search review queue" });
    await expect(reviewSearch).toHaveValue("");
    await reviewSearch.fill("battery search-serial-20684");
    const reviewResults = page.getByRole("region", { name: "Review queue results" });
    await expect(reviewResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toBeVisible();
    await reviewSearch.fill("missing-review-result");
    await expect(reviewResults.getByText("No matching review work", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();

    await openWorkspaceTab(page, "People & Invites");
    await expect(page.getByRole("heading", { name: "People & invites" })).toBeVisible();
    const peoplePanel = page.locator(".people-panel");
    await expect(peoplePanel.getByRole("heading", { name: "Why you can access this platoon" })).toHaveCount(0);
    await expect(peoplePanel.getByText("Expected groups", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.getByText("Matched groups", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.getByText("Authentik", { exact: true })).toHaveCount(0);
    await expect(peoplePanel.locator("code").filter({ hasText: /^876en-/ })).toHaveCount(0);
    const peopleSearch = page.getByRole("searchbox", { name: "Search people and invitations" });
    await expect(peopleSearch).toHaveValue("");
    await peopleSearch.fill("qa search helper contributor");
    const peopleResults = page.getByRole("region", { name: "People results" });
    await expect(peopleResults.getByText("QA Search Helper", { exact: true })).toBeVisible();
    await expect(peopleResults.getByText("QA Search Admin", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();

    await openWorkspaceTab(page, "Reports");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const reportSearch = page.getByRole("searchbox", { name: "Search reports" });
    await expect(reportSearch).toHaveValue("");
    await reportSearch.fill("connex G18-358");
    const reportResults = page.getByRole("region", { name: "Report results" });
    await expect(reportResults.getByText(/G18358 GENERATOR SET SEARCH FIXTURE/)).toBeVisible();
    await expect(reportResults.getByText(/R20684 RADIO SET SEARCH FIXTURE/)).toHaveCount(0);

    await expect(page.locator(".leader-nav").getByText("Inventory Guidance", { exact: true })).toHaveCount(0);
    await openWorkspaceTab(page, "Workspace Settings");
    await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);

    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  });
});
