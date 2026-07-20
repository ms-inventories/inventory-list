import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

const qaRootAdmin = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Root Admin",
  groups: ["876en-admins"]
};

async function seedQaRootSession(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaRootAdmin);
}

async function openTenantView(page, name) {
  const toggle = page.getByRole("button", { name: "Open workspace menu", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function expectPassiveLabel(locator) {
  await expect(locator).toBeVisible();
  const appearance = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      tagName: element.tagName,
      role: element.getAttribute("role"),
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      cursor: style.cursor
    };
  });

  expect(["BUTTON", "A"]).not.toContain(appearance.tagName);
  expect(appearance.role).not.toBe("button");
  expect(appearance.borderTopWidth).toBe("0px");
  expect(appearance.borderRadius).toBe("0px");
  expect(appearance.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(appearance.boxShadow).toBe("none");
  expect(appearance.cursor).not.toBe("pointer");
}

test.describe("passive label affordances", () => {
  test("Reports uses flat status text while its filters remain real controls", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard", exact: true })).toBeVisible();
    await openTenantView(page, "Reports");

    await expectPassiveLabel(page.locator(".reports-breakdown span").first());
    await page.locator("body").evaluate(body => {
      const status = document.createElement("span");
      status.className = "status-pill approved";
      status.dataset.testid = "passive-status-fixture";
      status.textContent = "Approved";
      body.appendChild(status);
    });
    await expectPassiveLabel(page.getByTestId("passive-status-fixture"));

    const filters = page.getByRole("group", { name: "Proof status and outcome filters" });
    const allResults = filters.getByRole("button", { name: /^All\b/ });
    await expect(allResults).toBeVisible();
    await expect(allResults).toHaveAttribute("aria-pressed", "true");
    const filterBox = await allResults.boundingBox();
    expect(filterBox.height).toBeGreaterThanOrEqual(44);
  });

  test("Team and platform summaries no longer present passive counts and states as buttons", async ({ page }) => {
    await seedQaRootSession(page);
    await page.goto(TENANT_URL);
    await expect(page.getByRole("heading", { name: "Leader Dashboard", exact: true })).toBeVisible();
    await openTenantView(page, "Team");
    await expectPassiveLabel(page.locator(".team-count"));
    const teamStatus = page.locator(".status-pill").first();
    if (await teamStatus.count()) await expectPassiveLabel(teamStatus);

    await page.goto(ADMIN_URL);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    const platformStatus = page.locator(".platform-platoon-card .status-pill").first();
    if (await platformStatus.count()) await expectPassiveLabel(platformStatus);
  });
});
