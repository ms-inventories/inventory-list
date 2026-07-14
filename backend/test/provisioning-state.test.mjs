import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  nextProvisioningStep,
  normalizeProvisioningTarget,
  provisioningPlan,
  retryDelayMs,
  safeProvisioningFailure
} from "../src/provisioning-state.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(testDirectory, "../db/019_authentik_provisioning.sql");
const enrollmentMigrationPath = path.resolve(testDirectory, "../db/020_authentik_enrollment_claims.sql");
const oidcIdentityMigrationPath = path.resolve(testDirectory, "../db/021_authentik_oidc_identity.sql");
const uuidOwnershipMigrationPath = path.resolve(testDirectory, "../db/022_authentik_uuid_ownership.sql");
const reconcileFencingMigrationPath = path.resolve(testDirectory, "../db/023_authentik_reconcile_fencing.sql");

test("permanent provisioning targets use tenant membership roles and explicit active state", () => {
  assert.deepEqual(
    normalizeProvisioningTarget({ role: "contributor", state: "active" }),
    { desiredRole: "contributor", desiredState: "active" }
  );
  assert.deepEqual(
    normalizeProvisioningTarget({ role: "tenant_admin", state: "disabled" }),
    { desiredRole: "tenant_admin", desiredState: "disabled" }
  );
  assert.throws(
    () => normalizeProvisioningTarget({ role: "platform_admin", state: "active" }),
    error => error.code === "invalid_target"
  );
  assert.throws(
    () => normalizeProvisioningTarget({ role: "contributor", state: "invited" }),
    error => error.code === "invalid_target"
  );
});

test("provisioning plans enroll a new active identity once and skip enrollment otherwise", () => {
  assert.deepEqual(
    provisioningPlan({ desiredState: "active" }),
    ["identity", "groups", "enrollment", "complete"]
  );
  assert.deepEqual(
    provisioningPlan({ desiredState: "active", enrollmentSentAt: "2026-07-14T12:00:00Z" }),
    ["identity", "groups", "complete"]
  );
  assert.deepEqual(
    provisioningPlan({ desiredState: "active", enrollmentRequired: false }),
    ["identity", "groups", "complete"]
  );
  assert.deepEqual(
    provisioningPlan({ desiredState: "disabled" }),
    ["identity", "groups", "complete"]
  );
  assert.equal(
    nextProvisioningStep({ completedStep: "groups", desiredState: "active" }),
    "enrollment"
  );
  assert.equal(
    nextProvisioningStep({
      completedStep: "groups",
      desiredState: "active",
      enrollmentSentAt: "2026-07-14T12:00:00Z"
    }),
    "complete"
  );
  assert.equal(
    nextProvisioningStep({ completedStep: "groups", desiredState: "disabled" }),
    "complete"
  );
});

test("retry backoff is deterministic and bounded", () => {
  assert.equal(retryDelayMs(1), 5_000);
  assert.equal(retryDelayMs(2), 10_000);
  assert.equal(retryDelayMs(20), 15 * 60_000);
  assert.throws(() => retryDelayMs(0), /positive integer/);
});

test("safe failures never persist arbitrary provider messages or secrets", () => {
  const secret = "Bearer never-store-this-token";
  const unavailable = safeProvisioningFailure({ status: 503, message: secret, responseBody: secret });
  assert.deepEqual(unavailable, {
    code: "provider_unavailable",
    message: "The account service is temporarily unavailable. Provisioning will retry automatically.",
    retryable: true
  });
  assert.doesNotMatch(JSON.stringify(unavailable), /never-store-this-token/);

  const unauthorized = safeProvisioningFailure({ statusCode: 403, message: secret });
  assert.equal(unauthorized.code, "provider_not_authorized");
  assert.equal(unauthorized.retryable, false);

  const unknown = safeProvisioningFailure({ message: secret });
  assert.equal(unknown.code, "unknown");
  assert.doesNotMatch(unknown.message, /Bearer|token/i);

  assert.equal(
    safeProvisioningFailure({ code: "authentik_user_ambiguous", message: secret }).code,
    "identity_ambiguous"
  );
  assert.match(
    safeProvisioningFailure({ code: "identity_not_found", message: secret }).message,
    /linked Authentik account/i
  );
  assert.match(
    safeProvisioningFailure({ code: "identity_inactive", message: secret }).message,
    /reactivate/i
  );
  assert.match(
    safeProvisioningFailure({ code: "unsafe_group", message: secret }).message,
    /parent.*assigned role.*superuser/i
  );
  assert.match(
    safeProvisioningFailure({ code: "enrollment_delivery_unknown", message: secret }).message,
    /may have been sent.*retry manually/i
  );
  assert.deepEqual(
    safeProvisioningFailure({ code: "authentik_timeout", message: secret }),
    {
      code: "provider_unavailable",
      message: "The account service is temporarily unavailable. Provisioning will retry automatically.",
      retryable: true
    }
  );
});

test("migration stores immutable Authentik identity keys and one fenced job per membership", async () => {
  const sql = await fs.readFile(migrationPath, "utf8");
  assert.match(sql, /authentik_user_pk bigint/i);
  assert.match(sql, /authentik_user_uuid uuid/i);
  assert.match(sql, /authentik_managed_by_app boolean/i);
  assert.match(sql, /authentik_linked_at timestamptz/i);
  assert.match(sql, /tenant_membership_id uuid NOT NULL UNIQUE/i);
  assert.match(sql, /target_revision integer NOT NULL/i);
  assert.match(sql, /last_safe_error text/i);
  assert.match(sql, /enrollment_required boolean/i);
  assert.match(sql, /enrollment_sent_at timestamptz/i);
  assert.match(sql, /status = 'retry_wait' AND next_attempt_at IS NOT NULL/i);
  assert.doesNotMatch(sql, /password|access_token|refresh_token|api_token/i);
});

test("enrollment migration coordinates one durable sender per app user", async () => {
  const sql = await fs.readFile(enrollmentMigrationPath, "utf8");
  assert.match(sql, /authentik_enrollment_sent_at timestamptz/i);
  assert.match(sql, /authentik_enrollment_job_id uuid/i);
  assert.match(sql, /enrollment_resend_requested boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /REFERENCES authentik_provisioning_jobs\(id\)[\s\S]*ON DELETE SET NULL/i);
  assert.doesNotMatch(sql, /password|access_token|refresh_token|api_token/i);
});

test("OIDC identity migration pins one matching immutable UUID per app user", async () => {
  const sql = await fs.readFile(oidcIdentityMigrationPath, "utf8");
  assert.match(sql, /authentik_oidc_user_uuid uuid/i);
  assert.match(sql, /UNIQUE INDEX[\s\S]*authentik_oidc_user_uuid/i);
  assert.match(
    sql,
    /UNIQUE INDEX[\s\S]*COALESCE\(authentik_user_uuid, authentik_oidc_user_uuid\)/i
  );
  assert.match(
    sql,
    /authentik_user_uuid IS NULL[\s\S]*authentik_oidc_user_uuid IS NULL[\s\S]*authentik_user_uuid = authentik_oidc_user_uuid/i
  );
  assert.doesNotMatch(sql, /password|access_token|refresh_token|api_token/i);
});

test("UUID ownership migration serializes management, OIDC, and legacy UUID subjects", async () => {
  const sql = await fs.readFile(uuidOwnershipMigrationPath, "utf8");
  assert.match(sql, /LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE[\s\S]*DO \$\$/i);
  assert.match(sql, /authentik_subject::uuid/i);
  assert.match(sql, /CASE[\s\S]*WHEN authentik_subject ~\*[\s\S]*THEN authentik_subject::uuid[\s\S]*ELSE NULL[\s\S]*END/i);
  assert.match(sql, /CASE[\s\S]*WHEN existing\.authentik_subject ~\*[\s\S]*THEN existing\.authentik_subject::uuid[\s\S]*ELSE NULL[\s\S]*END = candidate/i);
  assert.doesNotMatch(sql, /authentik_subject ~\*[^\n]+\n\s*AND existing\.authentik_subject::uuid/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(candidate::text, 0\)\)/i);
  assert.match(sql, /authentik_user_uuid = candidate/i);
  assert.match(sql, /authentik_oidc_user_uuid = candidate/i);
  assert.match(sql, /CREATE TRIGGER app_users_authentik_uuid_ownership/i);
  assert.doesNotMatch(sql, /password|access_token|refresh_token|api_token/i);
});

test("reconcile fencing migration preserves leases and records ambiguous email dispatch", async () => {
  const sql = await fs.readFile(reconcileFencingMigrationPath, "utf8");
  assert.match(sql, /reconcile_requested boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /reconcile_requested_by uuid/i);
  assert.match(sql, /enrollment_dispatch_started_at timestamptz/i);
  assert.doesNotMatch(sql, /password|access_token|refresh_token|api_token/i);
});
