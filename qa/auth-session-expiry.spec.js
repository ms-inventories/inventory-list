import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";

test("an unauthorized API response clears the rejected browser session", async ({ page }) => {
  await page.route("**/api/me**", route => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({
      error: "Authentication required",
      code: "token_rejected"
    })
  }));

  await page.addInitScript(() => {
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "rejected-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now()
    }));
  });

  await page.goto(TENANT_URL);

  await expect(page.getByText("Your sign-in expired. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Authentik" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("inventory.auth.session"))).toBeNull();
});
