import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const LAUNCH_URL = process.env.QA_LAUNCH_URL || "http://localhost:5175/#/launch";

const qaPlatoonAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

async function seedQaSessionBeforeLoad(page, identity = qaPlatoonAdmin) {
  await page.addInitScript(qaIdentity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(qaIdentity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

test.describe("API failure states", () => {
  test("tenant auth screen explains API routing failures without raw fetch copy", async ({ page }) => {
    await page.route("**/api/me**", route => route.abort("failed"));
    await seedQaSessionBeforeLoad(page);
    await page.goto(TENANT_URL);

    await expect(page.getByText("Could not reach the inventory API. Try again, or ask an admin to check API routing if this keeps happening.")).toBeVisible();
    await expect(page.getByText("Failed to fetch")).toHaveCount(0);
  });

  test("launcher explains API routing failures without raw fetch copy", async ({ page }) => {
    await page.route("**/api/me**", route => route.abort("failed"));
    await seedQaSessionBeforeLoad(page);
    await page.goto(LAUNCH_URL);

    await expect(page.getByRole("heading", { name: "Opening workspace" })).toBeVisible();
    await expect(page.getByText("Could not reach the inventory API. Try again, or ask an admin to check API routing if this keeps happening.")).toBeVisible();
    await expect(page.getByText("Failed to fetch")).toHaveCount(0);
  });
});
