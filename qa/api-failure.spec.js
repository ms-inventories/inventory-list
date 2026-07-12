import { expect, test } from "@playwright/test";

const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const LAUNCH_URL = process.env.QA_LAUNCH_URL || "http://localhost:5175/#/launch";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

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

  test("backend validation errors include the same request ID in the header and JSON", async ({ request }) => {
    const response = await request.post(`${API_URL}/inventory/sessions`, {
      headers: {
        "X-Dev-Sub": qaPlatoonAdmin.sub,
        "X-Dev-Email": qaPlatoonAdmin.email,
        "X-Dev-Name": qaPlatoonAdmin.name,
        "X-Dev-Groups": qaPlatoonAdmin.groups.join(","),
        "X-Tenant-Slug": "ms"
      },
      data: { name: "" }
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.requestId).toMatch(/^[A-Za-z0-9._-]{8,80}$/);
    expect(response.headers()["x-request-id"]).toBe(body.requestId);
  });

  test("tenant error state shows a safe message with a support reference ID", async ({ page }) => {
    const requestId = "qa-request-12345678";
    await page.route("**/api/me**", route => route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "X-Request-ID": requestId },
      body: JSON.stringify({
        error: "The server could not complete this request.",
        code: "internal_error",
        requestId
      })
    }));
    await seedQaSessionBeforeLoad(page);
    await page.goto(TENANT_URL);

    await expect(page.getByText(`The server could not complete this request. Reference ID: ${requestId}.`)).toBeVisible();
    await expect(page.getByText(/stack|postgres|password/i)).toHaveCount(0);
  });
});
