import crypto from "node:crypto";
import { createAuthentikClient } from "./authentik.js";
import {
  assertAuthentikProvisioningConfig,
  config
} from "./config.js";
import { query, withTransaction } from "./db.js";
import {
  normalizeProvisioningTarget,
  retryDelayMs,
  safeProvisioningFailure
} from "./provisioning-state.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_LOST = "provisioning_lease_lost";
const MANAGED_ATTRIBUTE = "inventory_list_managed";
const APP_USER_ATTRIBUTE = "inventory_app_user_id";

function runtimeError(code, message = "Permanent account provisioning could not be completed.") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireEnabled(enabled) {
  if (!enabled) throw runtimeError("provider_not_configured");
}

function camelJob(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    membershipId: row.tenant_membership_id,
    desiredRole: row.desired_role,
    desiredState: row.desired_state,
    currentStep: row.current_step,
    status: row.status,
    targetRevision: Number(row.target_revision),
    attemptCount: Number(row.attempt_count),
    enrollmentRequired: row.enrollment_required,
    enrollmentSentAt: row.enrollment_sent_at,
    enrollmentDispatchStartedAt: row.enrollment_dispatch_started_at,
    enrollmentResendRequested: Boolean(row.enrollment_resend_requested),
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastSafeError: row.last_safe_error,
    lastErrorAt: row.last_error_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function privateJob(row) {
  if (!row) return null;
  return {
    ...camelJob(row),
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantStatus: row.tenant_status,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    accountType: row.account_type,
    authentikSubject: row.authentik_subject,
    authentikOidcUserUuid: row.authentik_oidc_user_uuid,
    membershipRole: row.membership_role,
    membershipStatus: row.membership_status,
    authentikUserPk: row.authentik_user_pk === null
      ? null
      : Number(row.authentik_user_pk),
    authentikUserUuid: row.authentik_user_uuid,
    authentikManagedByApp: Boolean(row.authentik_managed_by_app),
    authentikEnrollmentSentAt: row.authentik_enrollment_sent_at,
    authentikEnrollmentJobId: row.authentik_enrollment_job_id,
    leaseToken: row.lease_token
  };
}

function assertIdentity(identity) {
  const pk = Number(identity?.pk);
  const uuid = String(identity?.uuid || "").toLowerCase();
  if (identity?.is_active !== true) {
    throw runtimeError("identity_inactive");
  }
  if (!Number.isSafeInteger(pk) || pk < 1 || !UUID_PATTERN.test(uuid)) {
    throw runtimeError("authentik_invalid_response");
  }
  return { pk, uuid };
}

function assertUnprivilegedGroup(group) {
  if (
    group?.is_superuser !== false
    || !Array.isArray(group?.parents)
    || group.parents.length > 0
    || !Array.isArray(group?.roles)
    || group.roles.length > 0
  ) {
    throw runtimeError("unsafe_group");
  }
  return group;
}

function assertLinkedIdentity(job, identity) {
  const normalized = assertIdentity(identity);
  if (
    normalized.pk !== job.authentikUserPk
    || normalized.uuid !== String(job.authentikUserUuid || "").toLowerCase()
  ) {
    throw runtimeError("identity_conflict");
  }
  return normalized;
}

function boundOidcIdentityUuid(job, { subjectIsUserUuid = false } = {}) {
  if (!job.authentikSubject && !job.authentikOidcUserUuid) return "";
  const oidcUuid = String(
    job.authentikOidcUserUuid
    || (subjectIsUserUuid ? job.authentikSubject : "")
  ).trim().toLowerCase();
  if (!UUID_PATTERN.test(oidcUuid)) {
    throw runtimeError("immutable_identity_missing");
  }
  return oidcUuid;
}

function assertOidcIdentityMatches(job, identity, { subjectIsUserUuid = false } = {}) {
  const oidcUuid = boundOidcIdentityUuid(job, { subjectIsUserUuid });
  if (!oidcUuid) return;
  if (oidcUuid !== identity.uuid) throw runtimeError("identity_conflict");
}

function identityManagedForJob(job, identity, { created = false } = {}) {
  const attributes = identity?.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return Boolean(created);
  }

  const ownerId = String(attributes[APP_USER_ATTRIBUTE] || "").trim();
  if (ownerId && ownerId !== job.userId) {
    throw runtimeError("identity_conflict");
  }

  return Boolean(
    created
    || (
      ownerId === job.userId
      && attributes[MANAGED_ATTRIBUTE] === true
    )
  );
}

function assertTenantGroup(job, group, expectedName) {
  assertUnprivilegedGroup(group);

  const attributes = group?.attributes;
  const managed = attributes?.[MANAGED_ATTRIBUTE] === true;
  const tenantSlug = String(attributes?.inventory_tenant_slug || "").trim().toLowerCase();
  const tenantId = String(attributes?.inventory_tenant_id || "").trim().toLowerCase();
  if (group?.name !== expectedName) {
    throw runtimeError("group_conflict");
  }
  if (
    !managed
    || tenantSlug !== String(job.tenantSlug || "").trim().toLowerCase()
    || tenantId !== String(job.tenantId || "").trim().toLowerCase()
  ) {
    throw runtimeError("group_conflict");
  }
  return group;
}

function provisioningGroupTargets(job, settings) {
  const tenantGroupName = `${settings.tenantGroupPrefix}${job.tenantSlug}`;
  const reservedGroupNames = settings.reservedGroups.map(name => String(name).toLowerCase());
  const baseGroupName = String(settings.baseGroup).toLowerCase();
  const tenantGroupNameLower = tenantGroupName.toLowerCase();
  if (
    tenantGroupName.length > 255
    || reservedGroupNames.includes(baseGroupName)
    || baseGroupName.startsWith(String(settings.tenantGroupPrefix).toLowerCase())
    || tenantGroupNameLower === baseGroupName
    || reservedGroupNames.includes(tenantGroupNameLower)
  ) {
    throw runtimeError("invalid_target");
  }
  return { tenantGroupName };
}

export function safeAuthentikUsername(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (normalized.length <= 150) return normalized;
  return `inventory-${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

function throwLeaseLost() {
  throw runtimeError(LEASE_LOST);
}

function enrollmentRequestDefinitelyRejected(error) {
  if (error?.code === "authentik_config_invalid") return true;
  const status = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(status)
    && status >= 400
    && status <= 499
    && status !== 408;
}

export function createPostgresStore({ queryFn, transactionFn, leaseSeconds }) {
  async function lockProvisioningScope(client, membershipId, { tenantId = null } = {}) {
    const membershipResult = await client.query(
      `
        SELECT id, user_id
        FROM tenant_memberships
        WHERE id = $1
          AND ($2::uuid IS NULL OR tenant_id = $2)
        FOR UPDATE
      `,
      [membershipId, tenantId]
    );
    const membership = membershipResult.rows[0];
    if (!membership) return null;

    const jobsResult = await client.query(
      `
        SELECT j.*
        FROM authentik_provisioning_jobs j
        JOIN tenant_memberships m ON m.id = j.tenant_membership_id
        WHERE m.user_id = $1
        ORDER BY j.id
        FOR UPDATE OF j
      `,
      [membership.user_id]
    );
    const userResult = await client.query(
      `
        SELECT *
        FROM app_users
        WHERE id = $1
        FOR UPDATE
      `,
      [membership.user_id]
    );
    const user = userResult.rows[0];
    if (!user) throw runtimeError("identity_conflict");
    return { membership, jobs: jobsResult.rows, user };
  }

  async function enqueue(client, {
    membershipId,
    desiredRole,
    desiredState,
    requestedBy = null
  }) {
    const result = await client.query(
      `
        INSERT INTO authentik_provisioning_jobs AS existing (
          tenant_membership_id,
          desired_role,
          desired_state,
          requested_by,
          enrollment_required
        )
        SELECT m.id, $2, $3, $4, CASE WHEN $3 = 'disabled' THEN false ELSE NULL END
        FROM tenant_memberships m
        WHERE m.id = $1
          AND m.role = $2
          AND (
            ($3 = 'active' AND m.status IN ('invited', 'active'))
            OR ($3 = 'disabled' AND m.status = 'disabled')
          )
        ON CONFLICT (tenant_membership_id) DO UPDATE
        SET desired_role = CASE
            WHEN existing.status = 'running' THEN existing.desired_role
            ELSE EXCLUDED.desired_role
          END,
          desired_state = CASE
            WHEN existing.status = 'running' THEN existing.desired_state
            ELSE EXCLUDED.desired_state
          END,
          current_step = CASE
            WHEN existing.status = 'running' THEN existing.current_step
            ELSE 'identity'
          END,
          status = CASE
            WHEN existing.status = 'running' THEN existing.status
            ELSE 'pending'
          END,
          target_revision = CASE
            WHEN existing.status = 'running' THEN existing.target_revision
            ELSE existing.target_revision + 1
          END,
          attempt_count = CASE
            WHEN existing.status = 'running' THEN existing.attempt_count
            ELSE 0
          END,
          requested_by = CASE
            WHEN existing.status = 'running' THEN existing.requested_by
            ELSE EXCLUDED.requested_by
          END,
          enrollment_required = CASE
            WHEN existing.status = 'running' THEN existing.enrollment_required
            WHEN EXCLUDED.desired_state = 'active'
              AND existing.enrollment_required = false
              AND existing.enrollment_sent_at IS NULL
              THEN NULL
            ELSE existing.enrollment_required
          END,
          enrollment_resend_requested = CASE
            WHEN existing.status = 'running' THEN existing.enrollment_resend_requested
            ELSE false
          END,
          last_attempt_at = CASE WHEN existing.status = 'running' THEN existing.last_attempt_at ELSE NULL END,
          next_attempt_at = CASE WHEN existing.status = 'running' THEN existing.next_attempt_at ELSE NULL END,
          last_error_code = CASE WHEN existing.status = 'running' THEN existing.last_error_code ELSE NULL END,
          last_safe_error = CASE WHEN existing.status = 'running' THEN existing.last_safe_error ELSE NULL END,
          last_error_at = CASE WHEN existing.status = 'running' THEN existing.last_error_at ELSE NULL END,
          lease_token = CASE WHEN existing.status = 'running' THEN existing.lease_token ELSE NULL END,
          lease_expires_at = CASE WHEN existing.status = 'running' THEN existing.lease_expires_at ELSE NULL END,
          completed_at = CASE WHEN existing.status = 'running' THEN existing.completed_at ELSE NULL END,
          reconcile_requested = existing.status = 'running',
          reconcile_requested_by = CASE
            WHEN existing.status = 'running' THEN EXCLUDED.requested_by
            ELSE NULL
          END,
          updated_at = now()
        RETURNING *
      `,
      [membershipId, desiredRole, desiredState, requestedBy]
    );
    if (!result.rows[0]) throw runtimeError("invalid_target");
    return camelJob(result.rows[0]);
  }

  async function get(membershipId, { tenantId = null } = {}) {
    const result = await queryFn(
      `
        SELECT j.*
        FROM authentik_provisioning_jobs j
        JOIN tenant_memberships m ON m.id = j.tenant_membership_id
        WHERE j.tenant_membership_id = $1
          AND ($2::uuid IS NULL OR m.tenant_id = $2)
      `,
      [membershipId, tenantId]
    );
    return camelJob(result.rows[0]);
  }

  async function retry(membershipId, actorId, { tenantId = null, client = null } = {}) {
    const canonicalMembershipId = String(membershipId || "").toLowerCase();
    const operation = async databaseClient => {
      const scope = await lockProvisioningScope(databaseClient, canonicalMembershipId, { tenantId });
      if (!scope) return null;
      const target = scope.jobs.find(
        job => String(job.tenant_membership_id || "").toLowerCase() === canonicalMembershipId
      );
      if (!target) return null;
      if (!["failed", "retry_wait"].includes(target.status)) return null;

      let acknowledgedUnknownEnrollment = Boolean(
        target.enrollment_dispatch_started_at
        && target.last_error_code === "enrollment_delivery_unknown"
      );
      const ownerId = scope.user.authentik_enrollment_job_id;
      if (ownerId && ownerId !== target.id) {
        const owner = scope.jobs.find(job => job.id === ownerId);
        if (!owner) throw runtimeError("identity_conflict");
        if (
          owner.enrollment_dispatch_started_at
          && (
            ['failed', 'retry_wait'].includes(owner.status)
            || (owner.status === "succeeded" && owner.desired_state === "disabled")
          )
        ) {
          await databaseClient.query(
            `
              UPDATE authentik_provisioning_jobs
              SET enrollment_dispatch_started_at = NULL, updated_at = now()
              WHERE id = $1
            `,
            [owner.id]
          );
          await databaseClient.query(
            `
              UPDATE app_users
              SET authentik_enrollment_job_id = NULL
              WHERE id = $1 AND authentik_enrollment_job_id = $2
            `,
            [scope.user.id, owner.id]
          );
          acknowledgedUnknownEnrollment = true;
        }
      }

      const result = await databaseClient.query(
        `
          UPDATE authentik_provisioning_jobs j
          SET status = 'pending',
            current_step = 'identity',
            target_revision = j.target_revision + 1,
            attempt_count = 0,
            requested_by = $2,
            next_attempt_at = NULL,
            last_error_code = NULL,
            last_safe_error = NULL,
            last_error_at = NULL,
            enrollment_dispatch_started_at = CASE
              WHEN j.last_error_code = 'enrollment_delivery_unknown' THEN NULL
              ELSE j.enrollment_dispatch_started_at
            END,
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = NULL,
            updated_at = now()
          FROM tenant_memberships m
          WHERE j.tenant_membership_id = $1
            AND m.id = j.tenant_membership_id
            AND ($3::uuid IS NULL OR m.tenant_id = $3)
            AND j.status IN ('failed', 'retry_wait')
          RETURNING j.*
        `,
        [canonicalMembershipId, actorId, tenantId]
      );
      const retried = camelJob(result.rows[0]);
      return retried
        ? Object.freeze({ ...retried, acknowledgedUnknownEnrollment })
        : null;
    };

    if (client?.query) return operation(client);
    return transactionFn(operation);
  }

  async function requestEnrollmentResend(membershipId, actorId, { tenantId = null, client = null } = {}) {
    const execute = client?.query ? (text, params) => client.query(text, params) : queryFn;
    const result = await execute(
      `
        UPDATE authentik_provisioning_jobs j
        SET current_step = 'enrollment',
          status = 'pending',
          target_revision = j.target_revision + 1,
          attempt_count = 0,
          requested_by = $2,
          enrollment_required = true,
          enrollment_sent_at = NULL,
          enrollment_resend_requested = true,
          enrollment_dispatch_started_at = NULL,
          last_attempt_at = NULL,
          next_attempt_at = NULL,
          last_error_code = NULL,
          last_safe_error = NULL,
          last_error_at = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          completed_at = NULL,
          updated_at = now()
        FROM tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
        WHERE j.tenant_membership_id = $1
          AND m.id = j.tenant_membership_id
          AND ($3::uuid IS NULL OR m.tenant_id = $3)
          AND j.desired_state = 'active'
          AND j.status = 'succeeded'
          AND j.current_step = 'complete'
          AND j.enrollment_required = true
          AND j.enrollment_sent_at IS NOT NULL
          AND m.status = 'active'
          AND u.authentik_subject IS NULL
          AND u.authentik_enrollment_sent_at IS NOT NULL
          AND u.authentik_managed_by_app = true
          AND u.authentik_user_pk IS NOT NULL
          AND u.authentik_user_uuid IS NOT NULL
        RETURNING j.*
      `,
      [membershipId, actorId, tenantId]
    );
    return camelJob(result.rows[0]);
  }

  async function claimNext() {
    return transactionFn(async client => {
      await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET status = 'retry_wait',
            next_attempt_at = now(),
            last_error_code = 'provider_unavailable',
            last_safe_error = 'The account service is temporarily unavailable. Provisioning will retry automatically.',
            last_error_at = now(),
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = now()
          WHERE status = 'running'
            AND lease_expires_at <= now()
        `
      );

      const leaseToken = crypto.randomUUID();
      const result = await client.query(
        `
          WITH candidate AS (
            SELECT j.id
            FROM authentik_provisioning_jobs j
            WHERE j.status = 'pending'
              OR (j.status = 'retry_wait' AND j.next_attempt_at <= now())
            ORDER BY COALESCE(j.next_attempt_at, j.created_at), j.created_at
            FOR UPDATE OF j SKIP LOCKED
            LIMIT 1
          )
          UPDATE authentik_provisioning_jobs j
          SET status = 'running',
            attempt_count = j.attempt_count + 1,
            last_attempt_at = now(),
            next_attempt_at = NULL,
            lease_token = $1,
            lease_expires_at = now() + ($2 * interval '1 second'),
            updated_at = now()
          FROM candidate,
            tenant_memberships m,
            app_users u,
            tenants t
          WHERE j.id = candidate.id
            AND m.id = j.tenant_membership_id
            AND u.id = m.user_id
            AND t.id = m.tenant_id
          RETURNING j.*,
            m.tenant_id,
            m.user_id,
            m.role AS membership_role,
            m.status AS membership_status,
            u.email,
            u.display_name,
            u.account_type,
            u.authentik_subject,
            u.authentik_oidc_user_uuid,
            u.authentik_user_pk,
            u.authentik_user_uuid,
            u.authentik_managed_by_app,
            u.authentik_enrollment_sent_at,
            u.authentik_enrollment_job_id,
            t.slug AS tenant_slug,
            t.status AS tenant_status
        `,
        [leaseToken, leaseSeconds]
      );
      return privateJob(result.rows[0]);
    });
  }

  async function extendLease(job) {
    const result = await queryFn(
      `
        UPDATE authentik_provisioning_jobs
        SET lease_expires_at = now() + ($4 * interval '1 second'),
          updated_at = now()
        WHERE id = $1
          AND target_revision = $2
          AND lease_token = $3
          AND status = 'running'
          AND reconcile_requested = false
        RETURNING id
      `,
      [job.id, job.targetRevision, job.leaseToken, leaseSeconds]
    );
    return Boolean(result.rows[0]);
  }

  async function restartIfRequested(job, { quietPeriodMs = 0 } = {}) {
    return transactionFn(async client => {
      const membershipResult = await client.query(
        `
          SELECT id, role, status
          FROM tenant_memberships
          WHERE id = $1
          FOR UPDATE
        `,
        [job.membershipId]
      );
      const membership = membershipResult.rows[0];
      if (!membership) throw runtimeError("invalid_target");
      const desiredState = membership.status === "disabled"
        ? "disabled"
        : ["invited", "active"].includes(membership.status)
          ? "active"
          : null;
      if (!desiredState) throw runtimeError("invalid_target");

      const result = await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET desired_role = $4,
            desired_state = $5,
            current_step = 'identity',
            status = CASE WHEN $6 > 0 THEN 'retry_wait' ELSE 'pending' END,
            target_revision = target_revision + 1,
            attempt_count = 0,
            requested_by = COALESCE(reconcile_requested_by, requested_by),
            enrollment_required = CASE
              WHEN $5 = 'disabled' THEN false
              WHEN enrollment_required = false AND enrollment_sent_at IS NULL THEN NULL
              ELSE enrollment_required
            END,
            enrollment_sent_at = CASE
              WHEN $5 = 'disabled' THEN NULL
              ELSE enrollment_sent_at
            END,
            enrollment_resend_requested = false,
            last_attempt_at = NULL,
            next_attempt_at = CASE
              WHEN $6 > 0 THEN now() + ($6 * interval '1 millisecond')
              ELSE NULL
            END,
            last_error_code = NULL,
            last_safe_error = NULL,
            last_error_at = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = NULL,
            reconcile_requested = false,
            reconcile_requested_by = NULL,
            updated_at = now()
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND reconcile_requested = true
          RETURNING id
        `,
        [
          job.id,
          job.targetRevision,
          job.leaseToken,
          membership.role,
          desiredState,
          Math.max(0, Number(quietPeriodMs) || 0)
        ]
      );
      return Boolean(result.rows[0]);
    });
  }

  async function loadClaim(job) {
    const result = await queryFn(
      `
        SELECT j.*,
          m.tenant_id,
          m.user_id,
          m.role AS membership_role,
          m.status AS membership_status,
          u.email,
          u.display_name,
          u.account_type,
          u.authentik_subject,
          u.authentik_oidc_user_uuid,
          u.authentik_user_pk,
          u.authentik_user_uuid,
          u.authentik_managed_by_app,
          u.authentik_enrollment_sent_at,
          u.authentik_enrollment_job_id,
          t.slug AS tenant_slug,
          t.status AS tenant_status
        FROM authentik_provisioning_jobs j
        JOIN tenant_memberships m ON m.id = j.tenant_membership_id
        JOIN app_users u ON u.id = m.user_id
        JOIN tenants t ON t.id = m.tenant_id
        WHERE j.id = $1
          AND j.target_revision = $2
          AND j.lease_token = $3
          AND j.status = 'running'
      `,
      [job.id, job.targetRevision, job.leaseToken]
    );
    return privateJob(result.rows[0]);
  }

  async function recordIdentity(job, identity, {
    managedByApp,
    enrollmentCandidate,
    subjectIsUserUuid = false
  }) {
    try {
      return await transactionFn(async client => {
        const scope = await lockProvisioningScope(client, job.membershipId);
        if (!scope) throw runtimeError("invalid_target");
        const lockedJobIds = scope.jobs.map(row => row.id);
        const lockResult = await client.query(
          `
            SELECT j.id
            FROM authentik_provisioning_jobs j
            WHERE j.id = $1
              AND j.target_revision = $2
              AND j.lease_token = $3
              AND j.status = 'running'
              AND j.current_step = 'identity'
              AND j.reconcile_requested = false
            FOR UPDATE
          `,
          [job.id, job.targetRevision, job.leaseToken]
        );
        if (!lockResult.rows[0]) throwLeaseLost();
        const user = scope.user;
        if (user.id !== job.userId) throw runtimeError("identity_conflict");

        const existingPk = user.authentik_user_pk === null
          ? null
          : Number(user.authentik_user_pk);
        const existingUuid = user.authentik_user_uuid === null
          ? null
          : String(user.authentik_user_uuid).toLowerCase();
        const lockedOidcUuid = String(
          user.authentik_oidc_user_uuid
          || (subjectIsUserUuid ? user.authentik_subject : "")
          || ""
        ).trim().toLowerCase();
        if (user.authentik_subject && !UUID_PATTERN.test(lockedOidcUuid)) {
          throw runtimeError("immutable_identity_missing");
        }
        if (lockedOidcUuid && lockedOidcUuid !== identity.uuid) {
          throw runtimeError("identity_conflict");
        }
        if (
          (existingPk !== null && existingPk !== identity.pk)
          || (existingUuid !== null && existingUuid !== identity.uuid)
          || (existingPk === null) !== (existingUuid === null)
        ) {
          throw runtimeError("identity_conflict");
        }
        const shouldEnroll = Boolean(
          enrollmentCandidate
          && !user.authentik_enrollment_sent_at
          && !user.authentik_subject
        );
        const enrollmentSatisfiedByLogin = Boolean(
          user.authentik_subject
          && lockedOidcUuid
        );
        const priorEnrollmentSentAt = enrollmentCandidate
          && !user.authentik_subject
          && user.authentik_enrollment_sent_at
          ? user.authentik_enrollment_sent_at
          : null;

        const conflictResult = await client.query(
          `
            SELECT id
            FROM app_users
            WHERE id <> $1
              AND (
                authentik_user_pk = $2
                OR authentik_user_uuid = $3
                OR authentik_oidc_user_uuid = $3
                OR (
                  $4::boolean
                  AND lower(authentik_subject) = $3::text
                )
              )
            LIMIT 1
          `,
          [job.userId, identity.pk, identity.uuid, subjectIsUserUuid]
        );
        if (conflictResult.rows[0]) throw runtimeError("identity_conflict");

        await client.query(
          `
            UPDATE app_users
            SET authentik_user_pk = $2,
              authentik_user_uuid = $3,
              authentik_managed_by_app = authentik_managed_by_app OR $4,
              authentik_enrollment_sent_at = CASE
                WHEN $5 THEN COALESCE(authentik_enrollment_sent_at, now())
                ELSE authentik_enrollment_sent_at
              END,
              authentik_enrollment_job_id = CASE
                WHEN $5 THEN NULL
                ELSE authentik_enrollment_job_id
              END,
              authentik_linked_at = COALESCE(authentik_linked_at, now())
            WHERE id = $1
          `,
          [job.userId, identity.pk, identity.uuid, managedByApp, enrollmentSatisfiedByLogin]
        );

        if (enrollmentSatisfiedByLogin) {
          const satisfaction = await satisfyEnrollmentFromVerifiedLogin(job.userId, {
            transactionFn: operation => operation(client),
            lockedJobIds
          });
          if (!satisfaction.satisfied) throw runtimeError("identity_conflict");
        }

        const jobResult = await client.query(
          `
            UPDATE authentik_provisioning_jobs
            SET current_step = 'groups',
              enrollment_required = CASE
                WHEN $5 THEN false
                WHEN $6::timestamptz IS NOT NULL THEN true
                WHEN enrollment_required IS NULL THEN $4
                ELSE enrollment_required
              END,
              enrollment_sent_at = CASE
                WHEN $5 THEN NULL
                WHEN $6::timestamptz IS NOT NULL
                  THEN COALESCE(enrollment_sent_at, $6::timestamptz)
                ELSE enrollment_sent_at
              END,
              updated_at = now()
            WHERE id = $1
              AND target_revision = $2
              AND lease_token = $3
              AND status = 'running'
              AND current_step = 'identity'
              AND reconcile_requested = false
            RETURNING id
          `,
          [
            job.id,
            job.targetRevision,
            job.leaseToken,
            shouldEnroll,
            enrollmentSatisfiedByLogin,
            priorEnrollmentSentAt
          ]
        );
        if (!jobResult.rows[0]) throwLeaseLost();
        return true;
      });
    } catch (error) {
      if (error?.code === "23505") throw runtimeError("identity_conflict");
      throw error;
    }
  }

  async function advanceToEnrollment(job) {
    const result = await queryFn(
      `
        UPDATE authentik_provisioning_jobs
        SET current_step = 'enrollment', updated_at = now()
        WHERE id = $1
          AND target_revision = $2
          AND lease_token = $3
          AND status = 'running'
          AND current_step = 'groups'
          AND reconcile_requested = false
        RETURNING id
      `,
      [job.id, job.targetRevision, job.leaseToken]
    );
    return Boolean(result.rows[0]);
  }

  async function recordEnrollmentSent(job) {
    return transactionFn(async client => {
      const scope = await lockProvisioningScope(client, job.membershipId);
      if (!scope) throw runtimeError("invalid_target");
      const current = await client.query(
        `
          SELECT u.id
          FROM authentik_provisioning_jobs j
          JOIN tenant_memberships m ON m.id = j.tenant_membership_id
          JOIN app_users u ON u.id = m.user_id
          WHERE j.id = $1
            AND j.target_revision = $2
            AND j.lease_token = $3
            AND j.status = 'running'
            AND j.current_step = 'enrollment'
            AND u.authentik_enrollment_job_id = j.id
          FOR UPDATE OF j, u
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      if (!current.rows[0]) throwLeaseLost();

      await client.query(
        `
          UPDATE app_users
          SET authentik_enrollment_sent_at = now(),
            authentik_enrollment_job_id = NULL
          WHERE id = $1
        `,
        [current.rows[0].id]
      );
      const result = await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET enrollment_sent_at = now(),
            enrollment_resend_requested = false,
            enrollment_dispatch_started_at = NULL,
            updated_at = now()
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND current_step = 'enrollment'
          RETURNING id
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      if (!result.rows[0]) throwLeaseLost();
      await client.query(
        `
          UPDATE authentik_provisioning_jobs waiting
          SET next_attempt_at = now(), updated_at = now()
          FROM tenant_memberships waiting_membership
          WHERE waiting_membership.id = waiting.tenant_membership_id
            AND waiting_membership.user_id = $1
            AND waiting.id <> $2
            AND waiting.status = 'retry_wait'
            AND waiting.last_error_code = 'enrollment_pending'
        `,
        [current.rows[0].id, job.id]
      );
      return true;
    });
  }

  async function recordEnrollmentDispatchStarted(job) {
    return transactionFn(async client => {
      const membershipLock = await client.query(
        "SELECT id FROM tenant_memberships WHERE id = $1 FOR UPDATE",
        [job.membershipId]
      );
      if (!membershipLock.rows[0]) throw runtimeError("invalid_target");
      const result = await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET enrollment_dispatch_started_at = now(), updated_at = now()
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND current_step = 'enrollment'
            AND reconcile_requested = false
            AND enrollment_dispatch_started_at IS NULL
          RETURNING id
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      return Boolean(result.rows[0]);
    });
  }

  async function releaseEnrollmentDispatch(job) {
    return transactionFn(async client => {
      const scope = await lockProvisioningScope(client, job.membershipId);
      if (!scope) throw runtimeError("invalid_target");
      const current = scope.jobs.find(row => row.id === job.id);
      if (
        !current
        || Number(current.target_revision) !== job.targetRevision
        || current.lease_token !== job.leaseToken
        || current.status !== "running"
        || current.current_step !== "enrollment"
        || !current.enrollment_dispatch_started_at
        || scope.user.authentik_enrollment_job_id !== job.id
      ) {
        return false;
      }

      const released = await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET enrollment_dispatch_started_at = NULL, updated_at = now()
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND current_step = 'enrollment'
            AND enrollment_dispatch_started_at IS NOT NULL
          RETURNING id
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      if (!released.rows[0]) return false;
      await client.query(
        `
          UPDATE app_users
          SET authentik_enrollment_job_id = NULL
          WHERE id = $1 AND authentik_enrollment_job_id = $2
        `,
        [scope.user.id, job.id]
      );
      return true;
    });
  }

  async function claimEnrollment(job) {
    return transactionFn(async client => {
      const scope = await lockProvisioningScope(client, job.membershipId);
      if (!scope) throw runtimeError("invalid_target");
      const result = await client.query(
        `
          SELECT u.id AS user_id,
            u.authentik_enrollment_sent_at,
            u.authentik_enrollment_job_id,
            j.enrollment_resend_requested,
            owner.status AS owner_status,
            owner.enrollment_dispatch_started_at AS owner_dispatch_started_at
          FROM authentik_provisioning_jobs j
          JOIN tenant_memberships m ON m.id = j.tenant_membership_id
          JOIN app_users u ON u.id = m.user_id
          LEFT JOIN authentik_provisioning_jobs owner
            ON owner.id = u.authentik_enrollment_job_id
          WHERE j.id = $1
            AND j.target_revision = $2
            AND j.lease_token = $3
            AND j.status = 'running'
            AND j.current_step = 'enrollment'
            AND j.desired_state = 'active'
            AND j.reconcile_requested = false
            AND u.authentik_managed_by_app = true
          FOR UPDATE OF j, u
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      const current = result.rows[0];
      if (!current) throwLeaseLost();

      const managementPk = Number(scope.user.authentik_user_pk);
      const managementUuid = String(scope.user.authentik_user_uuid || "").toLowerCase();
      const oidcUuid = String(
        scope.user.authentik_oidc_user_uuid
        || (config.oidc.subjectIsUserUuid ? scope.user.authentik_subject : "")
        || ""
      ).toLowerCase();
      if (
        scope.user.authentik_subject
        && Number.isSafeInteger(managementPk)
        && managementPk > 0
        && UUID_PATTERN.test(managementUuid)
        && UUID_PATTERN.test(oidcUuid)
        && managementUuid === oidcUuid
      ) {
        const satisfaction = await satisfyEnrollmentFromVerifiedLogin(scope.user.id, {
          transactionFn: operation => operation(client),
          lockedJobIds: scope.jobs.map(row => row.id)
        });
        if (!satisfaction.satisfied) throw runtimeError("identity_conflict");
        return { claimed: false, sentAt: null, signedIn: true };
      }

      if (!current.enrollment_resend_requested && current.authentik_enrollment_sent_at) {
        return {
          claimed: false,
          sentAt: current.authentik_enrollment_sent_at
        };
      }

      const ownerId = current.authentik_enrollment_job_id;
      if (
        ownerId
        && ownerId !== job.id
        && current.owner_dispatch_started_at
      ) {
        return { claimed: false, sentAt: null, deliveryUnknown: true };
      }
      const canClaim = !ownerId
        || ownerId === job.id
        || !current.owner_status
        || ["failed", "succeeded"].includes(current.owner_status);
      if (!canClaim) return { claimed: false, sentAt: null };

      await client.query(
        `
          UPDATE app_users
          SET authentik_enrollment_job_id = $2
          WHERE id = $1
        `,
        [current.user_id, job.id]
      );
      return { claimed: true, sentAt: null };
    });
  }

  async function recordEnrollmentSatisfied(job, sentAt) {
    const result = await queryFn(
      `
        UPDATE authentik_provisioning_jobs
        SET enrollment_sent_at = $4::timestamptz,
          enrollment_resend_requested = false,
          updated_at = now()
        WHERE id = $1
          AND target_revision = $2
          AND lease_token = $3
          AND status = 'running'
          AND current_step = 'enrollment'
          AND enrollment_resend_requested = false
          AND reconcile_requested = false
        RETURNING id
      `,
      [job.id, job.targetRevision, job.leaseToken, sentAt]
    );
    return Boolean(result.rows[0]);
  }

  async function complete(job) {
    return transactionFn(async client => {
      const membershipResult = await client.query(
        `
          SELECT role AS membership_role, status AS membership_status
          FROM tenant_memberships
          WHERE id = $1
          FOR UPDATE
        `,
        [job.membershipId]
      );
      const membership = membershipResult.rows[0];
      if (!membership) throw runtimeError("invalid_target");
      const result = await client.query(
        `
          SELECT desired_role, desired_state, current_step,
            enrollment_required, enrollment_sent_at
          FROM authentik_provisioning_jobs
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND reconcile_requested = false
          FOR UPDATE
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      const current = result.rows[0]
        ? { ...result.rows[0], ...membership }
        : null;
      if (!current) throwLeaseLost();
      if (current.membership_role !== current.desired_role) {
        throw runtimeError("invalid_target");
      }

      if (current.desired_state === "active") {
        if (!['invited', 'active'].includes(current.membership_status)) {
          throw runtimeError("invalid_target");
        }
        if (current.enrollment_required === true && !current.enrollment_sent_at) {
          throw runtimeError("invalid_target");
        }
        await client.query(
          `
            UPDATE tenant_memberships
            SET status = 'active'
            WHERE id = $1 AND status = 'invited'
          `,
          [job.membershipId]
        );
      } else if (current.membership_status !== "disabled") {
        throw runtimeError("invalid_target");
      }

      const completed = await client.query(
        `
          UPDATE authentik_provisioning_jobs
          SET current_step = 'complete',
            status = 'succeeded',
            next_attempt_at = NULL,
            last_error_code = NULL,
            last_safe_error = NULL,
            last_error_at = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = now(),
            updated_at = now()
          WHERE id = $1
            AND target_revision = $2
            AND lease_token = $3
            AND status = 'running'
            AND reconcile_requested = false
          RETURNING *
        `,
        [job.id, job.targetRevision, job.leaseToken]
      );
      if (!completed.rows[0]) throwLeaseLost();
      return camelJob(completed.rows[0]);
    });
  }

  async function fail(job, failure, { maximumAttempts }) {
    const coordinationWait = failure.code === "enrollment_pending";
    const shouldRetry = coordinationWait
      || (failure.retryable && job.attemptCount < maximumAttempts);
    const delay = shouldRetry ? retryDelayMs(job.attemptCount) : null;
    const result = await queryFn(
      `
        UPDATE authentik_provisioning_jobs
        SET status = $4,
          attempt_count = CASE
            WHEN $6 = 'enrollment_pending' THEN GREATEST(attempt_count - 1, 0)
            ELSE attempt_count
          END,
          next_attempt_at = CASE
            WHEN $4 = 'retry_wait' THEN now() + ($5 * interval '1 millisecond')
            ELSE NULL
          END,
          last_error_code = $6,
          last_safe_error = $7,
          last_error_at = now(),
          lease_token = NULL,
          lease_expires_at = NULL,
          completed_at = NULL,
          updated_at = now()
        WHERE id = $1
          AND target_revision = $2
          AND lease_token = $3
          AND status = 'running'
          AND reconcile_requested = false
        RETURNING *
      `,
      [
        job.id,
        job.targetRevision,
        job.leaseToken,
        shouldRetry ? "retry_wait" : "failed",
        delay || 0,
        failure.code,
        failure.message
      ]
    );
    return camelJob(result.rows[0]);
  }

  return Object.freeze({
    enqueue,
    get,
    retry,
    requestEnrollmentResend,
    claimNext,
    extendLease,
    restartIfRequested,
    loadClaim,
    recordIdentity,
    advanceToEnrollment,
    recordEnrollmentDispatchStarted,
    releaseEnrollmentDispatch,
    claimEnrollment,
    recordEnrollmentSatisfied,
    recordEnrollmentSent,
    complete,
    fail
  });
}

export function createProvisioningRuntime({
  enabled = true,
  settings,
  authentikClient,
  store,
  queryFn = query,
  transactionFn = withTransaction,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const resolved = {
    pollIntervalMs: 5_000,
    leaseSeconds: 90,
    maximumAttempts: 8,
    recoveryTokenDuration: "days=7",
    reservedGroups: ["876en-admins", "876en-frg-admins", "876en-platoon-admin"],
    ...settings
  };
  const database = store || createPostgresStore({
    queryFn,
    transactionFn,
    leaseSeconds: resolved.leaseSeconds
  });

  let timer = null;
  let stopped = true;
  let draining = null;

  async function renew(job) {
    if (!await database.extendLease(job)) throwLeaseLost();
  }

  async function external(job, operation) {
    if (await database.restartIfRequested(job)) throwLeaseLost();
    await renew(job);
    const result = await operation();
    if (await database.restartIfRequested(job)) throwLeaseLost();
    return result;
  }

  async function externalIdentity(job, operation) {
    try {
      return await external(job, operation);
    } catch (error) {
      if (Number(error?.statusCode) === 404) throw runtimeError("identity_not_found");
      throw error;
    }
  }

  async function identityStep(job) {
    let providerUser;
    let created = false;
    provisioningGroupTargets(job, resolved);
    const hadLinkedIdentity = job.authentikUserPk !== null || job.authentikUserUuid !== null;
    const oidcIdentityUuid = boundOidcIdentityUuid(job, {
      subjectIsUserUuid: resolved.subjectIsUserUuid
    });

    if (hadLinkedIdentity) {
      if (job.authentikUserPk === null || !job.authentikUserUuid) {
        throw runtimeError("identity_conflict");
      }
      providerUser = await externalIdentity(job, () => authentikClient.getUserById(job.authentikUserPk));
      assertLinkedIdentity(job, providerUser);
    } else if (oidcIdentityUuid) {
      providerUser = await external(job, () => authentikClient.findUserByUuid(oidcIdentityUuid));
      if (!providerUser) throw runtimeError("identity_not_found");
    } else if (job.desiredState === "disabled") {
      providerUser = await external(job, () => authentikClient.findUserByEmail(job.email));
      if (!providerUser) {
        await database.complete(job);
        return;
      }
    } else {
      const result = await external(job, () => authentikClient.createOrLinkUser({
        email: job.email,
        name: String(job.displayName || job.email).slice(0, 255),
        username: safeAuthentikUsername(job.email),
        path: resolved.userPath,
        attributes: {
          [MANAGED_ATTRIBUTE]: true,
          [APP_USER_ATTRIBUTE]: job.userId
        },
        isActive: true
      }));
      providerUser = result.user;
      created = result.created;
    }

    const identity = assertIdentity(providerUser);
    assertOidcIdentityMatches(job, identity, {
      subjectIsUserUuid: resolved.subjectIsUserUuid
    });
    const managedByApp = Boolean(
      job.authentikManagedByApp
      || identityManagedForJob(job, providerUser, { created })
    );
    await database.recordIdentity(job, identity, {
      managedByApp,
      enrollmentCandidate: job.desiredState === "active" && managedByApp,
      subjectIsUserUuid: resolved.subjectIsUserUuid
    });
  }

  async function requiredGroup(job, name, { optional = false } = {}) {
    const group = await external(job, () => authentikClient.findGroupByName(name));
    if (!group && !optional) throw runtimeError("provider_not_found");
    if (group) assertUnprivilegedGroup(group);
    return group;
  }

  async function groupsStep(job) {
    const providerUser = await externalIdentity(
      job,
      () => authentikClient.getUserById(job.authentikUserPk)
    );
    assertLinkedIdentity(job, providerUser);

    const { tenantGroupName } = provisioningGroupTargets(job, resolved);
    if (job.desiredState === "active") {
      const baseGroup = await requiredGroup(job, resolved.baseGroup);
      const ensuredTenantGroup = await external(job, () => authentikClient.ensureGroup({
        name: tenantGroupName,
        attributes: {
          [MANAGED_ATTRIBUTE]: true,
          inventory_tenant_id: job.tenantId,
          inventory_tenant_slug: job.tenantSlug
        },
        isSuperuser: false
      }));
      const tenantGroup = assertTenantGroup(job, ensuredTenantGroup.group, tenantGroupName);
      await external(job, () => authentikClient.ensureUserInGroup(providerUser, baseGroup));
      await external(job, () => authentikClient.ensureUserInGroup(providerUser, tenantGroup));

      if (job.enrollmentRequired === true && !job.enrollmentSentAt) {
        if (!await database.advanceToEnrollment(job)) throwLeaseLost();
      } else {
        await database.complete(job);
      }
      return;
    }

    const tenantGroup = await requiredGroup(job, tenantGroupName, { optional: true });
    if (tenantGroup) {
      const managedTenantGroup = assertTenantGroup(job, tenantGroup, tenantGroupName);
      await external(job, () => authentikClient.ensureUserNotInGroup(providerUser, managedTenantGroup));
    }
    // Keep the base login group. A user may still rely on a legacy provider-only
    // workspace with no database membership row; database authority already
    // blocks this exact disabled tenant immediately.
    await database.complete(job);
  }

  async function enrollmentStep(job) {
    if (
      job.desiredState === "active"
      && job.enrollmentRequired === true
      && !job.enrollmentSentAt
      && job.authentikManagedByApp
    ) {
      const enrollment = await database.claimEnrollment(job);
      if (enrollment.signedIn) {
        throwLeaseLost();
      } else if (job.enrollmentDispatchStartedAt) {
        throw runtimeError("enrollment_delivery_unknown");
      } else if (enrollment.sentAt && !job.enrollmentResendRequested) {
        if (!await database.recordEnrollmentSatisfied(job, enrollment.sentAt)) throwLeaseLost();
      } else if (enrollment.deliveryUnknown) {
        throw runtimeError("enrollment_delivery_unknown");
      } else if (!enrollment.claimed) {
        throw runtimeError("enrollment_pending");
      } else {
        await renew(job);
        if (!await database.recordEnrollmentDispatchStarted(job)) throwLeaseLost();
        try {
          await authentikClient.sendRecoveryEmail({
            userId: job.authentikUserPk,
            emailStage: resolved.recoveryEmailStage,
            tokenDuration: resolved.recoveryTokenDuration
          });
        } catch (error) {
          if (enrollmentRequestDefinitelyRejected(error)) {
            if (!await database.releaseEnrollmentDispatch(job)) throwLeaseLost();
            throw error;
          }
          throw runtimeError("enrollment_delivery_unknown");
        }
        try {
          if (!await database.recordEnrollmentSent(job)) throwLeaseLost();
        } catch (error) {
          if (error?.code === LEASE_LOST) throw error;
          throw runtimeError("enrollment_delivery_unknown");
        }
      }
    }
    const refreshed = await database.loadClaim(job);
    if (!refreshed) throwLeaseLost();
    await database.complete(refreshed);
  }

  async function reconcile(claimed) {
    let job = await database.loadClaim(claimed);
    if (!job) throwLeaseLost();
    if (
      job.tenantStatus !== "active"
      || job.accountType !== "authentik"
      || job.membershipRole !== job.desiredRole
      || (job.desiredState === "disabled" && job.membershipStatus !== "disabled")
      || (job.desiredState === "active" && !["invited", "active"].includes(job.membershipStatus))
    ) {
      throw runtimeError("invalid_target");
    }

    if (job.currentStep === "identity") {
      await identityStep(job);
      job = await database.loadClaim(job);
      if (!job) return;
    }
    if (job.currentStep === "groups") {
      await groupsStep(job);
      job = await database.loadClaim(job);
      if (!job) return;
    }
    if (job.currentStep === "enrollment") {
      await enrollmentStep(job);
    }
  }

  async function processNext() {
    requireEnabled(enabled);
    const claimed = await database.claimNext();
    if (!claimed) return false;

    try {
      await reconcile(claimed);
    } catch (error) {
      if (error?.code === LEASE_LOST) {
        await database.restartIfRequested(claimed);
        return true;
      }
      const failure = safeProvisioningFailure(error);
      const quietPeriodMs = failure.code === "provider_unavailable"
        ? resolved.leaseSeconds * 1_000
        : 0;
      if (await database.restartIfRequested(claimed, { quietPeriodMs })) return true;
      const failed = await database.fail(claimed, failure, {
        maximumAttempts: resolved.maximumAttempts
      });
      if (!failed) {
        await database.restartIfRequested(claimed, { quietPeriodMs });
      }
      logger?.warn?.(`Authentik provisioning ${failure.code} for job ${claimed.id}.`);
    }
    return true;
  }

  function schedule(delay = resolved.pollIntervalMs) {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      void drain();
    }, delay);
    timer?.unref?.();
  }

  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      try {
        for (let count = 0; count < 20 && !stopped; count += 1) {
          if (!await processNext()) break;
        }
      } catch (error) {
        const failure = safeProvisioningFailure(error);
        logger?.warn?.(`Authentik provisioning worker ${failure.code}.`);
      } finally {
        draining = null;
        schedule();
      }
    })();
    return draining;
  }

  function start() {
    if (!enabled || !stopped) return false;
    stopped = false;
    schedule(0);
    return true;
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (draining) await draining;
  }

  function kick() {
    if (!enabled) return;
    if (stopped) start();
    else if (!draining) {
      if (timer) clearTimer(timer);
      timer = null;
      schedule(0);
    }
  }

  return Object.freeze({
    available: () => Boolean(enabled),
    enqueueMembershipProvisioning: async (client, options) => {
      const target = normalizeProvisioningTarget({
        role: options?.desiredRole,
        state: options?.desiredState
      });
      return database.enqueue(client, {
        membershipId: options?.membershipId,
        desiredRole: target.desiredRole,
        desiredState: target.desiredState,
        requestedBy: options?.requestedBy || null
      });
    },
    getMembershipProvisioning: (membershipId, options) => database.get(membershipId, options),
    retryMembershipProvisioning: async (membershipId, actorId, options) => {
      requireEnabled(enabled);
      return database.retry(membershipId, actorId, options);
    },
    requestEnrollmentResend: async (membershipId, actorId, options) => {
      requireEnabled(enabled);
      return database.requestEnrollmentResend(membershipId, actorId, options);
    },
    processNext,
    start,
    stop,
    kick
  });
}

export async function satisfyEnrollmentFromVerifiedLogin(userId, {
  transactionFn = withTransaction,
  lockedJobIds: prelockedJobIds = null
} = {}) {
  const canonicalUserId = String(userId || "").toLowerCase();
  if (!UUID_PATTERN.test(canonicalUserId)) throw runtimeError("invalid_target");

  return transactionFn(async client => {
    const lockedJobIds = Array.isArray(prelockedJobIds)
      ? [...prelockedJobIds]
      : (
          await client.query(
            `
              SELECT j.id
              FROM authentik_provisioning_jobs j
              JOIN tenant_memberships m ON m.id = j.tenant_membership_id
              WHERE m.user_id = $1
              ORDER BY j.id
              FOR UPDATE OF j
            `,
            [canonicalUserId]
          )
        ).rows.map(row => row.id);
    const userResult = await client.query(
      `
        SELECT id, account_type, authentik_subject, authentik_user_pk, authentik_user_uuid,
          authentik_oidc_user_uuid, authentik_enrollment_sent_at,
          authentik_enrollment_job_id
        FROM app_users
        WHERE id = $1
        FOR UPDATE
      `,
      [canonicalUserId]
    );
    const user = userResult.rows[0];
    const managementPk = Number(user?.authentik_user_pk);
    const oidcUuid = String(
      user?.authentik_oidc_user_uuid
      || (config.oidc.subjectIsUserUuid ? user?.authentik_subject : "")
      || ""
    ).toLowerCase();
    const managementUuid = String(user?.authentik_user_uuid || "").toLowerCase();
    if (
      !user
      || user.account_type !== "authentik"
      || !user.authentik_subject
      || !Number.isSafeInteger(managementPk)
      || managementPk < 1
      || !UUID_PATTERN.test(oidcUuid)
      || !UUID_PATTERN.test(managementUuid)
      || managementUuid !== oidcUuid
    ) {
      return Object.freeze({ satisfied: false, workRequested: false });
    }

    await client.query(
      `
        UPDATE app_users
        SET authentik_enrollment_sent_at = COALESCE(authentik_enrollment_sent_at, now()),
          authentik_enrollment_job_id = NULL
        WHERE id = $1
      `,
      [canonicalUserId]
    );
    const jobsResult = lockedJobIds.length ? await client.query(
      `
        WITH targets AS (
          SELECT j.id,
            (
              j.desired_state = 'active'
              AND m.status IN ('invited', 'active')
              AND m.role = j.desired_role
              AND t.status = 'active'
            ) AS satisfies_active_enrollment
          FROM authentik_provisioning_jobs j
          JOIN tenant_memberships m ON m.id = j.tenant_membership_id
          JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1
            AND j.id = ANY($2::uuid[])
        )
        UPDATE authentik_provisioning_jobs j
        SET enrollment_required = CASE
            WHEN target.satisfies_active_enrollment THEN false
            ELSE j.enrollment_required
          END,
          enrollment_sent_at = CASE
            WHEN target.satisfies_active_enrollment THEN NULL
            ELSE j.enrollment_sent_at
          END,
          enrollment_resend_requested = false,
          enrollment_dispatch_started_at = NULL,
          current_step = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN 'identity'
            ELSE j.current_step
          END,
          status = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN 'pending'
            ELSE j.status
          END,
          target_revision = j.target_revision + CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN 1
            ELSE 0
          END,
          attempt_count = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN 0
            ELSE j.attempt_count
          END,
          next_attempt_at = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.next_attempt_at
          END,
          last_error_code = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.last_error_code
          END,
          last_safe_error = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.last_safe_error
          END,
          last_error_at = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.last_error_at
          END,
          lease_token = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN NULL
            ELSE j.lease_token
          END,
          lease_expires_at = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN NULL
            ELSE j.lease_expires_at
          END,
          completed_at = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.completed_at
          END,
          reconcile_requested = CASE
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status = 'running'
              THEN true
            WHEN target.satisfies_active_enrollment
              AND j.current_step = 'enrollment'
              AND j.status IN ('pending', 'retry_wait', 'failed')
              THEN false
            ELSE j.reconcile_requested
          END,
          reconcile_requested_by = CASE
            WHEN target.satisfies_active_enrollment AND j.current_step = 'enrollment' THEN NULL
            ELSE j.reconcile_requested_by
          END,
          updated_at = now()
        FROM targets target
        WHERE j.id = target.id
        RETURNING j.status, j.reconcile_requested
      `,
      [canonicalUserId, lockedJobIds]
    ) : { rows: [] };
    return Object.freeze({
      satisfied: true,
      workRequested: jobsResult.rows.some(
        row => row.status === "pending" || row.reconcile_requested === true
      )
    });
  });
}

let defaultRuntime;

function runtime() {
  if (defaultRuntime) return defaultRuntime;
  const settings = config.authentikProvisioning;
  if (settings.enabled) assertAuthentikProvisioningConfig();
  defaultRuntime = createProvisioningRuntime({
    enabled: settings.enabled,
    settings: {
      ...settings,
      reservedGroups: [
        config.oidc.platformAdminGroup,
        config.oidc.frgAdminGroup,
        config.oidc.tenantAdminGroup,
        "876en-admins",
        "876en-frg-admins",
        "876en-platoon-admin"
      ],
      subjectIsUserUuid: config.oidc.subjectIsUserUuid
    },
    authentikClient: settings.enabled
      ? createAuthentikClient({
        origin: settings.origin,
        token: settings.token,
        timeoutMs: settings.requestTimeoutMs
      })
      : null
  });
  return defaultRuntime;
}

export function provisioningAvailable() {
  return Boolean(config.authentikProvisioning.enabled);
}

export function enqueueMembershipProvisioning(client, options) {
  return runtime().enqueueMembershipProvisioning(client, options);
}

export function getMembershipProvisioning(membershipId, options) {
  return runtime().getMembershipProvisioning(membershipId, options);
}

export function retryMembershipProvisioning(membershipId, actorId, options) {
  return runtime().retryMembershipProvisioning(membershipId, actorId, options);
}

export function requestEnrollmentResend(membershipId, actorId, options) {
  return runtime().requestEnrollmentResend(membershipId, actorId, options);
}

export function kickProvisioningWorker() {
  runtime().kick();
}

export function startProvisioningWorker() {
  return runtime().start();
}

export function stopProvisioningWorker() {
  return runtime().stop();
}
