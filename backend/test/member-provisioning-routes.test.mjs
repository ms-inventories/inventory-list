import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  permanentMemberTransition,
  platformTenantResetStoragePath,
  registerRoutes,
  rowToMember,
  safeAuthentikIdentityCandidate,
  safeMemberProvisioning
} from "../src/routes.js";

test("platform tenant reset storage paths remain inside the tenant upload root", () => {
  const resolved = platformTenantResetStoragePath("/data/inventory-uploads", "ms");
  assert.equal(resolved, path.resolve("/data/inventory-uploads/tenants/ms"));
  assert.throws(() => platformTenantResetStoragePath("/data/inventory-uploads", "../ms"), /invalid tenant reset target/i);
  assert.throws(() => platformTenantResetStoragePath("/data/inventory-uploads", "ms/other"), /invalid tenant reset target/i);
});

test("permanent member state changes revoke immediately and re-enable through invited", () => {
  assert.deepEqual(
    permanentMemberTransition("active", "disabled"),
    { membershipStatus: "disabled", desiredState: "disabled" }
  );
  assert.deepEqual(
    permanentMemberTransition("disabled", "active"),
    { membershipStatus: "invited", desiredState: "active" }
  );
  assert.deepEqual(
    permanentMemberTransition("invited", "active"),
    { membershipStatus: "invited", desiredState: "active" }
  );
  assert.throws(
    () => permanentMemberTransition("active", "invited"),
    /unsupported requested member status/i
  );
});

test("role-only changes preserve access state while reconciling the matching provider state", () => {
  assert.deepEqual(
    permanentMemberTransition("active"),
    { membershipStatus: "active", desiredState: "active" }
  );
  assert.deepEqual(
    permanentMemberTransition("invited"),
    { membershipStatus: "invited", desiredState: "active" }
  );
  assert.deepEqual(
    permanentMemberTransition("disabled"),
    { membershipStatus: "disabled", desiredState: "disabled" }
  );
});

test("member provisioning responses expose canonical safe errors only", () => {
  const secretProviderMessage = "Bearer provider-secret and internal response body";
  const provisioning = safeMemberProvisioning({
    provisioning_job_id: "job-1",
    provisioning_status: "failed",
    provisioning_step: "identity",
    provisioning_desired_role: "contributor",
    provisioning_desired_state: "active",
    provisioning_error_code: "provider_not_authorized",
    provisioning_safe_error: secretProviderMessage,
    provisioning_enrollment_required: true
  });

  assert.equal(provisioning.error.code, "provider_not_authorized");
  assert.match(provisioning.error.message, /permissions/i);
  assert.equal(JSON.stringify(provisioning).includes(secretProviderMessage), false);
});

test("member responses identify permanent account and sign-in state without provider identifiers", () => {
  const member = rowToMember({
    id: "membership-1",
    tenant_id: "tenant-1",
    user_id: "user-1",
    role: "contributor",
    status: "invited",
    email: "soldier@example.test",
    display_name: "Soldier",
    account_type: "authentik",
    authentik_subject: null,
    authentik_user_pk: 42,
    authentik_user_uuid: "secret-provider-identifier",
    created_at: "2026-07-14T12:00:00Z"
  });

  assert.equal(member.accountType, "authentik");
  assert.equal(member.hasSignedIn, false);
  assert.equal("authentikUserPk" in member, false);
  assert.equal(JSON.stringify(member).includes("secret-provider-identifier"), false);
});

test("member responses expose server-authorized setup email resend state", () => {
  const unsigned = safeMemberProvisioning({
    status: "active",
    authentik_subject: null,
    provisioning_job_id: "job-1",
    provisioning_status: "succeeded",
    provisioning_step: "complete",
    provisioning_desired_role: "contributor",
    provisioning_desired_state: "active",
    provisioning_enrollment_required: true,
    provisioning_enrollment_sent_at: "2026-07-14T14:00:00Z"
  });
  const signedIn = safeMemberProvisioning({
    status: "active",
    authentik_subject: "stable-subject",
    provisioning_job_id: "job-1",
    provisioning_status: "succeeded",
    provisioning_step: "complete",
    provisioning_desired_role: "contributor",
    provisioning_desired_state: "active",
    provisioning_enrollment_required: true,
    provisioning_enrollment_sent_at: "2026-07-14T14:00:00Z"
  });

  assert.equal(unsigned.canResendEnrollment, true);
  assert.equal(unsigned.enrollment.canResend, true);
  assert.equal(signedIn.canResendEnrollment, false);
});

test("duplicate identity choices expose only safe display fields and block privileged accounts", () => {
  const regularIdentity = {
    pk: 42,
    uuid: "db7a5d19-32f5-4d86-a7c8-87951129ad05",
    username: "soldier",
    name: "SSG Soldier",
    email: "private@example.test",
    is_active: true,
    is_superuser: false,
    groups_obj: [{ name: "876en" }, { name: "876en-ms" }]
  };
  const regular = safeAuthentikIdentityCandidate(regularIdentity);
  const privileged = safeAuthentikIdentityCandidate({
    pk: 43,
    uuid: "91e8139a-c2ff-4dc1-b423-016a6738a877",
    username: "platform-admin",
    name: "Platform Admin",
    is_active: true,
    is_superuser: true,
    groups_obj: []
  });

  assert.deepEqual(regular, {
    id: "db7a5d19-32f5-4d86-a7c8-87951129ad05",
    username: "soldier",
    displayName: "SSG Soldier",
    active: true,
    eligible: true,
    blockedReason: null
  });
  assert.equal("email" in regular, false);
  assert.equal("pk" in regular, false);
  assert.equal(privileged.eligible, false);
  assert.match(privileged.blockedReason, /privileged/i);
  assert.equal(safeAuthentikIdentityCandidate({
    ...regularIdentity,
    groups_obj: [{ name: "876en-admins" }]
  }).eligible, false);
  assert.equal(safeAuthentikIdentityCandidate(regularIdentity, { linkedElsewhere: true }).eligible, false);
  assert.equal(safeAuthentikIdentityCandidate(regularIdentity, { providerOwnerConflict: true }).eligible, false);
});

test("duplicate identity inspection honors identities linked through OIDC sign-in", async () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(currentDirectory, "../src/routes.js"), "utf8");

  assert.match(
    source,
    /SELECT id, authentik_subject, authentik_user_pk,[\s\S]*authentik_oidc_user_uuid::text AS authentik_oidc_user_uuid[\s\S]*WHERE authentik_user_uuid = ANY\(\$1::uuid\[\]\)[\s\S]*OR authentik_oidc_user_uuid = ANY\(\$1::uuid\[\]\)[\s\S]*OR lower\(authentik_subject\) = ANY\(\$3::text\[\]\)/i
  );
  assert.match(
    source,
    /expectedOidcUuid[\s\S]*expectedSubjectUuid[\s\S]*hasProviderLink[\s\S]*isCompatibleLink/i
  );
});

test("permanent member retry and enrollment routes remain registered beside legacy invitations", () => {
  const routes = new Set();
  const app = new Proxy({
    use() {}
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return (path) => routes.add(`${String(property).toUpperCase()} ${path}`);
    }
  });

  registerRoutes(app);

  assert.equal(routes.has("GET /api/tenant/members"), true);
  assert.equal(routes.has("POST /api/tenant/members/identity-check"), true);
  assert.equal(routes.has("POST /api/tenant/members"), true);
  assert.equal(routes.has("GET /api/tenant/members/:memberId/identity-candidates"), true);
  assert.equal(routes.has("POST /api/tenant/members/:memberId/resolve-identity"), true);
  assert.equal(routes.has("DELETE /api/tenant/members/:memberId"), true);
  assert.equal(routes.has("PATCH /api/tenant/members/:memberId"), true);
  assert.equal(routes.has("POST /api/tenant/members/:memberId/retry"), true);
  assert.equal(routes.has("POST /api/tenant/members/:memberId/resend-enrollment"), true);
  assert.equal(routes.has("POST /api/tenant/invitations"), true);
  assert.equal(routes.has("POST /api/platform/identity-check"), true);
  assert.equal(routes.has("DELETE /api/platform/tenants/:tenantId"), true);
});

test("leader member and saved-item queries bind only the placeholders they declare", async () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(currentDirectory, "../src/routes.js"), "utf8");

  assert.match(
    source,
    /route\(app, "get", "\/api\/tenant\/members"[\s\S]*?ORDER BY[\s\S]*?u\.email ASC\s*`,\s*\[context\.tenant\.id\]\s*\);/i
  );
  assert.match(
    source,
    /route\(app, "get", "\/api\/inventory\/items"[\s\S]*?ORDER BY title ASC\s*`,\s*\[context\.tenant\.id\]\s*\);/i
  );
});

test("member mutations serialize last-admin removal and only adopt unprovisioned legacy invites", async () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(currentDirectory, "../src/routes.js"), "utf8");

  assert.match(
    source,
    /assertMemberCanLoseAdminRole[\s\S]*SELECT id FROM tenants WHERE id = \$1 FOR UPDATE[\s\S]*COUNT\(\*\)/i
  );
  assert.match(
    source,
    /WITH adopted AS[\s\S]*existing\.status = 'invited'[\s\S]*NOT EXISTS[\s\S]*authentik_provisioning_jobs[\s\S]*ON CONFLICT \(tenant_id, user_id\) DO NOTHING[\s\S]*member_exists/i
  );
  assert.match(
    source,
    /SELECT id[\s\S]*FROM tenant_invitations[\s\S]*FOR UPDATE[\s\S]*WITH adopted AS[\s\S]*adopted_legacy_invitation[\s\S]*status = 'revoked'/i
  );
  assert.match(
    source,
    /member\.provisioning_retried[\s\S]*acknowledgedUnknownEnrollment:\s*job\.acknowledgedUnknownEnrollment === true/i
  );
});

test("platform tenant slugs are bounded DNS labels and fit the Authentik group name", async () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(currentDirectory, "../src/routes.js"), "utf8");

  assert.match(
    source,
    /slug:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.max\(63\)[\s\S]*\^\[a-z0-9\]/i
  );
  assert.match(
    source,
    /authentikProvisioning\.tenantGroupPrefix[\s\S]*body\.slug[\s\S]*length > 255[\s\S]*invalid_slug/i
  );
  assert.match(source, /reservedAuthentikGroupNames\(\)\.has\(tenantGroupName\)/i);
  assert.match(source, /status:\s*z\.enum\(\["active",\s*"disabled"\]\)\.optional\(\)/i);
  assert.match(
    source,
    /delete[\s\S]*\/api\/platform\/tenants\/:tenantId[\s\S]*confirmSlug[\s\S]*assertTenantGroupRemovedForReset[\s\S]*DELETE FROM tenants[\s\S]*fs\.rm/i
  );
});
