import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.QA_FRONTEND_URL || "http://localhost:5175";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

test.describe("public mutation states", () => {
  test("unsubscribe locks repeated submissions while the request is pending", async ({ page, request }, testInfo) => {
    const email = `qa-unsubscribe-lock-${testInfo.project.name}-${Date.now()}@example.com`;
    const createResponse = await request.post(`${API_URL}/newsletter/subscribers`, {
      data: {
        displayName: "QA Pending Unsubscribe",
        email,
        platoon: "MS",
        supervisorName: "QA Lead"
      }
    });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();

    let releaseRequest;
    const requestGate = new Promise(resolve => {
      releaseRequest = resolve;
    });
    let unsubscribeRequests = 0;
    await page.route("**/api/newsletter/unsubscribe", async route => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      unsubscribeRequests += 1;
      await requestGate;
      await route.continue();
    });

    await page.goto(`${FRONTEND_URL}/#/unsubscribe?email=${encodeURIComponent(email)}`);
    const form = page.locator("form");
    const submit = form.getByRole("button", { name: "Unsubscribe", exact: true });
    await submit.click();

    await expect(form.getByRole("button", { name: "Unsubscribing..." })).toBeDisabled();
    await expect(form.getByLabel("Email address")).toBeDisabled();
    await form.evaluate(element => {
      element.requestSubmit();
      element.requestSubmit();
    });
    await expect.poll(() => unsubscribeRequests).toBe(1);

    releaseRequest();
    await expect(form.getByText("You have been unsubscribed from the newsletter.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Unsubscribe", exact: true })).toBeEnabled();
  });
});
