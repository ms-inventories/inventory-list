import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.QA_FRONTEND_URL || "http://localhost:5175";
const ADMIN_URL = process.env.QA_ADMIN_URL || "http://admin.localhost:5175/#/admin";
const NEWSLETTER_URL = process.env.QA_NEWSLETTER_URL || "http://admin.localhost:5175/#/newsletter";
const TENANT_URL = process.env.QA_TENANT_URL || "http://ms.localhost:5175/#/admin";
const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";
const LAUNCH_URL = process.env.QA_LAUNCH_URL || "http://localhost:5175/#/launch";

const qaIdentities = {
  root: {
    sub: "qa-root",
    email: "qa-root@876en.test",
    name: "QA Root Admin",
    groups: ["876en-admins"]
  },
  frg: {
    sub: "qa-frg",
    email: "qa-frg@876en.test",
    name: "QA Newsletter Admin",
    groups: ["876en-frg-admins"]
  },
  nco: {
    sub: "qa-nco",
    email: "qa-nco@876en.test",
    name: "QA NCO",
    groups: ["876en-ms"]
  }
};

async function signInWithQaPersona(page, personaName) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "QA users" }).click();
  await page.getByRole("button", { name: personaName }).click();
}

async function seedQaLaunchSession(page, identity) {
  await page.goto(FRONTEND_URL);
  await page.evaluate(qaIdentity => {
    localStorage.setItem("inventory.qa.identity", JSON.stringify(qaIdentity));
    localStorage.setItem("inventory.auth.session", JSON.stringify({
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    }));
  }, identity);
}

test.describe("QA smoke", () => {
  test("public landing page shows FRG content and portal entry", async ({ page }) => {
    await page.goto(FRONTEND_URL);

    await expect(page.getByRole("heading", { name: "Black Shadow Company", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get updates" })).toBeVisible();
    const loginMenu = page.locator("summary").filter({ hasText: "Login" });
    await expect(loginMenu).toBeVisible();

    await loginMenu.click();
    await expect(page.getByRole("link", { name: /Launch app/ })).toBeVisible();
    await expect(page.getByText("Sign in to continue")).toBeVisible();
    await expect(page.locator(".public-login-panel")).not.toContainText(/inventory/i);
  });

  test("platform root admin can reach platoon management", async ({ page }) => {
    await page.goto(ADMIN_URL);
    await signInWithQaPersona(page, "Root admin");

    const recentPlatoons = page.locator(".platform-dashboard-card").filter({
      has: page.getByRole("heading", { name: "Recent platoons", exact: true })
    });
    await recentPlatoons.getByRole("button", { name: "View all", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Platoons", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create platoon" }).first()).toBeVisible();
    await expect(page.getByText("ms.localhost").first()).toBeVisible();
    await page.getByRole("button", { name: "Open account actions" }).click();
    await expect(page.getByRole("region", { name: "Account menu" }).getByText("QA Root Admin", { exact: true })).toBeVisible();
  });

  test("launch router sends platform admins to platform admin", async ({ page }) => {
    await seedQaLaunchSession(page, qaIdentities.root);
    await page.goto(LAUNCH_URL);

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
  });

  test("launch router sends newsletter admins to newsletter admin", async ({ page }) => {
    await seedQaLaunchSession(page, qaIdentities.frg);
    await page.goto(LAUNCH_URL);

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/newsletter/);
  });

  test("launch router sends platoon members to their workspace", async ({ page }) => {
    await seedQaLaunchSession(page, qaIdentities.nco);
    await page.goto(LAUNCH_URL);

    await expect(page).toHaveURL(/ms\.localhost:5175\/#\/admin/);
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
    await expect(page.getByRole("button", { name: "Export deliveries" })).toBeVisible();
    await page.getByRole("button", { name: /^Black Shadow Family Update/ }).click();
    await expect(page.getByRole("heading", { name: "Black Shadow Family Update" })).toBeVisible();
    await expect(page.getByText("Delivery records", { exact: true })).toBeVisible();

    await page.getByLabel("Send test").fill("qa-proof@example.com");
    await page.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText(/Test email was not sent: smtp_not_configured|Test email sent to/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Published", exact: true })).toBeDisabled();
    await expect(page.getByText(/recipient|No delivery records yet/)).toBeVisible();

    await page.getByRole("button", { name: "Subscribers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Subscribers", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("Approved subscribers", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  });

  test("newsletter unsubscribe page accepts a subscriber email", async ({ page }) => {
    const email = `qa-unsub-${Date.now()}@example.com`;

    await page.request.post(`${API_URL}/newsletter/subscribers`, {
      data: {
        displayName: "QA Unsubscribe",
        email,
        platoon: "MS",
        supervisorName: "QA Lead"
      }
    });

    await page.goto(`${FRONTEND_URL}/#/unsubscribe?email=${encodeURIComponent(email)}`);
    await expect(page.getByRole("heading", { name: "Unsubscribe" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue(email);

    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByText("You have been unsubscribed from the newsletter.")).toBeVisible();
  });

  test("platoon admin sees leader dashboard and admin-only controls", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");

    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dashboard review results" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start new inventory" })).toBeVisible();
    const workspaceMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await workspaceMenu.isVisible()) {
      await workspaceMenu.click();
      await expect(page.getByRole("button", { name: "Review Queue", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Team" })).toBeVisible();
      await page.locator(".leader-brand").getByRole("button", { name: "Close menu" }).click();
    } else {
      await expect(page.getByRole("button", { name: "Review Queue", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Team" })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Upload packet" })).toBeVisible();
  });

  test("platoon admin can open and review packet upload rows", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    const uploadPacket = page.getByRole("button", { name: "Upload packet" });
    await expect(uploadPacket).toBeVisible();
    await uploadPacket.click();

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Session", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Source", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Review", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Choose source" }).click();
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

    await expect(page.getByRole("heading", { name: "Inventory Dashboard" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Dashboard review results" })).toHaveCount(0);
    await expect(page.locator(".leader-metric-strip").getByText("Needs review", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open user menu" }).click();
    const userMenu = page.getByRole("region", { name: "User menu" });
    await expect(userMenu.locator(".leader-profile-summary").getByText("Contributor", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open user menu" }).click();
    const workspaceMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await workspaceMenu.isVisible()) await workspaceMenu.click();
    await expect(page.getByRole("button", { name: "Inventory Sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Queue" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Team" })).toHaveCount(0);
  });
});
