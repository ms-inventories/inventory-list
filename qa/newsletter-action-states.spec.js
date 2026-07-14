import { expect, test } from "@playwright/test";

const ADMIN_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const frgAdmin = {
  sub: "qa-frg",
  email: "qa-frg@876en.test",
  name: "QA Newsletter Admin",
  groups: ["876en-frg-admins"]
};

function qaHeaders(identity = frgAdmin) {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(",")
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

async function createIssue(request, title) {
  const data = await responseJson(await request.post(`${API_URL}/newsletter/admin/issues`, {
    headers: qaHeaders(),
    data: {
      title,
      editionLabel: "QA action states",
      summary: "Duplicate action coverage",
      body: "This draft exists only to verify deliberate newsletter actions."
    }
  }));
  return data.issue;
}

async function createContentBlock(request, title) {
  const data = await responseJson(await request.post(`${API_URL}/newsletter/admin/content-blocks`, {
    headers: qaHeaders(),
    data: {
      blockType: "announcement",
      title,
      summary: "Duplicate action coverage",
      body: "This block exists only to verify deliberate newsletter actions.",
      href: "",
      linkLabel: "",
      sortOrder: 900,
      status: "draft"
    }
  }));
  return data.contentBlock;
}

async function createSubscriber(request, suffix) {
  const data = await responseJson(await request.post(`${API_URL}/newsletter/subscribers`, {
    data: {
      displayName: `QA Guard ${suffix}`,
      email: `qa-newsletter-${suffix.toLowerCase()}@example.com`,
      platoon: "MS",
      supervisorName: "QA Lead"
    }
  }));
  return data.subscriber;
}

async function signInAsNewsletterAdmin(page) {
  await page.goto(ADMIN_URL);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: "Newsletter admin" }).click();
  await expect(page.getByRole("heading", { name: "Public content", exact: true })).toBeVisible();
}

test.describe("newsletter async action states", () => {
  test("publishing is single-shot in the API and rejects duplicate UI taps", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${Date.now()}-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const apiIssue = await createIssue(request, `QA publish API ${suffix}`);
    const uiIssue = await createIssue(request, `QA publish UI ${suffix}`);

    const publishApiIssue = () => request.post(`${API_URL}/newsletter/admin/issues/${apiIssue.id}/publish`, {
      headers: qaHeaders()
    });
    const [firstResponse, secondResponse] = await Promise.all([publishApiIssue(), publishApiIssue()]);
    const [first, second] = await Promise.all([responseJson(firstResponse), responseJson(secondResponse)]);
    expect([first.alreadyPublished, second.alreadyPublished].sort()).toEqual([false, true]);
    const repeated = first.alreadyPublished ? first : second;
    expect(repeated.delivery).toEqual({ sent: 0, skipped: 0, failed: 0 });
    const publishedEdit = await request.patch(`${API_URL}/newsletter/admin/issues/${apiIssue.id}`, {
      headers: qaHeaders(),
      data: {
        title: `${apiIssue.title} changed`,
        editionLabel: apiIssue.editionLabel || "QA action states",
        summary: apiIssue.summary || "Duplicate action coverage",
        body: apiIssue.body
      }
    });
    expect(publishedEdit.status()).toBe(409);
    expect(await publishedEdit.json()).toMatchObject({
      code: "conflict",
      error: "Published newsletter issues are read-only. Create a new issue instead."
    });

    let publishAttempts = 0;
    await page.route(`**/api/newsletter/admin/issues/${uiIssue.id}/publish`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      publishAttempts += 1;
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });

    await signInAsNewsletterAdmin(page);
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^${uiIssue.title}`) }).click();

    const editor = page.locator(".newsletter-editor-form");
    const publishButton = editor.getByRole("button", { name: "Publish", exact: true });
    await publishButton.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect.poll(() => publishAttempts).toBe(1);
    await expect(editor.getByRole("button", { name: "Publishing..." })).toBeDisabled();
    await expect(editor.getByLabel("Title")).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Send test" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New issue" })).toBeDisabled();
    await expect(editor.getByText(/Published\. Delivered \d+, skipped \d+, failed \d+\./)).toBeVisible();
    await expect(editor.getByRole("button", { name: "Published", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Save issue" })).toBeDisabled();
    await expect(editor.getByText("Published issues are read-only. Create a new issue for the next update.")).toBeVisible();
    expect(publishAttempts).toBe(1);
  });

  test("content saves and subscriber reviews stay scoped and reject duplicate taps", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${Date.now()}-${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const block = await createContentBlock(request, `QA guarded block ${suffix}`);
    const firstSubscriber = await createSubscriber(request, `A-${suffix}`);
    const secondSubscriber = await createSubscriber(request, `B-${suffix}`);
    let saveAttempts = 0;
    let reviewAttempts = 0;

    try {
      await page.route(`**/api/newsletter/admin/content-blocks/${block.id}`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        saveAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.route(`**/api/newsletter/admin/subscribers/${firstSubscriber.id}/review`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        reviewAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.continue();
      });

      await signInAsNewsletterAdmin(page);
      await page.getByRole("button", { name: new RegExp(`^${block.title}`) }).click();
      const contentEditor = page.locator(".newsletter-editor-form");
      await contentEditor.getByLabel("Summary").fill("Saved exactly once");
      await contentEditor.evaluate(form => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      await expect.poll(() => saveAttempts).toBe(1);
      await expect(contentEditor.getByRole("button", { name: "Saving block..." })).toBeDisabled();
      await expect(contentEditor.getByLabel("Title")).toBeDisabled();
      await expect(contentEditor.getByRole("button", { name: "Remove" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "New block" })).toBeDisabled();
      await expect(contentEditor.getByText("Public content saved.")).toBeVisible();
      expect(saveAttempts).toBe(1);

      await page.getByRole("button", { name: "Subscribers", exact: true }).click();
      await page.getByLabel("Search subscribers").fill(`QA Guard`);
      const firstRow = page.locator(".admin-list-row", { hasText: firstSubscriber.displayName });
      const secondRow = page.locator(".admin-list-row", { hasText: secondSubscriber.displayName });
      const approveButton = firstRow.getByRole("button", { name: "Approve", exact: true });
      await approveButton.evaluate(button => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await expect.poll(() => reviewAttempts).toBe(1);
      await expect(firstRow.getByRole("button", { name: "Approving..." })).toBeDisabled();
      await expect(firstRow.getByPlaceholder("Private note for this request...")).toBeDisabled();
      await expect(secondRow.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
      await expect(page.getByText(new RegExp(`${firstSubscriber.displayName} was approved`))).toBeVisible();
      await expect(firstRow).toHaveCount(0);
      expect(reviewAttempts).toBe(1);

      let refreshAttempts = 0;
      await page.route("**/api/newsletter/admin", async route => {
        if (route.request().method() !== "GET") return route.continue();
        refreshAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.continue();
      });
      const refreshButton = page.getByRole("button", { name: "Refresh newsletter" });
      await refreshButton.evaluate(button => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(() => refreshAttempts).toBe(1);
      await expect(page.getByRole("button", { name: "Refreshing newsletter" })).toBeDisabled();
      await expect(page.getByText("Newsletter refreshed.")).toBeVisible();
      expect(refreshAttempts).toBe(1);
    } finally {
      await request.delete(`${API_URL}/newsletter/admin/content-blocks/${block.id}`, { headers: qaHeaders() });
      await request.patch(`${API_URL}/newsletter/admin/subscribers/${secondSubscriber.id}/review`, {
        headers: qaHeaders(),
        data: { decision: "rejected", note: "QA cleanup" }
      });
    }
  });
});
