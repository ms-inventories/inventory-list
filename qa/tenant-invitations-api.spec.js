import { expect, test } from "@playwright/test";

const API_URL = process.env.QA_API_URL || "http://localhost:5300/api";

const qaAdmin = {
  sub: "qa-lead",
  email: "qa-lead@876en.test",
  name: "QA Platoon Admin",
  groups: ["876en-ms", "876en-platoon-admin"]
};

const qaRoot = {
  sub: "qa-root",
  email: "qa-root@876en.test",
  name: "QA Platform Admin",
  groups: ["876en-admins"]
};

function qaHeaders(identity, tenantSlug = "ms") {
  return {
    "X-Dev-Sub": identity.sub,
    "X-Dev-Email": identity.email,
    "X-Dev-Name": identity.name,
    "X-Dev-Groups": identity.groups.join(","),
    "X-Tenant-Slug": tenantSlug
  };
}

async function responseJson(response) {
  if (!response.ok()) {
    const body = await response.text();
    expect(response.ok(), body).toBeTruthy();
  }
  return response.json();
}

test.describe("tenant invitation API", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === "mobile-chrome", "The invitation API contract is device-independent.");
  });

  test("creates a persistent pending invitation without sending email", async ({ request }, testInfo) => {
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now()}`;
    const email = `qa-pending-${suffix}@example.com`;
    const displayName = `QA Pending ${suffix}`;
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const capabilities = await responseJson(await request.get(`${API_URL}/platform/capabilities`, {
      headers: qaHeaders(qaRoot)
    }));
    expect(capabilities).toEqual({ capabilities: { silentInvitationCreate: true } });
    const baselineTenants = await responseJson(await request.get(`${API_URL}/platform/tenants`, {
      headers: qaHeaders(qaRoot)
    }));
    const baselineMs = baselineTenants.tenants.find(tenant => tenant.slug === "ms");
    expect(baselineMs).toBeTruthy();

    let invitationId = "";
    try {
      const createdResponse = await request.post(`${API_URL}/tenant/invitations`, {
        headers: qaHeaders(qaAdmin),
        data: {
          email,
          displayName,
          role: "tenant_admin",
          sendEmail: false
        }
      });
      expect(createdResponse.status()).toBe(201);
      const created = await responseJson(createdResponse);
      invitationId = created.invitation.id;

      expect(created.email).toEqual({ sent: false, reason: "not_requested" });
      expect(created.invitation).toMatchObject({
        email,
        role: "tenant_admin",
        status: "pending"
      });
      expect(created.invitation.inviteUrl).toBeTruthy();

      const invitations = await responseJson(await request.get(`${API_URL}/tenant/invitations`, {
        headers: qaHeaders(qaAdmin)
      }));
      expect(invitations.invitations).toContainEqual(expect.objectContaining({
        id: created.invitation.id,
        email,
        role: "tenant_admin",
        status: "pending"
      }));

      const members = await responseJson(await request.get(`${API_URL}/tenant/members`, {
        headers: qaHeaders(qaAdmin)
      }));
      expect(members.members).toContainEqual(expect.objectContaining({
        email,
        displayName,
        role: "tenant_admin",
        status: "invited"
      }));

      const tenantsWithInvitation = await responseJson(await request.get(`${API_URL}/platform/tenants`, {
        headers: qaHeaders(qaRoot)
      }));
      const msWithInvitation = tenantsWithInvitation.tenants.find(tenant => tenant.slug === "ms");
      expect(msWithInvitation.pendingAdminInviteCount).toBe(baselineMs.pendingAdminInviteCount + 1);

      const audit = await responseJson(await request.get(
        `${API_URL}/tenant/audit-events?category=access&action=invitation.created&from=${encodeURIComponent(startedAt)}`,
        { headers: qaHeaders(qaAdmin) }
      ));
      expect(audit.events).toContainEqual(expect.objectContaining({
        action: "invitation.created",
        entity: expect.objectContaining({ id: created.invitation.id, type: "tenant_invitation" }),
        details: { email, role: "tenant_admin", deliveryRequested: false }
      }));
    } finally {
      if (invitationId) {
        await responseJson(await request.post(`${API_URL}/tenant/invitations/${invitationId}/revoke`, {
          headers: qaHeaders(qaAdmin)
        }));
        const tenantsAfterRevoke = await responseJson(await request.get(`${API_URL}/platform/tenants`, {
          headers: qaHeaders(qaRoot)
        }));
        const msAfterRevoke = tenantsAfterRevoke.tenants.find(tenant => tenant.slug === "ms");
        expect(msAfterRevoke.pendingAdminInviteCount).toBe(baselineMs.pendingAdminInviteCount);
      }
    }
  });

  test("keeps email delivery enabled when sendEmail is omitted", async ({ request }) => {
    const suffix = `default-${Date.now()}`;
    let invitationId = "";
    try {
      const created = await responseJson(await request.post(`${API_URL}/tenant/invitations`, {
        headers: qaHeaders(qaAdmin),
        data: {
          email: `qa-pending-${suffix}@example.com`,
          displayName: `QA Pending ${suffix}`,
          role: "contributor"
        }
      }));
      invitationId = created.invitation.id;
      expect(created.email).toEqual({ sent: false, reason: "smtp_not_configured" });
    } finally {
      if (invitationId) {
        await responseJson(await request.post(`${API_URL}/tenant/invitations/${invitationId}/revoke`, {
          headers: qaHeaders(qaAdmin)
        }));
      }
    }
  });
});
