import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.QA_FRONTEND_URL || "http://localhost:5175";
const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const NEWSLETTER_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";
const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

test.describe("QA smoke", () => {
  test("public landing page shows FRG content and portal entry", async ({ page }) => {
    await page.goto(FRONTEND_URL);

    await expect(page.getByRole("heading", { name: "Black Shadow Company", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get updates" })).toBeVisible();
    const loginMenu = page.locator("summary").filter({ hasText: "Login" });
    await expect(loginMenu).toBeVisible();

    await loginMenu.click();
    await expect(page.getByRole("link", { name: /Member portal/ })).toBeVisible();
  });

  test("platform root admin can reach platoon management", async ({ page }) => {
    await page.goto(ADMIN_URL);
    await signInWithQaPersona(page, "Root admin");

    await expect(page.getByRole("heading", { name: "Platoons" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create platoon" }).first()).toBeVisible();
    await expect(page.getByText("ms.localhost").first()).toBeVisible();
    await expect(page.getByText("Super administrator")).toBeVisible();
  });

  test("newsletter admin can reach newsletter workspace", async ({ page }) => {
    await page.goto(NEWSLETTER_URL);
    await signInWithQaPersona(page, "Newsletter admin");

    await expect(page.getByRole("heading", { name: "Public content", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New block" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Family readiness updates" })).toBeVisible();

    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Newsletter issues", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New issue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Black Shadow QA Update" })).toBeVisible();

    await page.getByRole("button", { name: "Subscribers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Subscribers", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("Approved subscribers", { exact: true }).first()).toBeVisible();
  });

  test("platoon admin sees leader dashboard and admin-only controls", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start new inventory" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload packet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Queue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "People & Invites" })).toBeVisible();
  });

  test("platoon admin can open and review packet upload rows", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await page.getByRole("button", { name: "Upload packet" }).click();

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Session", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Source", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Review", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    await dialog.locator("textarea").fill([
      "000009148 R20684 RADIAC SET: AN/VDR-2 OH Qty 1",
      "0000005550 B67766 BINOCULAR: MODULAR CONSTRUCTION MIL SCAL OH Qty 5"
    ].join("\n"));
    await dialog.getByRole("button", { name: "Review rows" }).click();

    await expect(dialog.getByRole("heading", { name: "Review before saving" })).toBeVisible();
    await expect(dialog.getByText("ready to import")).toBeVisible();
    await expect(dialog.locator("textarea").first()).toHaveValue(/R20684 RADIAC SET/);
  });

  test("contributor reaches workspace without leader-only navigation", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "NCO");

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByText("Contributor")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inventory Sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Queue" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "People & Invites" })).toHaveCount(0);
  });
});
