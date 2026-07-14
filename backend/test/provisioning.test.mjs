import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPostgresStore,
  createProvisioningRuntime,
  safeAuthentikUsername,
  satisfyEnrollmentFromVerifiedLogin
} from "../src/provisioning.js";

const userUuid = "db7a5d19-32f5-4d86-a7c8-87951129ad05";
const baseGroup = {
  pk: "d775ad9e-0d8e-46aa-b944-a35e145ad0f2",
  name: "876en",
  is_superuser: false,
  parents: [],
  roles: []
};
const tenantGroup = {
  pk: "4749e799-9c38-48bb-a170-9dbc01dab506",
  name: "876en-ms",
  is_superuser: false,
  parents: [],
  roles: [],
  attributes: {
    inventory_list_managed: true,
    inventory_tenant_id: "e4c99941-df37-4c05-9da9-7e07813250a9",
    inventory_tenant_slug: "ms"
  }
};

function job(overrides = {}) {
  return {
    id: "d2bb8707-1fac-4f24-adb4-ddab0f782638",
    membershipId: "01f36f61-ab23-4805-9a53-45350250ab2c",
    tenantId: "e4c99941-df37-4c05-9da9-7e07813250a9",
    tenantSlug: "ms",
    tenantStatus: "active",
    userId: "3e793153-9f91-4ee7-a83a-82caf28c4896",
    email: "person@example.test",
    displayName: "Test Person",
    accountType: "authentik",
    membershipRole: "contributor",
    membershipStatus: "invited",
    desiredRole: "contributor",
    desiredState: "active",
    currentStep: "identity",
    status: "running",
    targetRevision: 1,
    attemptCount: 1,
    enrollmentRequired: null,
    enrollmentSentAt: null,
    enrollmentDispatchStartedAt: null,
    authentikUserPk: null,
    authentikUserUuid: null,
    authentikSubject: null,
    authentikOidcUserUuid: null,
    authentikManagedByApp: false,
    authentikEnrollmentSentAt: null,
    authentikEnrollmentJobId: null,
    enrollmentResendRequested: false,
    reconcileRequested: false,
    leaseToken: "f6ba371d-c415-45c4-85d5-b6f8390112a0",
    ...overrides
  };
}

function databaseJob(overrides = {}) {
  const current = job();
  return {
    id: current.id,
    tenant_membership_id: current.membershipId,
    desired_role: current.desiredRole,
    desired_state: current.desiredState,
    current_step: current.currentStep,
    status: current.status,
    target_revision: current.targetRevision,
    attempt_count: current.attemptCount,
    enrollment_required: current.enrollmentRequired,
    enrollment_sent_at: current.enrollmentSentAt,
    enrollment_dispatch_started_at: current.enrollmentDispatchStartedAt,
    enrollment_resend_requested: current.enrollmentResendRequested,
    last_attempt_at: null,
    next_attempt_at: null,
    last_error_code: null,
    last_safe_error: null,
    last_error_at: null,
    completed_at: null,
    created_at: "2026-07-14T12:00:00Z",
    updated_at: "2026-07-14T12:00:00Z",
    ...overrides
  };
}

function fakeStore(initialJob) {
  let current = { ...initialJob };
  let claimed = false;
  const events = [];
  return {
    events,
    current: () => current,
    requestReconcile(overrides = {}) {
      current = { ...current, ...overrides, reconcileRequested: true };
    },
    async enqueue(_client, options) {
      events.push(["enqueue", options]);
      return { id: current.id, status: "pending" };
    },
    async get() {
      return current;
    },
    async retry() {
      return null;
    },
    async requestEnrollmentResend() {
      return null;
    },
    async claimNext() {
      if (claimed) return null;
      claimed = true;
      events.push(["claim"]);
      return current;
    },
    async extendLease() {
      events.push(["lease"]);
      return current.status === "running";
    },
    async restartIfRequested(_claimed, { quietPeriodMs = 0 } = {}) {
      if (!current.reconcileRequested) return false;
      events.push(["restart", quietPeriodMs]);
      current = {
        ...current,
        currentStep: "identity",
        status: quietPeriodMs > 0 ? "retry_wait" : "pending",
        targetRevision: current.targetRevision + 1,
        attemptCount: 0,
        leaseToken: null,
        reconcileRequested: false,
        enrollmentRequired: current.desiredState === "disabled"
          ? false
          : current.enrollmentRequired,
        enrollmentSentAt: current.desiredState === "disabled"
          ? null
          : current.enrollmentSentAt
      };
      return true;
    },
    async loadClaim() {
      return current.status === "running" ? current : null;
    },
    async recordIdentity(_claimed, identity, { managedByApp, enrollmentCandidate }) {
      const enrollmentSatisfiedByLogin = Boolean(
        current.authentikSubject
        && current.authentikOidcUserUuid
      );
      const shouldEnroll = Boolean(
        enrollmentCandidate
        && !current.authentikEnrollmentSentAt
        && !enrollmentSatisfiedByLogin
      );
      const priorEnrollmentSentAt = enrollmentCandidate
        && !current.authentikSubject
        && current.authentikEnrollmentSentAt
        ? current.authentikEnrollmentSentAt
        : null;
      events.push(["identity", identity, managedByApp, shouldEnroll]);
      current = {
        ...current,
        currentStep: "groups",
        authentikUserPk: identity.pk,
        authentikUserUuid: identity.uuid,
        authentikManagedByApp: current.authentikManagedByApp || managedByApp,
        enrollmentRequired: enrollmentSatisfiedByLogin
          ? false
          : priorEnrollmentSentAt
            ? true
            : current.enrollmentRequired ?? shouldEnroll,
        enrollmentSentAt: enrollmentSatisfiedByLogin
          ? null
          : current.enrollmentSentAt || priorEnrollmentSentAt,
        enrollmentDispatchStartedAt: enrollmentSatisfiedByLogin
          ? null
          : current.enrollmentDispatchStartedAt,
        authentikEnrollmentSentAt: enrollmentSatisfiedByLogin
          ? current.authentikEnrollmentSentAt || "2026-07-14T15:01:00Z"
          : current.authentikEnrollmentSentAt,
        authentikEnrollmentJobId: enrollmentSatisfiedByLogin
          ? null
          : current.authentikEnrollmentJobId,
        enrollmentResendRequested: enrollmentSatisfiedByLogin
          ? false
          : current.enrollmentResendRequested
      };
      return true;
    },
    async advanceToEnrollment() {
      events.push(["advance", "enrollment"]);
      current = { ...current, currentStep: "enrollment" };
      return true;
    },
    async claimEnrollment() {
      events.push(["claim_enrollment"]);
      if (
        current.authentikSubject
        && current.authentikOidcUserUuid
        && current.authentikOidcUserUuid === current.authentikUserUuid
      ) {
        current = {
          ...current,
          enrollmentRequired: false,
          enrollmentSentAt: null,
          enrollmentResendRequested: false,
          enrollmentDispatchStartedAt: null,
          authentikEnrollmentJobId: null,
          reconcileRequested: true
        };
        return { claimed: false, sentAt: null, signedIn: true };
      }
      if (current.authentikEnrollmentSentAt && !current.enrollmentResendRequested) {
        return { claimed: false, sentAt: current.authentikEnrollmentSentAt };
      }
      if (current.authentikEnrollmentJobId && current.authentikEnrollmentJobId !== current.id) {
        return { claimed: false, sentAt: null };
      }
      current = { ...current, authentikEnrollmentJobId: current.id };
      return { claimed: true, sentAt: null };
    },
    async recordEnrollmentSatisfied(_claimed, sentAt) {
      events.push(["enrollment_satisfied"]);
      current = {
        ...current,
        enrollmentSentAt: sentAt,
        enrollmentResendRequested: false
      };
      return true;
    },
    async recordEnrollmentDispatchStarted() {
      events.push(["enrollment_dispatch_started"]);
      if (current.enrollmentDispatchStartedAt) return false;
      current = {
        ...current,
        enrollmentDispatchStartedAt: "2026-07-14T14:59:59Z"
      };
      return true;
    },
    async releaseEnrollmentDispatch() {
      events.push(["enrollment_dispatch_released"]);
      if (!current.enrollmentDispatchStartedAt || current.authentikEnrollmentJobId !== current.id) {
        return false;
      }
      current = {
        ...current,
        enrollmentDispatchStartedAt: null,
        authentikEnrollmentJobId: null
      };
      return true;
    },
    async recordEnrollmentSent() {
      events.push(["enrollment_sent"]);
      current = {
        ...current,
        enrollmentSentAt: "2026-07-14T15:00:00Z",
        enrollmentDispatchStartedAt: null,
        authentikEnrollmentSentAt: "2026-07-14T15:00:00Z",
        authentikEnrollmentJobId: null,
        enrollmentResendRequested: false
      };
      return true;
    },
    async complete() {
      events.push(["complete"]);
      current = { ...current, currentStep: "complete", status: "succeeded" };
      return current;
    },
    async fail(_claimed, failure, { maximumAttempts = 8 } = {}) {
      events.push(["fail", failure]);
      const shouldRetry = failure.code === "enrollment_pending"
        || (failure.retryable && current.attemptCount < maximumAttempts);
      current = {
        ...current,
        attemptCount: failure.code === "enrollment_pending"
          ? Math.max(0, current.attemptCount - 1)
          : current.attemptCount,
        status: shouldRetry ? "retry_wait" : "failed"
      };
      return current;
    }
  };
}

function runtime(
  store,
  authentikClient,
  logger = { warn() {} },
  enabled = true,
  settingsOverrides = {}
) {
  return createProvisioningRuntime({
    enabled,
    store,
    authentikClient,
    logger,
    settings: {
      baseGroup: "876en",
      tenantGroupPrefix: "876en-",
      userPath: "users/inventory",
      recoveryEmailStage: "61aa7317-087f-4ed0-b446-485b6934b145",
      recoveryTokenDuration: "days=7",
      maximumAttempts: 8,
      ...settingsOverrides
    }
  });
}

test("long provider emails use a stable bounded Authentik username", () => {
  assert.equal(safeAuthentikUsername("short@example.test"), "short@example.test");
  const longEmail = `${"soldier".repeat(25)}@example.test`;
  const username = safeAuthentikUsername(longEmail);
  assert.match(username, /^inventory-[0-9a-f]{64}$/);
  assert.ok(username.length <= 150);
  assert.equal(username, safeAuthentikUsername(longEmail.toUpperCase()));
});

test("a newly created active user is tagged, linked, grouped, enrolled once, then activated", async () => {
  const store = fakeStore(job());
  const calls = [];
  const providerUser = { pk: 42, uuid: userUuid, email: "person@example.test", groups: [], is_active: true };
  const authentik = {
    async createOrLinkUser(options) {
      calls.push(["create", options]);
      return { user: providerUser, created: true };
    },
    async getUserById(id) {
      calls.push(["get", id]);
      return providerUser;
    },
    async findGroupByName(name) {
      calls.push(["find_group", name]);
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup(options) {
      calls.push(["ensure_group", options]);
      return { group: tenantGroup, created: true };
    },
    async ensureUserInGroup(_user, group) {
      calls.push(["add_group", group.name]);
      return { changed: true };
    },
    async sendRecoveryEmail(options) {
      calls.push(["email", options]);
      return { sent: true };
    }
  };

  assert.equal(await runtime(store, authentik).processNext(), true);
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(
    calls.find(([name]) => name === "create")[1].attributes,
    {
      inventory_list_managed: true,
      inventory_app_user_id: job().userId
    }
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "add_group").map(([, group]) => group),
    ["876en", "876en-ms"]
  );
  assert.deepEqual(calls.find(([name]) => name === "ensure_group")[1], {
    name: "876en-ms",
    attributes: {
      inventory_list_managed: true,
      inventory_tenant_id: job().tenantId,
      inventory_tenant_slug: "ms"
    },
    isSuperuser: false
  });
  assert.deepEqual(calls.filter(([name]) => name === "email"), [["email", {
    userId: 42,
    emailStage: "61aa7317-087f-4ed0-b446-485b6934b145",
    tokenDuration: "days=7"
  }]]);
  assert.equal(store.current().authentikUserPk, 42);
  assert.equal(store.current().authentikUserUuid, userUuid);
});

test("an existing exact Authentik user is grouped without an enrollment email", async () => {
  const store = fakeStore(job());
  const calls = [];
  const providerUser = { pk: 43, uuid: userUuid, email: "person@example.test", groups: [], is_active: true };
  const authentik = {
    async createOrLinkUser() {
      calls.push("link");
      return { user: providerUser, created: false };
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    },
    async sendRecoveryEmail() {
      calls.push("email");
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(calls, ["link"]);
  assert.equal(store.current().enrollmentRequired, false);
  assert.equal(store.current().authentikManagedByApp, false);
});

test("a signed-in identity is looked up by immutable UUID and never recreated from stale email", async () => {
  const store = fakeStore(job({
    authentikSubject: "stable-oidc-subject",
    authentikOidcUserUuid: userUuid,
    email: "stale@example.test"
  }));
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "current@example.test",
    groups: []
  };
  const authentik = {
    async findUserByUuid(uuid) {
      calls.push(["find_uuid", uuid]);
      return providerUser;
    },
    async createOrLinkUser() {
      calls.push(["create"]);
      throw new Error("bound identities must not be recreated by email");
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(calls, [["find_uuid", userUuid]]);
});

test("a subject without an immutable OIDC UUID fails before any Authentik mutation", async () => {
  const store = fakeStore(job({ authentikSubject: "legacy-subject" }));
  const calls = [];
  const authentik = new Proxy({}, {
    get() {
      return async () => {
        calls.push("provider-call");
        throw new Error("provider must not be called");
      };
    }
  });

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "immutable_identity_missing");
  assert.deepEqual(calls, []);
});

test("a deleted immutable Authentik identity reports an identity-specific failure", async () => {
  const store = fakeStore(job({
    authentikSubject: "stable-oidc-subject",
    authentikOidcUserUuid: userUuid
  }));
  const authentik = {
    async findUserByUuid() {
      return null;
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "identity_not_found");
});

test("a retry recognizes an app-created Authentik user from its ownership tags", async () => {
  const currentJob = job();
  const store = fakeStore(currentJob);
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: [],
    attributes: {
      inventory_list_managed: true,
      inventory_app_user_id: currentJob.userId
    }
  };
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    },
    async sendRecoveryEmail(options) {
      calls.push(options);
      return { sent: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.equal(store.current().authentikManagedByApp, true);
  assert.equal(store.current().enrollmentRequired, true);
  assert.equal(calls.length, 1);
});

test("an active job enrolls an app-managed identity linked first by cleanup", async () => {
  const currentJob = job({
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  });
  const store = fakeStore(currentJob);
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: []
  };
  const authentik = {
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    },
    async sendRecoveryEmail() {
      calls.push("email");
      return { sent: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.equal(store.current().enrollmentRequired, true);
  assert.deepEqual(calls, ["email"]);
});

test("a later membership reuses global enrollment history without sending another email", async () => {
  const currentJob = job({
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentSentAt: "2026-07-14T14:00:00Z"
  });
  const store = fakeStore(currentJob);
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: [],
    attributes: {
      inventory_list_managed: true,
      inventory_app_user_id: currentJob.userId
    }
  };
  const authentik = {
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    },
    async sendRecoveryEmail() {
      calls.push("email");
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.equal(store.current().enrollmentRequired, true);
  assert.equal(store.current().enrollmentSentAt, "2026-07-14T14:00:00Z");
  assert.deepEqual(calls, []);
});

test("an Authentik ownership tag for another app user fails closed", async () => {
  const store = fakeStore(job());
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: [],
    attributes: {
      inventory_list_managed: true,
      inventory_app_user_id: "91e8139a-c2ff-4dc1-b423-016a6738a877"
    }
  };
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "identity_conflict");
});

test("a second active job waits while another job owns the global enrollment email", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentJobId: "7040131a-6639-4b77-bc81-c54c02b69804"
  }));
  const calls = [];
  const authentik = {
    async sendRecoveryEmail() {
      calls.push("email");
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "retry_wait");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "enrollment_pending");
  assert.deepEqual(calls, []);
});

test("an enrollment coordination wait never exhausts the provider failure budget", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentJobId: "7040131a-6639-4b77-bc81-c54c02b69804",
    attemptCount: 8
  }));

  await runtime(store, { async sendRecoveryEmail() {} }).processNext();
  assert.equal(store.current().status, "retry_wait");
  assert.equal(store.current().attemptCount, 7);
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "enrollment_pending");
});

test("a globally completed enrollment satisfies another active membership without another email", async () => {
  const sentAt = "2026-07-14T14:00:00Z";
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentSentAt: sentAt
  }));
  const calls = [];
  const authentik = {
    async sendRecoveryEmail() {
      calls.push("email");
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.equal(store.current().enrollmentSentAt, sentAt);
  assert.deepEqual(calls, []);
});

test("an explicit enrollment resend still sends after global enrollment", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    enrollmentResendRequested: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentSentAt: "2026-07-14T14:00:00Z"
  }));
  const calls = [];
  const authentik = {
    async sendRecoveryEmail() {
      calls.push("email");
      return { sent: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(calls, ["email"]);
});

test("a verified login cancels a queued setup-email resend before dispatch", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    enrollmentResendRequested: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikSubject: "stable-oidc-subject",
    authentikOidcUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentSentAt: "2026-07-14T14:00:00Z"
  }));
  const calls = [];

  await runtime(store, {
    async sendRecoveryEmail() {
      calls.push("email");
    }
  }).processNext();

  assert.equal(store.current().status, "pending");
  assert.equal(store.current().currentStep, "identity");
  assert.equal(store.current().enrollmentRequired, false);
  assert.deepEqual(calls, []);
});

test("a verified login heals a stale ambiguous dispatch marker without another email", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    enrollmentDispatchStartedAt: "2026-07-14T14:59:59Z",
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikSubject: "stable-oidc-subject",
    authentikOidcUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentJobId: job().id
  }));
  const calls = [];

  await runtime(store, {
    async sendRecoveryEmail() {
      calls.push("email");
    }
  }).processNext();

  assert.equal(store.current().status, "pending");
  assert.equal(store.current().currentStep, "identity");
  assert.equal(store.current().enrollmentDispatchStartedAt, null);
  assert.deepEqual(calls, []);
});

test("an ambiguous enrollment dispatch requires an explicit retry and is not auto-retried", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  }));
  const calls = [];
  const authentik = {
    async sendRecoveryEmail() {
      calls.push("email");
      throw new Error("ambiguous transport failure");
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.current().enrollmentDispatchStartedAt, "2026-07-14T14:59:59Z");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "enrollment_delivery_unknown");
  assert.deepEqual(calls, ["email"]);
});

test("a successful email followed by uncertain persistence is recorded as ambiguous delivery", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  }));
  store.recordEnrollmentSent = async () => {
    throw new Error("database commit result unavailable");
  };
  const calls = [];

  await runtime(store, {
    async sendRecoveryEmail() {
      calls.push("email");
      return { sent: true };
    }
  }).processNext();

  assert.equal(store.current().status, "failed");
  assert.equal(store.current().enrollmentDispatchStartedAt, "2026-07-14T14:59:59Z");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "enrollment_delivery_unknown");
  assert.deepEqual(calls, ["email"]);
});

test("a rejected recovery email releases its owner and reports missing permission", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  }));
  const rejected = new Error("forbidden");
  rejected.statusCode = 403;

  await runtime(store, {
    async sendRecoveryEmail() {
      throw rejected;
    }
  }).processNext();

  assert.equal(store.current().status, "failed");
  assert.equal(store.current().enrollmentDispatchStartedAt, null);
  assert.equal(store.current().authentikEnrollmentJobId, null);
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "provider_not_authorized");
  assert.equal(store.events.some(([name]) => name === "enrollment_dispatch_released"), true);
});

test("a rate-limited recovery email releases its owner and retries safely", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  }));
  const rejected = new Error("rate limited");
  rejected.statusCode = 429;

  await runtime(store, {
    async sendRecoveryEmail() {
      throw rejected;
    }
  }).processNext();

  assert.equal(store.current().status, "retry_wait");
  assert.equal(store.current().enrollmentDispatchStartedAt, null);
  assert.equal(store.current().authentikEnrollmentJobId, null);
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "provider_rate_limited");
  assert.equal(store.events.some(([name]) => name === "enrollment_dispatch_released"), true);
});

test("a durable ambiguous enrollment marker blocks another automatic email", async () => {
  const store = fakeStore(job({
    currentStep: "enrollment",
    enrollmentRequired: true,
    enrollmentDispatchStartedAt: "2026-07-14T14:59:59Z",
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikManagedByApp: true
  }));
  const calls = [];

  await runtime(store, {
    async sendRecoveryEmail() {
      calls.push("email");
    }
  }).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "enrollment_delivery_unknown");
  assert.deepEqual(calls, []);
});

test("a verified login satisfies a crashed enrollment before reconciliation can resend", async () => {
  const store = fakeStore(job({
    currentStep: "identity",
    enrollmentRequired: true,
    enrollmentDispatchStartedAt: "2026-07-14T14:59:59Z",
    authentikUserPk: 43,
    authentikUserUuid: userUuid,
    authentikSubject: "stable-oidc-subject",
    authentikOidcUserUuid: userUuid,
    authentikManagedByApp: true,
    authentikEnrollmentJobId: job().id
  }));
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: []
  };
  const emails = [];
  const authentik = {
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: tenantGroup, created: false };
    },
    async ensureUserInGroup() {
      return { changed: true };
    },
    async sendRecoveryEmail() {
      emails.push("email");
    }
  };

  await runtime(store, authentik).processNext();

  assert.equal(store.current().status, "succeeded");
  assert.equal(store.current().enrollmentRequired, false);
  assert.equal(store.current().enrollmentDispatchStartedAt, null);
  assert.equal(store.current().authentikEnrollmentJobId, null);
  assert.ok(store.current().authentikEnrollmentSentAt);
  assert.deepEqual(emails, []);
});

test("a real failed enrollment is requeued when immutable login proves setup succeeded", async () => {
  const failedJob = databaseJob({
    current_step: "enrollment",
    status: "failed",
    enrollment_required: true,
    enrollment_sent_at: null,
    enrollment_dispatch_started_at: "2026-07-14T14:59:59Z",
    last_error_code: "enrollment_delivery_unknown"
  });
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT j\.id[\s\S]*ORDER BY j\.id[\s\S]*FOR UPDATE OF j/i.test(text)) {
        return { rows: [{ id: failedJob.id }] };
      }
      if (/SELECT id, account_type, authentik_subject/i.test(text)) {
        return { rows: [{
          id: job().userId,
          account_type: "authentik",
          authentik_subject: "stable-oidc-subject",
          authentik_user_pk: 43,
          authentik_user_uuid: userUuid,
          authentik_oidc_user_uuid: userUuid,
          authentik_enrollment_sent_at: null,
          authentik_enrollment_job_id: failedJob.id
        }] };
      }
      if (/UPDATE app_users[\s\S]*authentik_enrollment_job_id = NULL/i.test(text)) return { rows: [] };
      if (/WITH targets AS/i.test(text)) {
        return { rows: [{ status: "pending", reconcile_requested: false }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };

  const result = await satisfyEnrollmentFromVerifiedLogin(job().userId, {
    transactionFn: operation => operation(client)
  });

  assert.deepEqual(result, { satisfied: true, workRequested: true });
  assert.match(calls[3].text, /enrollment_required = CASE[\s\S]*THEN false/i);
  assert.match(calls[3].text, /enrollment_sent_at = CASE[\s\S]*THEN NULL/i);
  assert.match(calls[3].text, /j\.status IN \('pending', 'retry_wait', 'failed'\)[\s\S]*THEN 'pending'/i);
});

test("verified provider-only login is a no-op until management identity is linked", async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT j\.id[\s\S]*ORDER BY j\.id/i.test(text)) return { rows: [] };
      if (/SELECT id, account_type, authentik_subject/i.test(text)) {
        return { rows: [{
          id: job().userId,
          account_type: "authentik",
          authentik_subject: "provider-only-subject",
          authentik_user_pk: null,
          authentik_user_uuid: null,
          authentik_oidc_user_uuid: userUuid,
          authentik_enrollment_sent_at: null,
          authentik_enrollment_job_id: null
        }] };
      }
      assert.fail(`Unlinked login must not write enrollment state: ${text}`);
    }
  };

  const result = await satisfyEnrollmentFromVerifiedLogin(job().userId, {
    transactionFn: operation => operation(client)
  });

  assert.deepEqual(result, { satisfied: false, workRequested: false });
  assert.equal(calls.length, 2);
});

test("a superseding disable waits for an in-flight add and restarts from database state", async () => {
  const store = fakeStore(job({
    enrollmentRequired: true,
    enrollmentSentAt: "2026-07-14T14:58:00Z"
  }));
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: []
  };
  const authentik = {
    async createOrLinkUser() {
      calls.push("create");
      store.requestReconcile({
        desiredState: "disabled",
        membershipStatus: "disabled"
      });
      return { user: providerUser, created: false };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "pending");
  assert.equal(store.current().desiredState, "disabled");
  assert.equal(store.current().enrollmentRequired, false);
  assert.equal(store.current().enrollmentSentAt, null);
  assert.deepEqual(store.events.find(([name]) => name === "restart"), ["restart", 0]);
  assert.deepEqual(calls, ["create"]);
});

test("a superseding enable waits for an in-flight remove and restarts after it settles", async () => {
  const store = fakeStore(job({
    currentStep: "groups",
    desiredState: "disabled",
    membershipStatus: "disabled",
    enrollmentRequired: false,
    authentikUserPk: 43,
    authentikUserUuid: userUuid
  }));
  const calls = [];
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: [tenantGroup.pk]
  };
  const authentik = {
    async getUserById() {
      return providerUser;
    },
    async findGroupByName() {
      return tenantGroup;
    },
    async ensureUserNotInGroup() {
      calls.push("remove");
      store.requestReconcile({
        desiredState: "active",
        membershipStatus: "invited"
      });
      return { changed: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "pending");
  assert.equal(store.current().desiredState, "active");
  assert.deepEqual(store.events.find(([name]) => name === "restart"), ["restart", 0]);
  assert.deepEqual(calls, ["remove"]);
});

test("a superseded ambiguous timeout enforces a quiet period before opposite reconciliation", async () => {
  const store = fakeStore(job());
  const providerError = new Error("request timed out after dispatch");
  providerError.code = "authentik_timeout";
  const authentik = {
    async createOrLinkUser() {
      store.requestReconcile({
        desiredState: "disabled",
        membershipStatus: "disabled"
      });
      throw providerError;
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "retry_wait");
  assert.equal(store.current().desiredState, "disabled");
  assert.deepEqual(store.events.find(([name]) => name === "restart"), ["restart", 90_000]);
  assert.equal(store.events.some(([name]) => name === "fail"), false);
});

test("an explicitly inactive Authentik identity fails closed instead of appearing ready", async () => {
  const store = fakeStore(job());
  const providerUser = {
    pk: 43,
    uuid: userUuid,
    email: "person@example.test",
    groups: [],
    is_active: false
  };
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "identity_inactive");
});

test("a deleted linked user reports identity-not-found during identity reconciliation", async () => {
  const store = fakeStore(job({
    authentikUserPk: 43,
    authentikUserUuid: userUuid
  }));
  const notFound = new Error("not found");
  notFound.statusCode = 404;
  const authentik = {
    async getUserById() {
      throw notFound;
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "identity_not_found");
});

test("a deleted linked user reports identity-not-found during group reconciliation", async () => {
  const store = fakeStore(job({
    currentStep: "groups",
    authentikUserPk: 43,
    authentikUserUuid: userUuid
  }));
  const notFound = new Error("not found");
  notFound.statusCode = 404;
  const authentik = {
    async getUserById() {
      throw notFound;
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "identity_not_found");
});

test("a superuser group is never used for permanent team access", async () => {
  const store = fakeStore(job());
  const providerUser = { pk: 43, uuid: userUuid, email: "person@example.test", groups: [], is_active: true };
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName() {
      return { ...baseGroup, is_superuser: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "unsafe_group");
});

test("a group with a parent or assigned role is never used for permanent access", async () => {
  for (const unsafeBaseGroup of [
    { ...baseGroup, parents: ["2c04b8a4-4e31-4d8a-87fe-33a8f4a898bc"] },
    { ...baseGroup, roles: ["49591068-0f64-4a9d-a1bd-d2c9ebcd40dc"] },
    { ...baseGroup, parents: undefined },
    { ...baseGroup, roles: undefined }
  ]) {
    const store = fakeStore(job());
    const providerUser = {
      pk: 43,
      uuid: userUuid,
      email: "person@example.test",
      groups: [],
      is_active: true
    };
    const calls = [];
    const authentik = {
      async createOrLinkUser() {
        return { user: providerUser, created: false };
      },
      async getUserById() {
        return providerUser;
      },
      async findGroupByName() {
        return unsafeBaseGroup;
      },
      async ensureUserInGroup() {
        calls.push("membership-change");
      }
    };

    await runtime(store, authentik).processNext();
    assert.equal(store.current().status, "failed");
    assert.equal(store.events.find(([name]) => name === "fail")[1].code, "unsafe_group");
    assert.deepEqual(calls, []);
  }
});

test("disabling an uncreated invite does not create an Authentik identity", async () => {
  const store = fakeStore(job({
    desiredState: "disabled",
    membershipStatus: "disabled",
    enrollmentRequired: false
  }));
  const calls = [];
  const authentik = {
    async findUserByEmail(email) {
      calls.push(["find", email]);
      return null;
    },
    async createOrLinkUser() {
      calls.push(["create"]);
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(calls, [["find", "person@example.test"]]);
});

test("disable removes only the exact tenant group and preserves the base login group", async () => {
  const store = fakeStore(job({
    desiredState: "disabled",
    membershipStatus: "disabled",
    enrollmentRequired: false,
    authentikUserPk: 42,
    authentikUserUuid: userUuid
  }));
  const removed = [];
  const providerUser = {
    pk: 42,
    uuid: userUuid,
    is_active: true,
    email: "person@example.test",
    groups: [baseGroup.pk, tenantGroup.pk]
  };
  const authentik = {
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : tenantGroup;
    },
    async ensureUserNotInGroup(_user, group) {
      removed.push(group.name);
      return { changed: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "succeeded");
  assert.deepEqual(removed, ["876en-ms"]);
});

test("tenant group creation is fenced away from global administrator group names", async () => {
  const store = fakeStore(job({ tenantSlug: "platoon-admin" }));
  const calls = [];
  const providerUser = { pk: 42, uuid: userUuid, email: "person@example.test", groups: [], is_active: true };
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      calls.push(["find", name]);
      return baseGroup;
    },
    async ensureGroup(options) {
      calls.push(["ensure", options]);
      return { group: tenantGroup, created: false };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(calls.length, 0);
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "invalid_target");
});

test("a privileged base group is rejected before any Authentik call", async () => {
  const store = fakeStore(job());
  const calls = [];
  const authentik = new Proxy({}, {
    get() {
      return async () => {
        calls.push("provider-call");
      };
    }
  });

  await runtime(
    store,
    authentik,
    { warn() {} },
    true,
    { baseGroup: "876en-admins" }
  ).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "invalid_target");
  assert.deepEqual(calls, []);
});

test("recordIdentity rechecks the locked OIDC UUID before persisting management identity", async () => {
  const differentUuid = "91e8139a-c2ff-4dc1-b423-016a6738a877";
  const responses = [
    { rows: [{ id: job().membershipId, user_id: job().userId }] },
    { rows: [{ id: job().id, tenant_membership_id: job().membershipId }] },
    {
      rows: [{
        id: job().userId,
        authentik_subject: "concurrent-login-subject",
        authentik_user_pk: null,
        authentik_user_uuid: null,
        authentik_oidc_user_uuid: differentUuid,
        authentik_managed_by_app: false,
        authentik_enrollment_sent_at: null
      }]
    },
    { rows: [{ id: job().id }] }
  ];
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      const response = responses.shift();
      assert.ok(response, `Unexpected query: ${text}`);
      return response;
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  await assert.rejects(
    store.recordIdentity(job(), { pk: 42, uuid: userUuid }, {
      managedByApp: true,
      enrollmentCandidate: true,
      subjectIsUserUuid: false
    }),
    error => error?.code === "identity_conflict"
  );
  assert.equal(calls.length, 4);
  assert.match(calls[2].text, /FROM app_users[\s\S]*FOR UPDATE/i);
  assert.match(calls[1].text, /ORDER BY j\.id[\s\S]*FOR UPDATE OF j/i);
});

test("recordIdentity refuses a UUID already pinned by another user's OIDC login", async () => {
  const responses = [
    { rows: [{ id: job().membershipId, user_id: job().userId }] },
    { rows: [{ id: job().id, tenant_membership_id: job().membershipId }] },
    {
      rows: [{
        id: job().userId,
        authentik_subject: null,
        authentik_user_pk: null,
        authentik_user_uuid: null,
        authentik_oidc_user_uuid: null,
        authentik_managed_by_app: false,
        authentik_enrollment_sent_at: null
      }]
    },
    { rows: [{ id: job().id }] },
    { rows: [{ id: "5dd4af6d-a2a2-47fb-a2af-046a62c035db" }] }
  ];
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      const response = responses.shift();
      assert.ok(response, `Unexpected query: ${text}`);
      return response;
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  await assert.rejects(
    store.recordIdentity(job(), { pk: 42, uuid: userUuid }, {
      managedByApp: true,
      enrollmentCandidate: true
    }),
    error => error?.code === "identity_conflict"
  );
  assert.equal(calls.length, 5);
  assert.match(calls[4].text, /authentik_oidc_user_uuid = \$3/i);
});

test("recordIdentity refuses a UUID already owned by a legacy UUID-subject user", async () => {
  const responses = [
    { rows: [{ id: job().membershipId, user_id: job().userId }] },
    { rows: [{ id: job().id, tenant_membership_id: job().membershipId }] },
    {
      rows: [{
        id: job().userId,
        authentik_subject: null,
        authentik_user_pk: null,
        authentik_user_uuid: null,
        authentik_oidc_user_uuid: null,
        authentik_managed_by_app: false,
        authentik_enrollment_sent_at: null
      }]
    },
    { rows: [{ id: job().id }] },
    { rows: [{ id: "5dd4af6d-a2a2-47fb-a2af-046a62c035db" }] }
  ];
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      const response = responses.shift();
      assert.ok(response, `Unexpected query: ${text}`);
      return response;
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  await assert.rejects(
    store.recordIdentity(job(), { pk: 42, uuid: userUuid }, {
      managedByApp: true,
      enrollmentCandidate: true,
      subjectIsUserUuid: true
    }),
    error => error?.code === "identity_conflict"
  );
  assert.equal(calls[4].params[3], true);
  assert.match(calls[4].text, /lower\(authentik_subject\) = \$3::text/i);
});

test("recordIdentity fences sibling enrollment work when immutable login is already verified", async () => {
  const siblingJobId = "fda25bf4-43cf-4d7f-919f-7fb85ca09792";
  const currentJob = databaseJob();
  const siblingJob = databaseJob({
    id: siblingJobId,
    current_step: "enrollment",
    status: "failed",
    enrollment_required: true,
    last_error_code: "enrollment_delivery_unknown"
  });
  const user = {
    id: job().userId,
    account_type: "authentik",
    authentik_subject: "stable-oidc-subject",
    authentik_oidc_user_uuid: userUuid,
    authentik_user_pk: 43,
    authentik_user_uuid: userUuid,
    authentik_managed_by_app: true,
    authentik_enrollment_sent_at: "2026-07-14T15:00:00Z",
    authentik_enrollment_job_id: siblingJobId
  };
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id[\s\S]*FOR UPDATE OF j/i.test(text)) {
        return { rows: [currentJob, siblingJob] };
      }
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) return { rows: [user] };
      if (/SELECT j\.id[\s\S]*j\.current_step = 'identity'/i.test(text)) {
        return { rows: [{ id: job().id }] };
      }
      if (/SELECT id[\s\S]*FROM app_users[\s\S]*WHERE id <>/i.test(text)) return { rows: [] };
      if (/UPDATE app_users[\s\S]*authentik_user_pk = \$2/i.test(text)) return { rows: [] };
      if (/SELECT id, account_type, authentik_subject/i.test(text)) return { rows: [user] };
      if (/UPDATE app_users[\s\S]*authentik_enrollment_job_id = NULL/i.test(text)) return { rows: [] };
      if (/WITH targets AS/i.test(text)) {
        return { rows: [{ status: "pending", reconcile_requested: false }] };
      }
      if (/UPDATE authentik_provisioning_jobs[\s\S]*SET current_step = 'groups'/i.test(text)) {
        return { rows: [{ id: job().id }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  await store.recordIdentity(job(), { pk: 43, uuid: userUuid }, {
    managedByApp: true,
    enrollmentCandidate: true
  });

  const transition = calls.find(call => /WITH targets AS/i.test(call.text));
  assert.ok(transition);
  assert.deepEqual(transition.params[1], [job().id, siblingJobId]);
  assert.match(transition.text, /j\.status IN \('pending', 'retry_wait', 'failed'\)[\s\S]*THEN 'pending'/i);
  assert.match(transition.text, /j\.status = 'running'[\s\S]*THEN true/i);
});

test("manual retry atomically acknowledges and transfers a failed unknown enrollment owner", async () => {
  const ownerJobId = "11111111-1111-4111-8111-111111111111";
  const ownerMembershipId = "22222222-2222-4222-8222-222222222222";
  const target = databaseJob({ status: "failed", last_error_code: "enrollment_pending" });
  const owner = databaseJob({
    id: ownerJobId,
    tenant_membership_id: ownerMembershipId,
    status: "failed",
    last_error_code: "enrollment_delivery_unknown",
    enrollment_dispatch_started_at: "2026-07-14T12:01:00Z"
  });
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id[\s\S]*FOR UPDATE OF j/i.test(text)) {
        return { rows: [owner, target] };
      }
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) {
        return { rows: [{ id: job().userId, authentik_enrollment_job_id: ownerJobId }] };
      }
      if (/SET enrollment_dispatch_started_at = NULL, updated_at = now\(\)/i.test(text)) {
        return { rows: [] };
      }
      if (/SET authentik_enrollment_job_id = NULL/i.test(text)) return { rows: [] };
      if (/SET status = 'pending'/i.test(text)) {
        return { rows: [{ ...target, status: "pending", target_revision: 2 }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  const retried = await store.retry(job().membershipId, null, { tenantId: job().tenantId });

  assert.equal(retried.status, "pending");
  assert.equal(retried.acknowledgedUnknownEnrollment, true);
  assert.equal(calls.findIndex(call => /ORDER BY j\.id/i.test(call.text)), 1);
  assert.equal(calls.findIndex(call => /FROM app_users/i.test(call.text)), 2);
  assert.equal(calls.some(call => call.params?.[0] === ownerJobId && /enrollment_dispatch_started_at = NULL/i.test(call.text)), true);
  assert.equal(calls.some(call => /authentik_enrollment_job_id = NULL/i.test(call.text)), true);
});

test("manual retry never clears a running enrollment owner", async () => {
  const ownerJobId = "11111111-1111-4111-8111-111111111111";
  const target = databaseJob({ status: "failed", last_error_code: "enrollment_pending" });
  const owner = databaseJob({
    id: ownerJobId,
    tenant_membership_id: "22222222-2222-4222-8222-222222222222",
    status: "running",
    enrollment_dispatch_started_at: "2026-07-14T12:01:00Z"
  });
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id/i.test(text)) return { rows: [owner, target] };
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) {
        return { rows: [{ id: job().userId, authentik_enrollment_job_id: ownerJobId }] };
      }
      if (/SET status = 'pending'/i.test(text)) {
        return { rows: [{ ...target, status: "pending", target_revision: 2 }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  const retried = await store.retry(job().membershipId, null);

  assert.equal(retried.acknowledgedUnknownEnrollment, false);
  assert.equal(calls.some(call => /authentik_enrollment_job_id = NULL/i.test(call.text)), false);
  assert.equal(calls.some(call => call.params?.[0] === ownerJobId && /enrollment_dispatch_started_at = NULL/i.test(call.text)), false);
});

test("manual retry releases an ambiguous owner after superseding disable completes", async () => {
  const ownerJobId = "11111111-1111-4111-8111-111111111111";
  const target = databaseJob({ status: "failed", last_error_code: "enrollment_delivery_unknown" });
  const disabledOwner = databaseJob({
    id: ownerJobId,
    tenant_membership_id: "22222222-2222-4222-8222-222222222222",
    desired_state: "disabled",
    status: "succeeded",
    enrollment_dispatch_started_at: "2026-07-14T12:01:00Z"
  });
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id/i.test(text)) return { rows: [disabledOwner, target] };
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) {
        return { rows: [{ id: job().userId, authentik_enrollment_job_id: ownerJobId }] };
      }
      if (/SET enrollment_dispatch_started_at = NULL, updated_at = now\(\)/i.test(text)) return { rows: [] };
      if (/SET authentik_enrollment_job_id = NULL/i.test(text)) return { rows: [] };
      if (/SET status = 'pending'/i.test(text)) {
        return { rows: [{ ...target, status: "pending", current_step: "identity", target_revision: 2 }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  const retried = await store.retry(job().membershipId, null);

  assert.equal(retried.acknowledgedUnknownEnrollment, true);
  assert.equal(retried.currentStep, "identity");
  assert.equal(calls.some(call => call.params?.[0] === ownerJobId && /enrollment_dispatch_started_at = NULL/i.test(call.text)), true);
  assert.equal(calls.some(call => /authentik_enrollment_job_id = NULL/i.test(call.text)), true);
});

test("manual retry acknowledges its own unknown enrollment dispatch", async () => {
  const target = databaseJob({
    status: "failed",
    last_error_code: "enrollment_delivery_unknown",
    enrollment_dispatch_started_at: "2026-07-14T12:01:00Z"
  });
  const client = {
    async query(text) {
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id/i.test(text)) return { rows: [target] };
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) {
        return { rows: [{ id: job().userId, authentik_enrollment_job_id: target.id }] };
      }
      if (/SET status = 'pending'/i.test(text)) {
        return { rows: [{ ...target, status: "pending", target_revision: 2, enrollment_dispatch_started_at: null }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  const retried = await store.retry(job().membershipId, null);
  assert.equal(retried.acknowledgedUnknownEnrollment, true);
});

test("manual retry canonicalizes an uppercase membership UUID", async () => {
  const target = databaseJob({ status: "failed", last_error_code: "provider_unavailable" });
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (/SELECT id, user_id[\s\S]*FROM tenant_memberships/i.test(text)) {
        return { rows: [{ id: job().membershipId, user_id: job().userId }] };
      }
      if (/SELECT j\.\*[\s\S]*ORDER BY j\.id/i.test(text)) return { rows: [target] };
      if (/SELECT \*[\s\S]*FROM app_users/i.test(text)) {
        return { rows: [{ id: job().userId, authentik_enrollment_job_id: null }] };
      }
      if (/SET status = 'pending'/i.test(text)) {
        return { rows: [{ ...target, status: "pending", current_step: "identity", target_revision: 2 }] };
      }
      assert.fail(`Unexpected query: ${text}`);
    }
  };
  const store = createPostgresStore({
    queryFn: async () => ({ rows: [] }),
    transactionFn: operation => operation(client),
    leaseSeconds: 90
  });

  const retried = await store.retry(job().membershipId.toUpperCase(), null);

  assert.equal(retried.status, "pending");
  assert.equal(calls[0].params[0], job().membershipId);
});

test("an untagged existing tenant group collision fails before membership changes", async () => {
  const store = fakeStore(job());
  const providerUser = { pk: 43, uuid: userUuid, email: "person@example.test", groups: [], is_active: true };
  const calls = [];
  const authentik = {
    async createOrLinkUser() {
      return { user: providerUser, created: false };
    },
    async getUserById() {
      return providerUser;
    },
    async findGroupByName(name) {
      return name === "876en" ? baseGroup : null;
    },
    async ensureGroup() {
      return { group: { ...tenantGroup, attributes: {} }, created: false };
    },
    async ensureUserInGroup() {
      calls.push("membership-change");
      return { changed: true };
    }
  };

  await runtime(store, authentik).processNext();
  assert.equal(store.current().status, "failed");
  assert.equal(store.events.find(([name]) => name === "fail")[1].code, "group_conflict");
  assert.deepEqual(calls, []);
});

test("provider errors are reduced to safe retry state before storage or logging", async () => {
  const store = fakeStore(job());
  const logs = [];
  const secret = "Bearer must-never-be-persisted";
  const providerError = new Error(`upstream said ${secret}`);
  providerError.statusCode = 503;
  const authentik = {
    async createOrLinkUser() {
      throw providerError;
    }
  };

  await runtime(store, authentik, { warn(message) { logs.push(message); } }).processNext();
  const failure = store.events.find(([name]) => name === "fail")[1];
  assert.deepEqual(failure, {
    code: "provider_unavailable",
    message: "The account service is temporarily unavailable. Provisioning will retry automatically.",
    retryable: true
  });
  assert.doesNotMatch(JSON.stringify({ failure, logs }), /must-never-be-persisted/);
  assert.equal(store.current().status, "retry_wait");
});

test("enqueue remains database-available while the external worker feature is disabled", async () => {
  const store = fakeStore(job());
  const provisioning = runtime(store, null, { warn() {} }, false);
  const result = await provisioning.enqueueMembershipProvisioning({ query() {} }, {
    membershipId: job().membershipId,
    desiredRole: "contributor",
    desiredState: "disabled",
    requestedBy: job().userId
  });
  assert.equal(result.status, "pending");
  assert.equal(provisioning.start(), false);
});

test("the PostgreSQL worker claim uses SKIP LOCKED, leases, and revision fences", async () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.resolve(currentDirectory, "../src/provisioning.js"), "utf8");
  assert.match(source, /FOR UPDATE OF j SKIP LOCKED/i);
  assert.match(source, /lease_expires_at <= now\(\)/i);
  assert.match(source, /target_revision = \$2[\s\S]*lease_token = \$3/i);
  assert.match(source, /last_safe_error/i);
  assert.match(source, /EXCLUDED\.desired_state = 'active'[\s\S]*existing\.enrollment_required = false[\s\S]*THEN NULL/i);
  assert.match(source, /j\.status = 'succeeded'[\s\S]*j\.current_step = 'complete'[\s\S]*j\.enrollment_sent_at IS NOT NULL/i);
  assert.match(source, /authentik_enrollment_sent_at[\s\S]*FOR UPDATE[\s\S]*shouldEnroll[\s\S]*!user\.authentik_enrollment_sent_at/i);
  assert.match(source, /authentik_enrollment_job_id[\s\S]*owner\.status AS owner_status[\s\S]*FOR UPDATE OF j, u/i);
  assert.match(
    source,
    /scope\.user\.authentik_subject[\s\S]*satisfyEnrollmentFromVerifiedLogin\(scope\.user\.id[\s\S]*signedIn: true/i
  );
  assert.match(source, /existing\.status = 'running'[\s\S]*existing\.lease_token[\s\S]*reconcile_requested = existing\.status = 'running'/i);
  assert.match(source, /restartIfRequested[\s\S]*status = CASE WHEN \$6 > 0 THEN 'retry_wait' ELSE 'pending' END/i);
  assert.match(source, /SELECT role AS membership_role, status AS membership_status[\s\S]*FOR UPDATE[\s\S]*FROM authentik_provisioning_jobs[\s\S]*FOR UPDATE/i);
  assert.match(source, /enrollment_dispatch_started_at = now\(\)[\s\S]*sendRecoveryEmail[\s\S]*recordEnrollmentSent/i);
  assert.match(source, /enrollment_pending'[\s\S]*GREATEST\(attempt_count - 1, 0\)/i);
  assert.doesNotMatch(source, /last_(?:raw_)?error_detail/i);
});
