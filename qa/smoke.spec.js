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

async function openNewsletterSection(page, name) {
  const menuToggle = page.getByRole("button", { name: "Open newsletter menu" });
  if (await menuToggle.isVisible()) await menuToggle.click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function openPlatformSection(page, name) {
  const menuToggle = page.getByRole("button", { name: "Open platform menu" });
  if (await menuToggle.isVisible()) await menuToggle.click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function seedQaLaunchSession(page, identity) {
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

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    const platoonCard = page.locator(".platform-platoon-card").filter({ hasText: "ms.localhost" }).first();
    await expect(platoonCard).toBeVisible();
    await expect(platoonCard.getByRole("button", { name: /Copy link for MS Platoon/i })).toBeVisible();
    await expect(platoonCard.getByRole("link", { name: /Enter MS Platoon workspace/i })).toBeVisible();

    await openPlatformSection(page, "Settings");
    await expect(page.getByRole("heading", { name: "Platform settings", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create platoon", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open account actions" }).click();
    await expect(page.getByRole("region", { name: "Account menu" }).getByText("QA Root Admin", { exact: true })).toBeVisible();
  });

  test("launch router sends platform admins to platform admin", async ({ page }) => {
    await seedQaLaunchSession(page, qaIdentities.root);
    await page.goto(LAUNCH_URL);

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
  });

  test("a deleted workspace redirects platform admins before rendering its dashboard", async ({ page }) => {
    await page.addInitScript(identity => {
      localStorage.setItem("inventory.qa.identity", JSON.stringify(identity));
      localStorage.setItem("inventory.auth.session", JSON.stringify({
        accessToken: "qa-dev",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        createdAt: Date.now(),
        qa: true
      }));
    }, qaIdentities.root);
    await page.route("**/api/me", async route => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "00000000-0000-4000-8000-000000000094",
            email: qaIdentities.root.email,
            display_name: qaIdentities.root.name
          },
          identity: {
            subject: qaIdentities.root.sub,
            email: qaIdentities.root.email,
            displayName: qaIdentities.root.name
          },
          groups: qaIdentities.root.groups,
          isPlatformAdmin: true,
          isFrgAdmin: true,
          tenant: null,
          membership: null,
          access: null,
          workspaces: []
        })
      });
    });

    await page.goto("http://deleted.localhost:5175/#/admin");

    await expect(page).toHaveURL(/admin\.localhost:5175\/#\/admin/);
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toHaveCount(0);
    await expect(page.getByText(/Tenant not found for this hostname/i)).toHaveCount(0);
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

  test("launch router gives multi-platoon users a named workspace chooser", async ({ page }) => {
    await seedQaLaunchSession(page, {
      sub: "qa-multi-workspace",
      email: "qa-multi-workspace@876en.test",
      name: "QA Multi Workspace",
      groups: []
    });
    await page.route("**/api/me", async route => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "00000000-0000-4000-8000-000000000091",
            email: "qa-multi-workspace@876en.test",
            display_name: "QA Multi Workspace"
          },
          identity: {
            subject: "qa-multi-workspace",
            email: "qa-multi-workspace@876en.test",
            displayName: "QA Multi Workspace"
          },
          groups: ["876en-disabled-stale-group"],
          isPlatformAdmin: false,
          isFrgAdmin: false,
          tenant: null,
          membership: null,
          access: null,
          workspaces: [
            {
              id: "00000000-0000-4000-8000-000000000092",
              slug: "ms",
              name: "Maintenance Support Platoon",
              status: "active",
              role: "tenant_admin",
              source: "database"
            },
            {
              id: "00000000-0000-4000-8000-000000000093",
              slug: "red",
              name: "Red Platoon",
              status: "active",
              role: "contributor",
              source: "database"
            }
          ]
        })
      });
    });

    await page.goto(LAUNCH_URL);

    await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
    const choices = page.getByRole("navigation", { name: "Available workspaces" });
    const msWorkspace = choices.getByRole("link", { name: "Open Maintenance Support Platoon workspace" });
    const redWorkspace = choices.getByRole("link", { name: "Open Red Platoon workspace" });
    await expect(msWorkspace).toContainText("Leader");
    await expect(msWorkspace).toContainText("ms.localhost");
    await expect(redWorkspace).toContainText("Team member");
    await expect(redWorkspace).toContainText("red.localhost");
    await expect(choices.getByText(/disabled-stale-group/i)).toHaveCount(0);
    await expect(msWorkspace).toHaveAttribute("href", "http://ms.localhost:5175/#/admin");
    await expect(redWorkspace).toHaveAttribute("href", "http://red.localhost:5175/#/admin");

    for (const choice of [msWorkspace, redWorkspace]) {
      const box = await choice.boundingBox();
      expect(box?.height || 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("newsletter admin can reach newsletter workspace", async ({ page }) => {
    await page.goto(NEWSLETTER_URL);
    await signInWithQaPersona(page, "Newsletter admin");

    await expect(page.getByRole("heading", { name: "Newsletter", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Homepage updates" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Newsletter issues" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Subscribers" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview homepage" }).first()).toBeVisible();

    await page.getByRole("button", { name: /Pending requests/ }).click();
    await expect(page.getByRole("heading", { name: "Subscribers", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByLabel("Filter subscribers by status")).toHaveValue("pending");
    await openNewsletterSection(page, "Overview");
    await page.getByRole("button", { name: /Approved subscribers/ }).click();
    await expect(page.getByLabel("Filter subscribers by status")).toHaveValue("active");
    await openNewsletterSection(page, "Overview");

    await page.getByRole("button", { name: "Update homepage" }).click();
    const homepageDialog = page.getByRole("dialog", { name: "Manage homepage updates" });
    await expect(homepageDialog.locator(".frg-content-list").getByText("Family readiness updates", { exact: true })).toBeVisible();
    await homepageDialog.getByRole("button", { name: "Close homepage editor" }).click();

    await page.getByRole("button", { name: "Manage issues" }).click();
    await expect(page.getByRole("heading", { name: "Newsletter issues", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeVisible();
    const issueRow = page.getByRole("table", { name: "Newsletter issues" }).getByRole("row").filter({ hasText: "Black Shadow Family Update" });
    await issueRow.getByRole("button", { name: "View" }).click();
    const issueDialog = page.getByRole("dialog", { name: "View issue" });
    await expect(issueDialog.getByRole("heading", { name: "Black Shadow Family Update" })).toBeVisible();

    await issueDialog.getByLabel("Send test").fill("qa-proof@example.com");
    await issueDialog.getByRole("button", { name: "Send test" }).click();
    await expect(issueDialog.getByText(/Test email was not sent: smtp_not_configured|Test email sent to/)).toBeVisible();

    await expect(issueDialog.getByRole("button", { name: "Published", exact: true })).toBeDisabled();
    await issueDialog.getByRole("button", { name: "Close issue editor" }).click();

    await openNewsletterSection(page, "Analytics");
    await expect(page.getByRole("heading", { name: "Delivery analytics", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeVisible();

    await openNewsletterSection(page, "Subscribers");
    await expect(page.getByRole("heading", { name: "Subscribers", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeVisible();
    await page.getByLabel("Filter subscribers by status").selectOption("active");
    await expect(page.getByRole("table", { name: "Newsletter subscribers" })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Start new inventory" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload packet" })).toHaveCount(0);
    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    await expect(activeInventory.getByRole("button", { name: "Open inventory", exact: true })).toBeVisible();
    const workspaceMenu = page.getByRole("button", { name: "Open workspace menu" });
    if (await workspaceMenu.isVisible()) {
      await workspaceMenu.click();
      await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Review Queue", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Team" })).toBeVisible();
      await page.locator(".leader-brand").getByRole("button", { name: "Close menu" }).click();
    } else {
      await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Review Queue", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Team" })).toBeVisible();
    }
    await activeInventory.getByRole("button", { name: "Open inventory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to dashboard", exact: true })).toBeVisible();
    await expect(page.locator(".session-create > summary")).toContainText("New inventory");
    await expect(page.getByRole("button", { name: "Invite crew", exact: true })).toBeVisible();
  });

  test("platoon admin can open and review packet items", async ({ page }) => {
    await page.goto(TENANT_URL);
    await signInWithQaPersona(page, "Platoon admin");
    await expect(page.getByRole("heading", { name: "Leader Dashboard" })).toBeVisible();

    const activeInventory = page.getByRole("region", { name: "Active inventory" });
    const inventorySelect = activeInventory.getByRole("combobox", { name: "Active inventory", exact: true });
    if (await inventorySelect.isVisible()) await inventorySelect.selectOption({ label: "July sensitive items" });
    await activeInventory.getByRole("button", { name: "Open inventory", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    const inventoryTools = page.locator("details.session-tools");
    await inventoryTools.locator(":scope > summary").click();
    await inventoryTools.getByRole("button", { name: "Add packet", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Upload packet" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Inventory", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Source", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Review", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Choose source" }).click();
    await expect(dialog.getByRole("heading", { name: "Add the packet source" })).toBeVisible();

    await dialog.locator("textarea").fill([
      "000009148 R20684 RADIAC SET: AN/VDR-2 OH Qty 1",
      "0000005550 B67766 BINOCULAR: MODULAR CONSTRUCTION MIL SCAL OH Qty 5"
    ].join("\n"));
    await dialog.getByRole("button", { name: "Review items" }).click();

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
    await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inventory", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review Queue" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Team" })).toHaveCount(0);
  });
});
