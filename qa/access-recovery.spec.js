import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";

const qaNco = {
  sub: "qa-nco",
  email: "qa-nco@876en.test",
  name: "QA NCO",
  groups: ["876en-ms"]
};

async function seedQaSession(page) {
  await page.addInitScript(identity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, qaNco);
}

test("a signed-in non-admin can recover from the platform access screen", async ({ page }, testInfo) => {
  await seedQaSession(page);
  await page.goto(ADMIN_URL);

  const emptyState = page.locator(".admin-empty");
  await expect(emptyState.getByText("Platform access required", { exact: true })).toBeVisible();
  const chooseWorkspace = emptyState.getByRole("link", { name: "Choose workspace", exact: true });
  await expect(chooseWorkspace).toHaveAttribute("href", "/#/launch");

  if (testInfo.project.use.isMobile) {
    const box = await chooseWorkspace.boundingBox();
    expect(box?.height || 0).toBeGreaterThanOrEqual(44);
  }

  await chooseWorkspace.click();
  await expect(page).toHaveURL(/#\/launch|ms\.localhost/);
});
