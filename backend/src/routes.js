import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  authenticate,
  authContext,
  clearOidcRefreshCookie,
  ensureUser,
  exchangeOidcCode,
  issueOidcRefreshCookie,
  oidcRefreshCookieName,
  refreshOidcTokens
} from "./auth.js";
import { createAuthentikClient } from "./authentik.js";
import { config } from "./config.js";
import {
  authenticateCrewRequest,
  consumeCrewCode,
  createCrewGrant,
  crewRequestError,
  expireCrewAccess,
  hasPrimaryAuthCredentials,
  lockActiveCrewAccess,
  readCookie,
  releaseCrewClaims,
  revokeCrewAccessForSession,
  revokeCrewAuthSession
} from "./crew-auth.js";
import { query, withTransaction } from "./db.js";
import {
  buildMediaUrl,
  issueMediaSession,
  mediaStorageKeyFromUrl,
  normalizeMediaStorageKey
} from "./media.js";
import { inspectPlatformSetup } from "./platform-setup.js";
import {
  enqueueMembershipProvisioning,
  kickProvisioningWorker,
  provisioningAvailable,
  requestEnrollmentResend,
  retryMembershipProvisioning
} from "./provisioning.js";
import { safeProvisioningFailure } from "./provisioning-state.js";
import {
  isEmailConfigured,
  sendNewsletterIssueEmail,
  sendNewsletterSubscriberReviewEmail,
  sendProofRequestEmail,
  sendProofSubmittedEmail,
  sendTenantInviteEmail
} from "./email.js";
import { hasTenantRole, resolveTenant, tenantContext, tenantSlugFromHost } from "./tenant.js";

const tenantRoles = ["tenant_admin", "contributor", "viewer"];
const memberStatuses = ["active", "disabled"];
const itemStatuses = ["unchecked", "found", "not_found", "mismatch", "needs_review", "approved"];
const submissionStatuses = ["found", "not_found", "mismatch", "needs_review"];
const reviewDecisions = ["approved", "request_more_info", "rejected"];
const reviewReturnRoutes = ["submitter", "unassigned"];
const photoKinds = ["general", "serial", "location", "damage"];
export const evidenceSubmissionPhotoLimit = 10;
export const savedInventoryPhotoLimit = 3;
const minimumNoteOnlyEvidenceLength = 12;
const nonSerialPlaceholders = new Set([
  "na",
  "n/a",
  "none",
  "not applicable",
  "not serialized",
  "unserialized"
]);
const evidenceSubmissionSchema = z.object({
  status: z.enum(submissionStatuses),
  locationText: z.string().optional(),
  note: z.string().trim().optional(),
  serialNumber: z.string().optional(),
  photoIds: z.array(z.string().uuid()).max(evidenceSubmissionPhotoLimit).optional(),
  photos: z.array(z.object({
    uploadId: z.string().uuid(),
    caption: z.string().nullish(),
    kind: z.enum(photoKinds).default("general")
  })).max(evidenceSubmissionPhotoLimit).optional()
});

export function parseEvidenceSubmissionBody(body) {
  const parsed = parseBody(evidenceSubmissionSchema, body);
  if (!(parsed.photos || []).length && String(parsed.note || "").length < minimumNoteOnlyEvidenceLength) {
    throw requestError("Add at least one photo or an accountability note with at least 12 characters.");
  }
  if (parsed.serialNumber !== undefined) {
    parsed.serialNumber = normalizeEvidenceSerialNumber(parsed.serialNumber);
  }
  return parsed;
}

export function normalizeEvidenceSerialNumber(value) {
  const serialNumber = String(value || "").trim();
  const placeholder = serialNumber.toLowerCase().replace(/\s+/g, " ");
  return serialNumber && !nonSerialPlaceholders.has(placeholder) ? serialNumber : null;
}

export function defaultSavedEvidenceMediaUploadIds(existingReferenceIds = []) {
  return [...new Set(existingReferenceIds)].slice(0, savedInventoryPhotoLimit);
}
const submissionReviewSchema = z.object({
  decision: z.enum(reviewDecisions),
  note: z.string().trim().max(2000).optional(),
  returnAssignment: z.enum(reviewReturnRoutes).optional(),
  saveItem: z.boolean().optional(),
  savedMediaUploadIds: z.array(z.string().uuid()).max(savedInventoryPhotoLimit).optional()
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected") {
    if (!value.note || value.note.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note"],
        message: "A rejection reason is required."
      });
    }
    if (!value.returnAssignment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["returnAssignment"],
        message: "Choose whether to keep the row with the submitter or return it to the unclaimed queue."
      });
    }
  } else if (value.returnAssignment !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["returnAssignment"],
      message: "Return routing only applies to rejected proof."
    });
  }
});

export function parseSubmissionReviewBody(body) {
  return parseBody(submissionReviewSchema, body);
}
const newsletterIssueSchema = z.object({
  title: z.string().min(2).max(160),
  editionLabel: z.string().max(80).optional(),
  summary: z.string().max(600).optional(),
  body: z.string().min(10).max(10000)
});
const newsletterTestSendSchema = z.object({
  email: z.string().email().max(254)
});
const frgContentBlockSchema = z.object({
  blockType: z.enum(["announcement", "event", "resource"]),
  title: z.string().min(2).max(140),
  summary: z.string().max(320).optional(),
  body: z.string().max(1200).optional(),
  href: z.string().max(400).optional(),
  linkLabel: z.string().max(80).optional(),
  eventAt: z.string().max(40).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  status: z.enum(["draft", "published", "hidden"]).optional()
});
const tenantGuidanceSchema = z.object({
  body: z.string().max(12000).optional()
});
const defaultTenantNotificationPreferences = Object.freeze({
  proof_submitted: true,
  proof_requests: true,
  open_rows: true,
  packet_imports: true,
  session_closed: true,
  email_proof_submitted: true,
  email_proof_requests: true
});
const tenantNotificationPreferencesSchema = z.object({
  proof_submitted: z.boolean().optional(),
  proof_requests: z.boolean().optional(),
  open_rows: z.boolean().optional(),
  packet_imports: z.boolean().optional(),
  session_closed: z.boolean().optional(),
  email_proof_submitted: z.boolean().optional(),
  email_proof_requests: z.boolean().optional()
}).strict().refine(value => Object.keys(value).length > 0, { message: "Choose at least one notification preference." });
const tenantSettingsSchema = z.object({
  displayName: z.string().trim().min(2).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, "Display name contains unsupported characters.").optional(),
  defaultGuidance: z.string().max(12000).optional(),
  alertRecipientEmail: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  notificationPreferences: tenantNotificationPreferencesSchema.optional()
}).strict().refine(value => Object.keys(value).length > 0, { message: "Provide at least one setting." });
const tenantAuditCategoryPrefixes = Object.freeze({
  workflow: [
    "inventory_item.",
    "inventory_session.",
    "session_item.",
    "session_items.",
    "submission.",
    "evidence_request."
  ],
  access: ["member.", "invitation."],
  workspace: ["tenant.", "tenant_guidance."],
  files: ["media_upload."]
});
const tenantAuditCategoryOptions = Object.freeze([
  { value: "workflow", label: "Workflow" },
  { value: "access", label: "Access" },
  { value: "workspace", label: "Workspace" },
  { value: "files", label: "Files and system" },
  { value: "other", label: "Other" }
]);
const tenantAuditCursorSchema = z.string().min(1).max(512).refine(
  value => Boolean(decodeTenantAuditCursor(value)),
  { message: "Invalid audit cursor." }
);
const tenantAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: tenantAuditCursorSchema.optional(),
  actor: z.union([z.string().uuid(), z.literal("system")]).optional(),
  action: z.string().trim().min(1).max(100).regex(/^[a-z0-9_.]+$/).optional(),
  entityType: z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  category: z.enum(["workflow", "access", "workspace", "files", "other"]).optional()
}).strict().superRefine((value, context) => {
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: "The end date must be on or after the start date."
    });
  }
});
const imageMimeTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);
const packetSourceMimeTypes = new Map([
  ...imageMimeTypes,
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"]
]);

function parseBody(schema, body) {
  return schema.parse(body || {});
}

function badRequestFromZod(error) {
  return {
    error: "Validation failed",
    details: error.errors?.map(issue => ({
      path: issue.path.join("."),
      message: issue.message
    })) || []
  };
}

function rowToTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.created_at
  };
}

export function safeMemberProvisioning(row) {
  if (!row?.provisioning_job_id) return null;

  const error = row.provisioning_error_code
    ? safeProvisioningFailure({ code: row.provisioning_error_code })
    : null;

  const enrollmentSentAt = row.provisioning_enrollment_sent_at || null;
  const canResendEnrollment = Boolean(
    row.provisioning_status === "succeeded"
    && row.provisioning_step === "complete"
    && row.provisioning_desired_state === "active"
    && row.provisioning_enrollment_required === true
    && enrollmentSentAt
    && row.status !== "disabled"
    && !row.authentik_subject
  );

  return {
    id: row.provisioning_job_id,
    status: row.provisioning_status,
    step: row.provisioning_step,
    desiredRole: row.provisioning_desired_role,
    desiredState: row.provisioning_desired_state,
    nextAttemptAt: row.provisioning_next_attempt_at || null,
    completedAt: row.provisioning_completed_at || null,
    error,
    safeError: error?.message || null,
    retryable: Boolean(error?.retryable),
    enrollmentRequired: typeof row.provisioning_enrollment_required === "boolean"
      ? row.provisioning_enrollment_required
      : null,
    enrollmentSentAt,
    canResendEnrollment,
    enrollment: {
      required: typeof row.provisioning_enrollment_required === "boolean"
        ? row.provisioning_enrollment_required
        : null,
      sentAt: enrollmentSentAt,
      canResend: canResendEnrollment
    }
  };
}

export function rowToMember(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    email: row.email,
    displayName: row.display_name,
    accountType: row.account_type || "authentik",
    hasSignedIn: Boolean(row.authentik_subject),
    provisioning: safeMemberProvisioning(row),
    createdAt: row.created_at
  };
}

export function permanentMemberTransition(currentStatus, requestedStatus) {
  if (!["active", "invited", "disabled"].includes(currentStatus)) {
    throw new TypeError("Unsupported current member status");
  }
  if (requestedStatus !== undefined && !["active", "disabled"].includes(requestedStatus)) {
    throw new TypeError("Unsupported requested member status");
  }

  if (requestedStatus === "disabled") {
    return Object.freeze({ membershipStatus: "disabled", desiredState: "disabled" });
  }
  if (requestedStatus === "active") {
    return Object.freeze({
      membershipStatus: currentStatus === "active" ? "active" : "invited",
      desiredState: "active"
    });
  }

  return Object.freeze({
    membershipStatus: currentStatus,
    desiredState: currentStatus === "disabled" ? "disabled" : "active"
  });
}

function rowToWorkspace(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    role: row.role || "contributor",
    source: row.source || "database"
  };
}

function rowToCrewAccess(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    status: row.status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason || null,
    createdAt: row.created_at
  };
}

function reservedAuthentikGroupNames() {
  return new Set([
    "876en",
    "876en-admins",
    "876en-frg-admins",
    "876en-platoon-admin",
    String(config.oidc.platformAdminGroup || "").toLowerCase(),
    String(config.oidc.frgAdminGroup || "").toLowerCase(),
    String(config.oidc.tenantAdminGroup || "").toLowerCase()
  ].filter(Boolean));
}

function privilegedAuthentikGroupNames() {
  return new Set([
    "876en-admins",
    "876en-frg-admins",
    "876en-platoon-admin",
    String(config.oidc.platformAdminGroup || "").toLowerCase(),
    String(config.oidc.frgAdminGroup || "").toLowerCase(),
    String(config.oidc.tenantAdminGroup || "").toLowerCase()
  ].filter(Boolean));
}

const authentikUserUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authentikIdentityGroupNames(identity) {
  const groupObjects = Array.isArray(identity?.groups_obj) ? identity.groups_obj : [];
  const embeddedGroups = Array.isArray(identity?.groups) ? identity.groups : [];
  return [...groupObjects, ...embeddedGroups]
    .map(group => typeof group === "string"
      ? group.trim().toLowerCase()
      : String(group?.name || "").trim().toLowerCase())
    .filter(Boolean);
}

export function safeAuthentikIdentityCandidate(identity, {
  linkedElsewhere = false,
  appAccountLinkedElsewhere = false,
  providerOwnerConflict = false
} = {}) {
  const providerPk = Number(identity?.pk);
  const id = String(identity?.uuid || "").trim().toLowerCase();
  const username = String(identity?.username || "").trim();
  const displayName = String(identity?.name || username || "Existing account").trim();
  const privilegedGroups = privilegedAuthentikGroupNames();
  const hasPrivilegedGroup = authentikIdentityGroupNames(identity).some(name => privilegedGroups.has(name));

  let blockedReason = "";
  if (!Number.isSafeInteger(providerPk) || providerPk < 1 || !authentikUserUuidPattern.test(id)) {
    blockedReason = "This account could not be verified safely.";
  } else if (identity?.is_active !== true) {
    blockedReason = "This sign-in account is disabled.";
  } else if (identity?.is_superuser !== false || hasPrivilegedGroup) {
    blockedReason = "Privileged administrator accounts cannot be linked through a platoon invite.";
  } else if (appAccountLinkedElsewhere) {
    blockedReason = "This app account is already linked to a different sign-in account.";
  } else if (providerOwnerConflict) {
    blockedReason = "This sign-in account is already managed for another app account.";
  } else if (linkedElsewhere) {
    blockedReason = "This sign-in account is already linked to another app account.";
  }

  return {
    id,
    username: username || "Existing account",
    displayName,
    active: identity?.is_active === true,
    eligible: !blockedReason,
    blockedReason: blockedReason || null
  };
}

function getTenantGroupSlugs(identity) {
  const prefix = String(config.oidc.tenantGroupPrefix || "876en-").toLowerCase();
  const reserved = reservedAuthentikGroupNames();

  return [...new Set((identity?.groups || [])
    .map(group => String(group || "").trim().toLowerCase())
    .filter(group => group.startsWith(prefix) && !reserved.has(group))
    .map(group => group.slice(prefix.length))
    .filter(slug => /^[a-z0-9-]+$/.test(slug)))]
    .sort();
}

export async function listUserWorkspaces(
  identity,
  user,
  {
    queryFn = query,
    allowGroupFallback = config.oidc.tenantGroupFallbackEnabled
  } = {}
) {
  if (!user?.id) return [];

  if (identity?.isPlatformAdmin) {
    const result = await queryFn(
      `
        SELECT id, slug, name, status, 'tenant_admin' AS role, 'platform_admin' AS source
        FROM tenants
        WHERE status = 'active'
        ORDER BY name, slug
      `
    );
    return result.rows.map(rowToWorkspace);
  }

  const groupSlugs = allowGroupFallback ? getTenantGroupSlugs(identity) : [];
  const hasTenantAdminGroup = (identity?.groups || [])
    .map(group => String(group || "").trim().toLowerCase())
    .includes(String(config.oidc.tenantAdminGroup || "").toLowerCase());

  const result = await queryFn(
    `
      SELECT
        t.id,
        t.slug,
        t.name,
        t.status,
        m.id AS membership_id,
        m.role AS membership_role,
        m.status AS membership_status
      FROM tenants t
      LEFT JOIN tenant_memberships m
        ON m.tenant_id = t.id
       AND m.user_id = $1
      WHERE t.status = 'active'
        AND (
          m.id IS NOT NULL
          OR ($3::boolean AND t.slug = ANY($2::text[]))
        )
      ORDER BY t.name, t.slug
    `,
    [user.id, groupSlugs, Boolean(allowGroupFallback)]
  );

  return result.rows.flatMap(row => {
    if (row.membership_id) {
      if (row.membership_status !== "active") return [];
      return [rowToWorkspace({
        ...row,
        role: row.membership_role,
        source: "database"
      })];
    }

    if (!allowGroupFallback || !groupSlugs.includes(row.slug)) return [];
    return [rowToWorkspace({
      ...row,
      role: hasTenantAdminGroup ? "tenant_admin" : "contributor",
      source: "authentik"
    })];
  });
}

export function invitationEmailMatches(invitationEmail, authenticatedEmail) {
  const normalize = value => String(value || "").trim().toLowerCase();
  const intendedEmail = normalize(invitationEmail);
  return Boolean(intendedEmail) && intendedEmail === normalize(authenticatedEmail);
}

function authHealthResponse({ identity = null, context = null, requestedTenantSlug = "", workspaces = [], code = "ok" }) {
  const tenantRequested = Boolean(requestedTenantSlug);
  const tenantExists = !tenantRequested || Boolean(context?.tenant);
  const tenantAccess = !tenantRequested || Boolean(context?.tenant && (context?.identity?.isPlatformAdmin || context?.membership));

  return {
    ok: code === "ok",
    code,
    api: {
      ok: true
    },
    auth: {
      authenticated: Boolean(identity),
      subjectPresent: Boolean(identity?.subject),
      emailPresent: Boolean(identity?.email),
      displayNamePresent: Boolean(identity?.displayName),
      groupCount: identity?.groups?.length || 0,
      isPlatformAdmin: Boolean(identity?.isPlatformAdmin),
      isFrgAdmin: Boolean(identity?.isFrgAdmin)
    },
    tenant: {
      requestedSlug: requestedTenantSlug || "",
      requested: tenantRequested,
      exists: tenantExists,
      access: tenantAccess,
      slug: context?.tenant?.slug || null,
      role: context?.membership?.role || (context?.identity?.isPlatformAdmin && context?.tenant ? "tenant_admin" : null),
      source: context?.membership?.source || (context?.identity?.isPlatformAdmin && context?.tenant ? "platform_admin" : null)
    },
    workspaces: workspaces.map(workspace => ({
      slug: workspace.slug,
      name: workspace.name,
      role: workspace.role,
      source: workspace.source
    }))
  };
}

async function getAuthHealth(request, reply) {
  const requestedTenantSlug = tenantSlugFromHost(request);
  let identity = null;

  try {
    identity = await authenticate(request);
  } catch {
    reply.code(401);
    return authHealthResponse({ requestedTenantSlug, code: "token_rejected" });
  }

  if (!identity) {
    reply.code(401);
    return authHealthResponse({ requestedTenantSlug, code: "token_missing" });
  }

  request.authenticatedSubject = identity.subject || "";
  let user = null;
  try {
    user = await ensureUser(identity);
  } catch {
    reply.code(422);
    return authHealthResponse({ identity, requestedTenantSlug, code: "identity_incomplete" });
  }

  const context = await tenantContext(request, { identity, user });
  const workspaces = await listUserWorkspaces(identity, user);
  const code = requestedTenantSlug && !context.tenant
    ? "tenant_missing"
    : requestedTenantSlug && !context.identity.isPlatformAdmin && !context.membership
      ? "tenant_access_missing"
      : "ok";

  return authHealthResponse({ identity, context, requestedTenantSlug, workspaces, code });
}

async function assertMemberCanLoseAdminRole(client, reply, tenantId, member) {
  if (member.role !== "tenant_admin" || member.status !== "active") return;

  // Serialize last-admin decisions per tenant. Member-row locks alone do not
  // prevent two different admins from being removed concurrently.
  await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);

  const adminCount = await client.query(
    `
      SELECT count(*)::int AS count
      FROM tenant_memberships
      WHERE tenant_id = $1
        AND role = 'tenant_admin'
        AND status = 'active'
    `,
    [tenantId]
  );

  if ((adminCount.rows[0]?.count || 0) <= 1) {
    reply.code(409);
    throw new Error("Add another active platoon admin before changing this member.");
  }
}

async function findMemberWithProvisioning(queryFn, tenantId, memberId, { forUpdate = false } = {}) {
  const result = await queryFn(
    `
      SELECT m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
        u.email, u.display_name, u.account_type, u.authentik_subject,
        u.authentik_user_pk, u.authentik_user_uuid, u.authentik_oidc_user_uuid,
        p.id AS provisioning_job_id,
        p.status AS provisioning_status,
        p.current_step AS provisioning_step,
        p.desired_role AS provisioning_desired_role,
        p.desired_state AS provisioning_desired_state,
        p.next_attempt_at AS provisioning_next_attempt_at,
        p.completed_at AS provisioning_completed_at,
        p.last_error_code AS provisioning_error_code,
        p.last_safe_error AS provisioning_safe_error,
        p.enrollment_required AS provisioning_enrollment_required,
        p.enrollment_sent_at AS provisioning_enrollment_sent_at
      FROM tenant_memberships m
      JOIN app_users u ON u.id = m.user_id
      LEFT JOIN authentik_provisioning_jobs p ON p.tenant_membership_id = m.id
      WHERE m.tenant_id = $1 AND m.id = $2
      ${forUpdate ? "FOR UPDATE OF m" : ""}
    `,
    [tenantId, memberId]
  );
  return result.rows[0] || null;
}

function permanentAccountError(message, statusCode, publicCode) {
  const error = requestError(message, statusCode);
  error.publicCode = publicCode;
  return error;
}

function assertPermanentAccount(member) {
  if (!member) return;
  if (member.account_type === "session_crew") {
    throw permanentAccountError("Temporary session accounts cannot be managed as permanent members.", 409, "temporary_account");
  }
  if (!member.email) {
    throw permanentAccountError("This account does not have a permanent sign-in email.", 409, "permanent_email_required");
  }
}

async function findOrCreatePermanentUser(client, { email, displayName = null }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 254) {
    throw permanentAccountError("Enter a valid email address.", 400, "invalid_email");
  }

  async function preserveExistingName(existingUser) {
    assertPermanentAccount(existingUser);
    if (existingUser.display_name || !displayName) return existingUser;
    const filled = await client.query(
      `
        UPDATE app_users
        SET display_name = $2
        WHERE id = $1 AND display_name IS NULL
        RETURNING id, email, display_name, account_type, authentik_subject
      `,
      [existingUser.id, displayName]
    );
    return filled.rows[0] || existingUser;
  }
  const existingUsers = await client.query(
    `
      SELECT id, email, display_name, account_type, authentik_subject
      FROM app_users
      WHERE lower(email) = $1
      ORDER BY id
      FOR UPDATE
    `,
    [normalizedEmail]
  );
  if (existingUsers.rows.length > 1) {
    throw permanentAccountError(
      "More than one account uses this email. An administrator must resolve the duplicate.",
      409,
      "email_ambiguous"
    );
  }

  let user = existingUsers.rows[0] || null;
  if (user) {
    return preserveExistingName(user);
  }

  const inserted = await client.query(
    `
      INSERT INTO app_users (email, display_name, account_type)
      VALUES ($1, $2, 'authentik')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, display_name, account_type, authentik_subject
    `,
    [normalizedEmail, displayName]
  );
  user = inserted.rows[0] || (
    await client.query(
      `
        SELECT id, email, display_name, account_type, authentik_subject
        FROM app_users
        WHERE email = $1
        FOR UPDATE
      `,
      [normalizedEmail]
    )
  ).rows[0];
  if (inserted.rows[0]) {
    assertPermanentAccount(user);
    return user;
  }
  return preserveExistingName(user);
}

function requirePermanentProvisioning() {
  if (!provisioningAvailable()) {
    throw permanentAccountError(
      "Permanent account setup is not available yet.",
      503,
      "provisioning_unavailable"
    );
  }
}

function permanentIdentityClient() {
  requirePermanentProvisioning();
  return createAuthentikClient({
    origin: config.authentikProvisioning.origin,
    token: config.authentikProvisioning.token,
    timeoutMs: config.authentikProvisioning.requestTimeoutMs
  });
}

async function inspectPermanentIdentityEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  let identities;
  try {
    identities = await permanentIdentityClient().listUsersByExactEmail(normalizedEmail);
  } catch {
    throw permanentAccountError(
      "The account service could not check this email. Try again.",
      503,
      "identity_check_unavailable"
    );
  }

  const expectedUsers = await query(
    `
      SELECT id, authentik_subject, authentik_user_pk,
        authentik_user_uuid::text AS authentik_user_uuid,
        authentik_oidc_user_uuid::text AS authentik_oidc_user_uuid
      FROM app_users
      WHERE lower(email) = $1
      ORDER BY id
    `,
    [normalizedEmail]
  );
  const expectedUserIds = new Set(expectedUsers.rows.map(row => row.id));
  const candidateUuids = identities
    .map(identity => String(identity?.uuid || "").trim().toLowerCase())
    .filter(value => authentikUserUuidPattern.test(value));
  const candidatePks = identities
    .map(identity => Number(identity?.pk))
    .filter(value => Number.isSafeInteger(value) && value > 0);
  const linkedUsers = candidateUuids.length || candidatePks.length
    ? await query(
      `
        SELECT id, authentik_subject, authentik_user_pk,
          authentik_user_uuid::text AS authentik_user_uuid,
          authentik_oidc_user_uuid::text AS authentik_oidc_user_uuid
        FROM app_users
        WHERE authentik_user_uuid = ANY($1::uuid[])
          OR authentik_oidc_user_uuid = ANY($1::uuid[])
          OR authentik_user_pk = ANY($2::bigint[])
          OR lower(authentik_subject) = ANY($3::text[])
      `,
      [candidateUuids, candidatePks, candidateUuids]
    )
    : { rows: [] };

  const entries = identities.map(identity => {
    const uuid = String(identity?.uuid || "").trim().toLowerCase();
    const pk = Number(identity?.pk);
    const linked = linkedUsers.rows.find(row => (
      String(row.authentik_user_uuid || "").toLowerCase() === uuid
      || String(row.authentik_oidc_user_uuid || "").toLowerCase() === uuid
      || String(row.authentik_subject || "").toLowerCase() === uuid
      || Number(row.authentik_user_pk) === pk
    ));
    const appAccountLinkedElsewhere = expectedUsers.rows.some(row => {
      const expectedUuid = String(row.authentik_user_uuid || "").trim().toLowerCase();
      const expectedOidcUuid = String(row.authentik_oidc_user_uuid || "").trim().toLowerCase();
      const rawExpectedSubject = String(row.authentik_subject || "").trim().toLowerCase();
      const expectedSubjectUuid = authentikUserUuidPattern.test(rawExpectedSubject)
        ? rawExpectedSubject
        : "";
      const expectedPk = row.authentik_user_pk === null ? null : Number(row.authentik_user_pk);
      const hasProviderLink = Boolean(expectedUuid || expectedOidcUuid || expectedSubjectUuid || expectedPk !== null);
      const isCompatibleLink = (!expectedUuid || expectedUuid === uuid)
        && (!expectedOidcUuid || expectedOidcUuid === uuid)
        && (!expectedSubjectUuid || expectedSubjectUuid === uuid)
        && (expectedPk === null || expectedPk === pk);
      return hasProviderLink && !isCompatibleLink;
    });
    const providerOwnerId = String(identity?.attributes?.inventory_app_user_id || "").trim();
    return {
      identity,
      safe: safeAuthentikIdentityCandidate(identity, {
        linkedElsewhere: Boolean(linked && !expectedUserIds.has(linked.id)),
        appAccountLinkedElsewhere,
        providerOwnerConflict: Boolean(providerOwnerId && !expectedUserIds.has(providerOwnerId))
      })
    };
  });

  return { normalizedEmail, entries };
}

function choosePermanentIdentity(inspection, selectedUuid, { isPlatformAdmin = false } = {}) {
  const selectedId = String(selectedUuid || "").trim().toLowerCase();
  const entries = inspection.entries || [];

  if (!entries.length) {
    if (selectedId) {
      throw permanentAccountError(
        "That sign-in account no longer matches this email. Check the address and try again.",
        409,
        "identity_selection_stale"
      );
    }
    return null;
  }

  if (selectedId && !isPlatformAdmin) {
    throw permanentAccountError(
      "Only a platform administrator can choose between existing sign-in accounts.",
      403,
      "identity_resolution_forbidden"
    );
  }

  if (entries.length > 1 && !selectedId) {
    throw permanentAccountError(
      isPlatformAdmin
        ? "More than one sign-in account uses this email. Choose the correct account before inviting this teammate."
        : "More than one sign-in account uses this email. Ask a platform administrator to choose the correct account.",
      409,
      "identity_ambiguous"
    );
  }

  const selected = selectedId
    ? entries.find(entry => entry.safe.id === selectedId)
    : entries[0];
  if (!selected) {
    throw permanentAccountError(
      "That sign-in account no longer matches this email. Check the address and try again.",
      409,
      "identity_selection_stale"
    );
  }
  if (!selected.safe.eligible) {
    throw permanentAccountError(
      selected.safe.blockedReason || "This sign-in account cannot be linked safely.",
      409,
      "identity_not_eligible"
    );
  }
  return selected;
}

async function bindPermanentUserIdentity(client, userId, entry) {
  const providerPk = Number(entry?.identity?.pk);
  const providerUuid = String(entry?.identity?.uuid || "").trim().toLowerCase();
  const result = await client.query(
    `
      UPDATE app_users
      SET authentik_user_pk = $2,
        authentik_user_uuid = $3,
        authentik_linked_at = COALESCE(authentik_linked_at, now())
      WHERE id = $1
        AND (authentik_user_pk IS NULL OR authentik_user_pk = $2)
        AND (authentik_user_uuid IS NULL OR authentik_user_uuid = $3)
        AND (authentik_oidc_user_uuid IS NULL OR authentik_oidc_user_uuid = $3)
      RETURNING id
    `,
    [userId, providerPk, providerUuid]
  );
  if (!result.rows[0]) {
    throw permanentAccountError(
      "This app account is already linked to a different sign-in account.",
      409,
      "identity_conflict"
    );
  }
}

function startProvisioningWork() {
  try {
    const worker = kickProvisioningWorker();
    if (worker && typeof worker.catch === "function") {
      worker.catch(() => console.error(JSON.stringify({ event: "provisioning_worker_kick_failed" })));
    }
  } catch {
    console.error(JSON.stringify({ event: "provisioning_worker_kick_failed" }));
  }
}

function rowToInvitation(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  };
}

function rowToInventoryItem(row, photos = []) {
  return {
    id: row.id,
    title: row.title,
    commonName: row.common_name,
    armyName: row.army_name,
    lin: row.lin,
    nsn: row.nsn,
    description: row.description,
    currentLocation: row.current_location,
    serialNumber: row.serial_number,
    lastVerifiedSubmissionId: row.last_verified_submission_id,
    lastVerifiedBy: row.last_verified_by,
    lastVerifiedAt: row.last_verified_at,
    legacyMediaMetadata: Boolean(row.legacy_media_metadata),
    metadata: row.metadata || {},
    photos,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function elapsedSeconds(start, end) {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 1000);
}

export function sessionTimingFromRow(row) {
  const startedAt = row?.started_at || null;
  const itemCount = Number(row?.item_count || 0);
  const completedCount = Number(row?.found_count || 0);
  const completedAt = row?.completed_at
    || (itemCount > 0 && completedCount === itemCount ? row?.last_item_updated_at || null : null);
  const closedAt = row?.closed_at || null;
  return {
    startedAt,
    completedAt,
    closedAt,
    durationToCompletionSeconds: row?.duration_to_completion_seconds == null
      ? elapsedSeconds(startedAt, completedAt)
      : Number(row.duration_to_completion_seconds),
    durationToCloseSeconds: row?.duration_to_close_seconds == null
      ? elapsedSeconds(startedAt, closedAt)
      : Number(row.duration_to_close_seconds)
  };
}

function rowToSession(row) {
  if (!row) return null;
  const timing = sessionTimingFromRow(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    status: row.status,
    packetSource: row.packet_source,
    itemCount: row.item_count ?? 0,
    foundCount: row.found_count ?? 0,
    needsReviewCount: row.needs_review_count ?? 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...timing
  };
}

function rowToSessionItem(row, {
  inventoryPhotos = [],
  suggestedInventoryPhotos = [],
  includeSuggestion = false
} = {}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    inventoryItemId: row.inventory_item_id,
    packetLine: row.packet_line,
    expectedQty: row.expected_qty,
    locationHint: row.location_hint,
    importBatchId: row.import_batch_id,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedToEmail: row.assigned_to_email,
    assignedToName: row.assigned_to_name,
    assignedBy: row.assigned_by,
    assignedByEmail: row.assigned_by_email,
    assignedByName: row.assigned_by_name,
    assignedAt: row.assigned_at,
    directVerifiedBy: row.direct_verified_by,
    directVerifiedByEmail: row.direct_verified_by_email,
    inventoryMatchConfirmedBy: row.inventory_match_confirmed_by,
    inventoryMatchConfirmedAt: row.inventory_match_confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inventoryItem: row.inventory_item_id && row.item_title ? {
      id: row.inventory_item_id,
      title: row.item_title,
      commonName: row.common_name,
      armyName: row.army_name,
      lin: row.lin,
      nsn: row.nsn,
      description: row.description,
      currentLocation: row.current_location,
      serialNumber: row.item_serial_number,
      lastVerifiedSubmissionId: row.item_last_verified_submission_id,
      lastVerifiedBy: row.item_last_verified_by,
      lastVerifiedAt: row.item_last_verified_at,
      legacyMediaMetadata: Boolean(row.item_legacy_media_metadata),
      metadata: row.item_metadata || {},
      photos: inventoryPhotos
    } : null,
    suggestedInventoryItem: includeSuggestion && row.suggested_inventory_item_id && row.suggested_item_title ? {
      id: row.suggested_inventory_item_id,
      title: row.suggested_item_title,
      commonName: row.suggested_common_name,
      armyName: row.suggested_army_name,
      lin: row.suggested_lin,
      nsn: row.suggested_nsn,
      description: row.suggested_description,
      currentLocation: row.suggested_current_location,
      serialNumber: row.suggested_serial_number,
      lastVerifiedSubmissionId: row.suggested_last_verified_submission_id,
      lastVerifiedBy: row.suggested_last_verified_by,
      lastVerifiedAt: row.suggested_last_verified_at,
      legacyMediaMetadata: Boolean(row.suggested_legacy_media_metadata),
      metadata: row.suggested_item_metadata || {},
      photos: suggestedInventoryPhotos
    } : null,
    submissions: []
  };
}

function rowToReportItem(row) {
  const item = {
    id: row.id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    sessionStatus: row.session_status,
    sessionCreatedAt: row.session_created_at,
    sessionStartedAt: row.session_started_at,
    sessionClosedAt: row.session_closed_at,
    inventoryItemId: row.inventory_item_id,
    packetLine: row.packet_line,
    expectedQty: row.expected_qty,
    locationHint: row.location_hint,
    status: row.item_status,
    assignedTo: row.assigned_to,
    assignedToEmail: row.assigned_to_email,
    assignedToName: row.assigned_to_name,
    directVerifiedBy: row.direct_verified_by,
    directVerifiedByEmail: row.direct_verified_by_email,
    directVerifiedByName: row.direct_verified_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inventoryItem: row.inventory_item_id ? {
      id: row.inventory_item_id,
      title: row.item_title,
      commonName: row.common_name,
      armyName: row.army_name,
      lin: row.lin,
      nsn: row.nsn,
      description: row.description,
      currentLocation: row.current_location,
      metadata: row.item_metadata || {}
    } : null,
    submissions: []
  };

  if (row.latest_submission_id) {
    item.submissions.push({
      id: row.latest_submission_id,
      sessionItemId: row.id,
      submittedBy: row.latest_submitted_by,
      submittedByEmail: row.latest_submitted_by_email,
      submittedByName: row.latest_submitted_by_name,
      status: row.latest_submission_status,
      locationText: row.latest_location_text,
      note: row.latest_note,
      serialNumber: row.latest_serial_number,
      reviewState: row.latest_review_state,
      reviewNote: row.latest_review_note,
      reviewReturnRoute: row.latest_review_return_route,
      reviewedBy: row.latest_reviewed_by,
      reviewedAt: row.latest_reviewed_at,
      withdrawnBy: row.latest_withdrawn_by,
      withdrawnAt: row.latest_withdrawn_at,
      createdAt: row.latest_created_at,
      photos: []
    });
  }
  return item;
}

function rowToSubmission(row) {
  return {
    id: row.id,
    sessionItemId: row.session_item_id,
    submittedBy: row.submitted_by,
    submittedByEmail: row.submitted_by_email,
    submittedByName: row.submitted_by_name,
    status: row.status,
    locationText: row.location_text,
    note: row.note,
    serialNumber: row.serial_number,
    reviewState: row.review_state,
    reviewNote: row.review_note,
    reviewReturnRoute: row.review_return_route,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    withdrawnBy: row.withdrawn_by,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
    photos: []
  };
}

function rowToPhoto(row) {
  return {
    id: row.id,
    submissionId: row.submission_id,
    mediaUploadId: row.media_upload_id,
    storageKey: row.storage_key,
    url: buildMediaUrl(row.storage_key),
    caption: row.caption,
    kind: row.kind,
    createdAt: row.created_at
  };
}

async function loadInventoryItemMedia(inventoryItemIds, execute = query) {
  const ids = [...new Set((inventoryItemIds || []).filter(Boolean))];
  const byItemId = new Map(ids.map(id => [id, []]));
  if (!ids.length) return byItemId;

  const result = await execute(
    `
      SELECT reference.id,
        reference.inventory_item_id,
        reference.media_upload_id,
        reference.sort_order,
        upload.storage_key,
        evidence.caption,
        evidence.kind
      FROM inventory_item_media reference
      JOIN media_uploads upload ON upload.id = reference.media_upload_id
      LEFT JOIN LATERAL (
        SELECT photo.caption, photo.kind
        FROM submission_photos photo
        WHERE photo.media_upload_id = reference.media_upload_id
        ORDER BY photo.created_at DESC, photo.id DESC
        LIMIT 1
      ) evidence ON true
      WHERE reference.inventory_item_id = ANY($1::uuid[])
        AND upload.state = 'attached'
      ORDER BY reference.inventory_item_id, reference.sort_order, reference.created_at, reference.id
    `,
    [ids]
  );

  result.rows.forEach(row => {
    const photos = byItemId.get(row.inventory_item_id) || [];
    photos.push({
      id: row.id,
      mediaUploadId: row.media_upload_id,
      url: buildMediaUrl(row.storage_key),
      kind: row.kind || "general",
      caption: row.caption || null
    });
    byItemId.set(row.inventory_item_id, photos);
  });
  return byItemId;
}

async function loadInventoryItemsById(tenantId, inventoryItemIds, execute = query) {
  const ids = [...new Set((inventoryItemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const [itemsResult, mediaByItemId] = await Promise.all([
    execute(
      `
        SELECT *
        FROM inventory_items
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])
      `,
      [tenantId, ids]
    ),
    loadInventoryItemMedia(ids, execute)
  ]);
  return new Map(itemsResult.rows.map(row => [
    row.id,
    rowToInventoryItem(row, mediaByItemId.get(row.id) || [])
  ]));
}

function rowToImportBatch(row, { includeText = false } = {}) {
  const batch = {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    sourceName: row.source_name,
    sourceMimeType: row.source_mime_type,
    sourceSizeBytes: row.source_size_bytes == null ? null : Number(row.source_size_bytes),
    sourceStorageKey: row.source_storage_key,
    sourceUrl: row.source_storage_key ? buildMediaUrl(row.source_storage_key) : "",
    rowCount: row.row_count ?? 0,
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    createdByName: row.created_by_name,
    createdAt: row.created_at
  };

  if (includeText) batch.extractedText = row.extracted_text || "";
  return batch;
}

function rowToNewsletterSubscriber(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    platoon: row.platoon,
    supervisorName: row.supervisor_name,
    status: row.status,
    source: row.source,
    lastSubscribedAt: row.last_subscribed_at,
    unsubscribedAt: row.unsubscribed_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    sentCount: Number(row.sent_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: Number(row.skipped_count || 0),
    lastDeliveryStatus: row.last_delivery_status || null,
    lastDeliveryError: row.last_delivery_error || null,
    lastDeliveryAt: row.last_delivery_at || row.last_sent_at || null,
    lastDeliveryIssueTitle: row.last_delivery_issue_title || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToNewsletterIssue(row, { includeBody = false } = {}) {
  if (!row) return null;

  const issue = {
    id: row.id,
    title: row.title,
    editionLabel: row.edition_label,
    summary: row.summary,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentCount: Number(row.sent_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: Number(row.skipped_count || 0)
  };

  if (includeBody) issue.body = row.body;
  return issue;
}

function rowToNewsletterDelivery(row) {
  return {
    id: row.id,
    issueId: row.issue_id,
    issueTitle: row.issue_title,
    subscriberId: row.subscriber_id,
    subscriberName: row.subscriber_display_name,
    subscriberStatus: row.subscriber_status,
    email: row.email,
    status: row.status,
    error: row.error,
    sentAt: row.sent_at,
    createdAt: row.created_at
  };
}

function rowToFrgContentBlock(row) {
  return {
    id: row.id,
    blockType: row.block_type,
    title: row.title,
    summary: row.summary,
    body: row.body,
    href: row.href,
    linkLabel: row.link_label,
    eventAt: row.event_at,
    sortOrder: Number(row.sort_order || 0),
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToTenantGuidance(row) {
  return {
    body: row?.body || "",
    updatedAt: row?.updated_at || null,
    updatedByEmail: row?.updated_by_email || null,
    updatedByName: row?.updated_by_name || null
  };
}

function normalizeTenantNotificationPreferences(value) {
  const stored = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(defaultTenantNotificationPreferences).map(([key, defaultValue]) => [
      key,
      typeof stored[key] === "boolean" ? stored[key] : defaultValue
    ])
  );
}

function normalizeTenantAlertRecipientEmail(value) {
  const stored = value && typeof value === "object" ? value : {};
  const email = String(stored.alert_recipient_email || "").trim().toLowerCase();
  return z.string().email().max(254).safeParse(email).success ? email : "";
}

async function getTenantNotificationConfig(tenantId, client = null) {
  const runQuery = client ? client.query.bind(client) : query;
  const result = await runQuery(
    "SELECT notification_preferences FROM tenant_settings WHERE tenant_id = $1 LIMIT 1",
    [tenantId]
  );
  const stored = result.rows[0]?.notification_preferences;
  return {
    preferences: normalizeTenantNotificationPreferences(stored),
    alertRecipientEmail: normalizeTenantAlertRecipientEmail(stored)
  };
}

async function getTenantNotificationPreferences(tenantId, client = null) {
  return (await getTenantNotificationConfig(tenantId, client)).preferences;
}

function tenantSettingsResponse(context, row = {}) {
  const tenantGroup = `${config.oidc.tenantGroupPrefix}${context.tenant.slug}`.toLowerCase();
  return {
    displayName: row.name || context.tenant.name,
    defaultGuidance: row.guidance_body || "",
    alertRecipientEmail: normalizeTenantAlertRecipientEmail(row.notification_preferences),
    notificationPreferences: normalizeTenantNotificationPreferences(row.notification_preferences),
    workspace: {
      slug: context.tenant.slug,
      status: context.tenant.status,
      url: tenantBaseUrl(context.tenant),
      baseDomain: config.baseDomain
    },
    groupMapping: {
      tenantGroup,
      tenantAdminGroup: config.oidc.tenantAdminGroup,
      platformAdminGroup: config.oidc.platformAdminGroup
    }
  };
}

function auditTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function decodeTenantAuditCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    const createdAt = z.string().datetime({ offset: true }).safeParse(parsed?.createdAt);
    const id = z.string().uuid().safeParse(parsed?.id);
    if (!createdAt.success || !id.success) return null;
    return { createdAt: createdAt.data, id: id.data };
  } catch {
    return null;
  }
}

function encodeTenantAuditCursor(row) {
  return Buffer.from(JSON.stringify({
    createdAt: auditTimestamp(row.created_at),
    id: row.id
  }), "utf8").toString("base64url");
}

function tenantAuditCategoryForAction(action) {
  const normalized = String(action || "");
  for (const [category, prefixes] of Object.entries(tenantAuditCategoryPrefixes)) {
    if (prefixes.some(prefix => normalized.startsWith(prefix))) return category;
  }
  return "other";
}

function auditText(value, maxLength = 600) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function auditInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function auditBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function compactAuditDetails(details) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== null));
}

function safeTenantAuditDetails(action, value) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};

  if (action === "tenant.created") {
    return compactAuditDetails({
      slug: auditText(metadata.slug, 100),
      hostname: auditText(metadata.hostname, 255),
      adminEmail: auditText(metadata.adminEmail, 320)
    });
  }
  if (action === "tenant.settings_updated") {
    const allowedFields = new Set(["display_name", "default_guidance", "notification_preferences"]);
    const changedFields = Array.isArray(metadata.changedFields)
      ? metadata.changedFields.map(field => auditText(field, 80)).filter(field => field && allowedFields.has(field)).slice(0, 10)
      : [];
    return changedFields.length ? { changedFields } : {};
  }
  if (action === "tenant_guidance.updated") {
    return compactAuditDetails({ length: auditInteger(metadata.length) });
  }
  if (action.startsWith("member.")) {
    return compactAuditDetails({
      email: auditText(metadata.email, 320),
      displayName: auditText(metadata.displayName, 120),
      previousRole: auditText(metadata.previousRole, 80),
      previousStatus: auditText(metadata.previousStatus, 80),
      role: auditText(metadata.role, 80),
      status: auditText(metadata.status, 80),
      acknowledgedUnknownEnrollment: auditBoolean(metadata.acknowledgedUnknownEnrollment)
    });
  }
  if (action.startsWith("invitation.")) {
    return compactAuditDetails({
      email: auditText(metadata.email, 320),
      role: auditText(metadata.role, 80),
      expiresAt: auditTimestamp(metadata.expiresAt)
    });
  }
  if (action === "inventory_item.created") {
    return compactAuditDetails({ mediaUploadCount: auditInteger(metadata.mediaUploadCount) });
  }
  if (action === "inventory_session.created") {
    return compactAuditDetails({
      sessionName: auditText(metadata.sessionName, 240),
      status: auditText(metadata.status, 80)
    });
  }
  if (action === "inventory_session.updated") {
    return compactAuditDetails({
      sessionName: auditText(metadata.sessionName, 240),
      status: auditText(metadata.status, 80)
    });
  }
  if (action === "inventory_session.deleted") {
    return compactAuditDetails({ name: auditText(metadata.name, 240) });
  }
  if (action === "session_items.bulk_created") {
    return compactAuditDetails({
      sessionName: auditText(metadata.sessionName, 240),
      count: auditInteger(metadata.count),
      matchedCount: auditInteger(metadata.matchedCount),
      sourceName: auditText(metadata.sourceName, 240)
    });
  }
  if (action === "session_item.created") {
    return compactAuditDetails({
      sessionName: auditText(metadata.sessionName, 240),
      packetLine: auditText(metadata.packetLine, 1000),
      expectedQty: auditInteger(metadata.expectedQty),
      locationHint: auditText(metadata.locationHint, 600)
    });
  }
  if (action === "session_item.assigned") {
    return compactAuditDetails({
      assignedToEmail: auditText(metadata.assignedToEmail, 320),
      assignedToRole: auditText(metadata.assignedToRole, 80)
    });
  }
  if (action === "session_item.direct_check") {
    return compactAuditDetails({
      status: auditText(metadata.status, 80),
      note: auditText(metadata.note)
    });
  }
  if (action === "submission.created") {
    return compactAuditDetails({
      status: auditText(metadata.status, 80),
      photoCount: auditInteger(metadata.photoCount)
    });
  }
  if (action === "submission.reviewed") {
    return compactAuditDetails({
      decision: auditText(metadata.decision, 80),
      note: auditText(metadata.note),
      returnAssignment: auditText(metadata.returnAssignment, 80)
    });
  }
  if (action === "submission.withdrawn") {
    return compactAuditDetails({
      previousReviewState: auditText(metadata.previousReviewState, 80)
    });
  }
  if (["submission.withdrawal_conflicted", "submission.review_conflicted"].includes(action)) {
    return compactAuditDetails({
      currentReviewState: auditText(metadata.currentReviewState, 80)
    });
  }
  if (action === "evidence_request.created") {
    const requestedFields = Array.isArray(metadata.requestedFields)
      ? metadata.requestedFields.map(field => auditText(field, 80)).filter(Boolean).slice(0, 20)
      : [];
    return compactAuditDetails({
      requestedFields: requestedFields.length ? requestedFields : undefined,
      message: auditText(metadata.message)
    });
  }
  if (action.startsWith("media_upload.")) {
    return compactAuditDetails({
      purpose: auditText(metadata.purpose, 80),
      mimeType: auditText(metadata.mimeType, 160),
      sizeBytes: auditInteger(metadata.sizeBytes),
      attachedToType: auditText(metadata.attachedToType, 100),
      ownerOverride: auditBoolean(metadata.ownerOverride)
    });
  }

  return {};
}

function rowToTenantAuditEvent(row) {
  const details = safeTenantAuditDetails(row.action, row.metadata);
  const context = row.context_session_id ? {
    sessionId: row.context_session_id,
    sessionName: auditText(details.sessionName, 240) || auditText(row.context_session_name, 240) || null,
    sessionItemId: row.context_session_item_id || null,
    packetLine: auditText(row.context_packet_line, 1000) || null
  } : null;

  return {
    id: row.id,
    action: row.action,
    category: tenantAuditCategoryForAction(row.action),
    entity: {
      type: row.entity_type,
      id: row.entity_id || null
    },
    actor: row.actor_user_id ? {
      id: row.actor_user_id,
      displayName: row.actor_display_name || null,
      email: row.actor_email || null
    } : null,
    details,
    context,
    createdAt: auditTimestamp(row.created_at)
  };
}

function groupFrgContentBlocks(rows) {
  const groups = {
    announcements: [],
    events: [],
    resources: []
  };

  rows.forEach(row => {
    const block = rowToFrgContentBlock(row);
    if (block.blockType === "announcement") groups.announcements.push(block);
    if (block.blockType === "event") groups.events.push(block);
    if (block.blockType === "resource") groups.resources.push(block);
  });

  return groups;
}

function safePublicHref(value) {
  const href = String(value || "").trim();
  if (!href) return null;
  if (href.startsWith("/") || href.startsWith("#")) return href;

  try {
    const url = new URL(href);
    return ["https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function normalizeFrgContentPayload(body) {
  const href = safePublicHref(body.href);
  if (String(body.href || "").trim() && !href) {
    const error = new Error("Public links must use https, mailto, /, or #.");
    error.statusCode = 400;
    throw error;
  }

  let eventAt = null;
  if (String(body.eventAt || "").trim()) {
    const date = new Date(body.eventAt);
    if (Number.isNaN(date.getTime())) {
      const error = new Error("Event date is invalid");
      error.statusCode = 400;
      throw error;
    }
    eventAt = date.toISOString();
  }

  return {
    blockType: body.blockType,
    title: body.title.trim(),
    summary: String(body.summary || "").trim() || null,
    body: String(body.body || "").trim() || null,
    href,
    linkLabel: String(body.linkLabel || "").trim() || null,
    eventAt,
    sortOrder: body.sortOrder ?? 100,
    status: body.status || "draft"
  };
}

function localMediaStorageKeys(value) {
  const storageKeys = new Set();
  const visit = current => {
    if (typeof current === "string") {
      const storageKey = mediaStorageKeyFromUrl(current);
      if (storageKey) storageKeys.add(storageKey);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === "object") {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...storageKeys];
}

function withoutLegacyInventoryImages(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const cleaned = { ...metadata };
  [
    "image",
    "images",
    "imageUrl",
    "imageUrls",
    "photo",
    "photos",
    "thumbnail",
    "thumbnailUrl"
  ].forEach(key => delete cleaned[key]);
  if (Array.isArray(cleaned.fields)) {
    cleaned.fields = cleaned.fields.filter(field => {
      const label = String(field?.label || "").toLowerCase();
      return !label.includes("image") && !label.includes("photo");
    });
  }
  return cleaned;
}

function imageBufferMatchesMimeType(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function parseImagePayload(body) {
  const mimeType = String(body.mimeType || "").toLowerCase();
  const extension = imageMimeTypes.get(mimeType);
  if (!extension) {
    const error = new Error("Unsupported image type");
    error.statusCode = 400;
    throw error;
  }

  let base64 = String(body.base64 || "").trim();
  const dataUrl = String(body.dataUrl || "").trim();
  if (!base64 && dataUrl) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      const error = new Error("Invalid image data URL");
      error.statusCode = 400;
      throw error;
    }
    if (match[1].toLowerCase() !== mimeType) {
      const error = new Error("Image data type does not match mimeType");
      error.statusCode = 400;
      throw error;
    }
    base64 = match[2];
  }

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
    const error = new Error("Image must be 12MB or smaller");
    error.statusCode = 400;
    throw error;
  }
  if (!imageBufferMatchesMimeType(buffer, mimeType)) {
    const error = new Error("Image data does not match mimeType");
    error.statusCode = 400;
    throw error;
  }

  return { buffer, extension };
}

function parseFilePayload(body, allowedMimeTypes, maxBytes) {
  const mimeType = String(body.mimeType || "").toLowerCase();
  const extension = allowedMimeTypes.get(mimeType);
  if (!extension) {
    const error = new Error("Unsupported file type");
    error.statusCode = 400;
    throw error;
  }

  let base64 = String(body.base64 || "").trim();
  const dataUrl = String(body.dataUrl || "").trim();
  if (!base64 && dataUrl) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      const error = new Error("Invalid file data URL");
      error.statusCode = 400;
      throw error;
    }
    if (match[1].toLowerCase() !== mimeType) {
      const error = new Error("File data type does not match mimeType");
      error.statusCode = 400;
      throw error;
    }
    base64 = match[2];
  }

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > maxBytes) {
    const error = new Error(`File must be ${Math.floor(maxBytes / 1024 / 1024)}MB or smaller`);
    error.statusCode = 400;
    throw error;
  }

  return { buffer, extension };
}

async function saveBufferToStorage(storageKey, buffer) {
  const absolutePath = path.resolve(config.storage.root, storageKey);
  const rootPath = path.resolve(config.storage.root);

  if (!absolutePath.startsWith(rootPath + path.sep)) {
    const error = new Error("Invalid storage path");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer, { flag: "wx" });
  return storageKey;
}

async function deleteStoredFile(storageKey) {
  const normalized = normalizeMediaStorageKey(storageKey);
  if (!normalized) return;
  const rootPath = path.resolve(config.storage.root);
  const absolutePath = path.resolve(rootPath, normalized);
  if (!absolutePath.startsWith(rootPath + path.sep)) return;
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function verifyRegisteredUploadFile(upload) {
  const storageKey = normalizeMediaStorageKey(upload?.storage_key);
  if (!storageKey) throw requestError("Photo upload is unavailable. Upload the file again.", 409);
  const rootPath = path.resolve(config.storage.root);
  const absolutePath = path.resolve(rootPath, storageKey);
  if (!absolutePath.startsWith(rootPath + path.sep)) {
    throw requestError("Photo upload is unavailable. Upload the file again.", 409);
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw requestError("Photo upload is unavailable. Upload the file again.", 409);
    throw error;
  }
  if (!stat.isFile() || (upload.size_bytes != null && Number(upload.size_bytes) !== stat.size)) {
    throw requestError("Photo upload is unavailable. Upload the file again.", 409);
  }
}

async function saveUploadedImage(tenant, body) {
  const { buffer, extension } = parseImagePayload(body);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const fileName = `${crypto.randomUUID()}${extension}`;
  const storageKey = `tenants/${tenant.slug}/submissions/${month}/${fileName}`;
  await saveBufferToStorage(storageKey, buffer);
  return { storageKey, sizeBytes: buffer.length };
}

async function savePacketImportSource(tenant, body) {
  const { buffer, extension } = parseFilePayload(body, packetSourceMimeTypes, 10 * 1024 * 1024);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const fileName = `${crypto.randomUUID()}${extension}`;
  const storageKey = `tenants/${tenant.slug}/packet-imports/${month}/${fileName}`;
  await saveBufferToStorage(storageKey, buffer);
  return { storageKey, sizeBytes: buffer.length };
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function platformTenantResetStoragePath(storageRoot, tenantSlug) {
  const slug = String(tenantSlug || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw requestError("Invalid tenant reset target", 400);
  }

  const tenantsRoot = path.resolve(storageRoot, "tenants");
  const tenantPath = path.resolve(tenantsRoot, slug);
  if (!tenantPath.startsWith(tenantsRoot + path.sep)) {
    throw requestError("Invalid tenant reset storage path", 400);
  }
  return tenantPath;
}

async function assertTenantGroupRemovedForReset(tenant) {
  if (!config.authentikProvisioning.enabled) return;

  try {
    const client = createAuthentikClient({
      origin: config.authentikProvisioning.origin,
      token: config.authentikProvisioning.token,
      timeoutMs: config.authentikProvisioning.requestTimeoutMs
    });
    const groupName = `${config.authentikProvisioning.tenantGroupPrefix}${tenant.slug}`.toLowerCase();
    const group = await client.findGroupByName(groupName);
    if (group) {
      throw permanentAccountError(
        "Remove the workspace account group before deleting this platoon.",
        409,
        "tenant_group_present"
      );
    }
  } catch (error) {
    if (error?.publicCode === "tenant_group_present") throw error;
    throw permanentAccountError(
      "The account service could not verify that workspace access is removed.",
      503,
      "tenant_group_check_failed"
    );
  }
}

async function lockStagedMediaUpload(client, {
  uploadId,
  tenantId,
  userId,
  purpose,
  canUseAnyUploader = false,
  crewAuthSessionId = null,
  crewSessionId = null
}) {
  const result = await client.query(
    `
      SELECT *
      FROM media_uploads
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE
    `,
    [uploadId, tenantId]
  );
  const upload = result.rows[0];
  if (!upload) throw requestError("Photo upload is invalid. Upload the file again.");
  if (upload.purpose !== purpose) throw requestError("Photo upload is not valid for this use.");
  if (upload.state !== "staged") throw requestError("Photo upload has already been used.", 409);
  if (upload.staged_expires_at && new Date(upload.staged_expires_at).getTime() <= Date.now()) {
    throw requestError("Photo upload has expired. Upload the file again.");
  }
  if (!canUseAnyUploader && upload.uploaded_by !== userId) {
    throw requestError("Photo upload belongs to another user.", 403);
  }
  if (crewAuthSessionId && upload.crew_auth_session_id !== crewAuthSessionId) {
    throw requestError("Photo upload belongs to another crew session.", 403);
  }
  if (crewAuthSessionId) {
    await lockActiveCrewAccess(client, {
      authSessionId: crewAuthSessionId,
      tenantId,
      sessionId: crewSessionId,
      userId
    });
  }
  await verifyRegisteredUploadFile(upload);
  return upload;
}

async function assertCrewStagedUploadQuota(client, context) {
  await lockActiveCrewAccess(client, {
    authSessionId: context.crew.authSessionId,
    tenantId: context.tenant.id,
    sessionId: context.crew.sessionId,
    userId: context.user.id,
    lockAuthSessionForUpdate: true
  });
  const result = await client.query(
    `
      SELECT count(*)::int AS staged_count
      FROM media_uploads
      WHERE crew_auth_session_id = $1
        AND state = 'staged'
        AND (staged_expires_at IS NULL OR staged_expires_at > now())
    `,
    [context.crew.authSessionId]
  );
  const stagedCount = Number(result.rows[0]?.staged_count || 0);
  if (stagedCount >= config.crewAccess.maxStagedUploadsPerAuthSession) {
    throw crewRequestError(
      "Finish or submit your current proof photos before uploading more.",
      409,
      "crew_upload_quota"
    );
  }
  return stagedCount;
}

async function attachMediaUpload(client, upload, {
  tenantId,
  actorUserId,
  attachedToType,
  attachedToId
}) {
  const result = await client.query(
    `
      UPDATE media_uploads
      SET
        state = 'attached',
        staged_expires_at = NULL,
        attached_to_type = $2,
        attached_to_id = $3,
        attached_at = now()
      WHERE id = $1
        AND state = 'staged'
      RETURNING *
    `,
    [upload.id, attachedToType, attachedToId]
  );
  if (!result.rows[0]) throw requestError("Photo upload has already been used.", 409);
  await createAuditEvent(client, {
    tenantId,
    actorUserId,
    action: "media_upload.attached",
    entityType: "media_upload",
    entityId: upload.id,
    metadata: {
      purpose: upload.purpose,
      attachedToType,
      attachedToId,
      ownerOverride: Boolean(upload.uploaded_by && upload.uploaded_by !== actorUserId)
    }
  });
  return result.rows[0];
}

async function createAuditEvent(client, { tenantId, actorUserId, action, entityType, entityId, metadata = {} }) {
  await client.query(
    `
      INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [tenantId, actorUserId, action, entityType, entityId, JSON.stringify(metadata)]
  );
}

function createInviteToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function tenantBaseUrl(tenant) {
  const slug = String(tenant?.slug || "").toLowerCase();
  const url = new URL(config.publicAppUrl);
  if (slug) url.hostname = `${slug}.${config.baseDomain}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildInviteUrl(tenant, token) {
  const url = new URL(tenantBaseUrl(tenant));
  url.hash = `/accept-invite?token=${encodeURIComponent(token)}`;
  return url.toString();
}

async function expirePendingInvitations(clientOrDb, tenantId) {
  const runQuery = typeof clientOrDb === "function"
    ? clientOrDb
    : clientOrDb.query.bind(clientOrDb);

  await runQuery(
    `
      UPDATE tenant_invitations
      SET status = 'expired'
      WHERE tenant_id = $1
        AND status = 'pending'
        AND expires_at <= now()
    `,
    [tenantId]
  );
}

async function sendInviteNotification({ context, email, role, inviteUrl }) {
  try {
    return await sendTenantInviteEmail({
      to: email,
      tenantName: context.tenant.name,
      role,
      inviteUrl,
      invitedByName: context.user.display_name || context.user.email
    });
  } catch (error) {
    console.error("invite email failed", error);
    return { sent: false, reason: "send_failed" };
  }
}

function buildTenantAdminUrl(tenant) {
  const url = new URL(tenantBaseUrl(tenant));
  url.hash = "/admin";
  return url.toString();
}

function buildTenantTaskUrl(tenant) {
  return tenantBaseUrl(tenant);
}

function buildNewsletterUnsubscribeUrl(email) {
  const url = new URL(config.publicAppUrl);
  url.hash = `/unsubscribe?email=${encodeURIComponent(email)}`;
  return url.toString();
}

function normalizeMatchText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function textTokens(value) {
  const stopWords = new Set(["THE", "AND", "FOR", "WITH", "TYPE", "SET", "KIT", "GROUP", "SYSTEM"]);
  return normalizeMatchText(value)
    .split(" ")
    .filter(token => token.length >= 3 && !stopWords.has(token));
}

function extractLinValues(text) {
  const values = new Set();
  const normalized = normalizeMatchText(text);
  const matches = normalized.match(/\b[A-Z][0-9]{5}\b/g) || [];
  matches.forEach(value => values.add(value));
  return values;
}

function extractNsnValues(text) {
  const values = new Set();
  const matches = String(text || "").match(/\b\d[\d\s-]{10,}\d\b/g) || [];
  matches.forEach(value => {
    const digits = normalizeDigits(value);
    if (digits.length === 13) values.add(digits);
  });
  return values;
}

function itemMatchProfile(item) {
  const sourceText = [
    item.title,
    item.common_name,
    item.army_name,
    item.description,
    item.current_location
  ].filter(Boolean).join(" ");
  const lins = extractLinValues(sourceText);
  const nsns = extractNsnValues(sourceText);
  const explicitLin = normalizeIdentifier(item.lin);
  const explicitNsn = normalizeDigits(item.nsn);

  if (explicitLin) lins.add(explicitLin);
  if (explicitNsn.length === 13) nsns.add(explicitNsn);

  return {
    ...item,
    lins,
    nsns,
    normalizedTitle: normalizeMatchText(item.title),
    normalizedCommonName: normalizeMatchText(item.common_name),
    normalizedArmyName: normalizeMatchText(item.army_name),
    tokens: new Set(textTokens(sourceText))
  };
}

function scoreInventoryItemMatch(packetLine, item) {
  const packetText = normalizeMatchText(packetLine);
  const packetLinValues = extractLinValues(packetLine);
  const packetNsnValues = extractNsnValues(packetLine);
  let score = 0;
  const reasons = [];

  for (const nsn of packetNsnValues) {
    if (item.nsns.has(nsn)) {
      score += 1000;
      reasons.push("nsn");
    }
  }

  for (const lin of packetLinValues) {
    if (item.lins.has(lin)) {
      score += 900;
      reasons.push("lin");
    }
  }

  if (item.normalizedCommonName && item.normalizedCommonName.length >= 4 && packetText.includes(item.normalizedCommonName)) {
    score += 260;
    reasons.push("common_name");
  }

  if (item.normalizedArmyName && item.normalizedArmyName.length >= 10) {
    if (packetText.includes(item.normalizedArmyName) || item.normalizedArmyName.includes(packetText)) {
      score += 240;
      reasons.push("army_name");
    }
  }

  if (item.normalizedTitle && item.normalizedTitle.length >= 10) {
    if (packetText.includes(item.normalizedTitle) || item.normalizedTitle.includes(packetText)) {
      score += 220;
      reasons.push("title");
    }
  }

  const packetTokens = textTokens(packetText);
  const overlap = packetTokens.filter(token => item.tokens.has(token));
  if (overlap.length >= 2) {
    score += overlap.length * 45;
    reasons.push("tokens");
  }

  return { score, reasons };
}

function findInventoryItemMatch(packetLine, inventoryItems) {
  let best = null;
  let runnerUp = null;

  for (const item of inventoryItems) {
    const scored = scoreInventoryItemMatch(packetLine, item);
    if (!best || scored.score > best.score) {
      runnerUp = best;
      best = { item, ...scored };
    } else if (!runnerUp || scored.score > runnerUp.score) {
      runnerUp = { item, ...scored };
    }
  }

  if (!best || best.score < 180) return null;
  if (!best.reasons.includes("lin") && !best.reasons.includes("nsn") && best.score < 260) return null;
  if (runnerUp && runnerUp.score > 0 && best.score - runnerUp.score < 80) return null;
  return best;
}

export function findUniqueInventoryIdentifierMatch(packetLine, inventoryItems) {
  const packetLins = extractLinValues(packetLine);
  const packetNsns = extractNsnValues(packetLine);
  if (!packetLins.size && !packetNsns.size) return null;

  const matches = inventoryItems.filter(item => (
    [...packetLins].some(lin => item.lins?.has(lin))
    || [...packetNsns].some(nsn => item.nsns?.has(nsn))
  ));
  return matches.length === 1 ? matches[0] : null;
}

function displayNameFor(user) {
  return user?.displayName || user?.display_name || user?.email || null;
}

function runNotification(label, task) {
  Promise.resolve()
    .then(task)
    .catch(error => {
      console.error(`${label} notification failed`, error);
    });
}

async function getTenantAdminRecipients(tenantId, excludeUserId = null) {
  const result = await query(
    `
      SELECT DISTINCT u.id, u.email, u.display_name
      FROM tenant_memberships tm
      JOIN app_users u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1
        AND tm.role = 'tenant_admin'
        AND tm.status = 'active'
        AND u.email IS NOT NULL
        AND u.email <> ''
        AND ($2::uuid IS NULL OR u.id <> $2::uuid)
      ORDER BY u.email ASC
    `,
    [tenantId, excludeUserId]
  );

  return result.rows;
}

async function notifyTenantAdminsOfSubmission(context, submission, { photoCount = 0 } = {}) {
  const notificationConfig = await getTenantNotificationConfig(context.tenant.id);
  const preferences = notificationConfig.preferences;
  if (!preferences.email_proof_submitted) return;
  const recipients = notificationConfig.alertRecipientEmail
    ? [{ id: null, email: notificationConfig.alertRecipientEmail, display_name: null }]
    : await getTenantAdminRecipients(context.tenant.id, context.user.id);
  if (!recipients.length) return;

  const results = await Promise.allSettled(
    recipients.map(recipient => sendProofSubmittedEmail({
      to: recipient.email,
      tenantName: context.tenant.name,
      sessionName: submission.session_name,
      packetLine: submission.packet_line,
      submittedByName: displayNameFor(context.user),
      status: submission.status,
      locationText: submission.location_text,
      serialNumber: submission.serial_number,
      note: submission.note,
      photoCount,
      reviewUrl: buildTenantAdminUrl(context.tenant)
    }))
  );

  results
    .filter(result => result.status === "rejected")
    .forEach(result => console.error("Proof submission email failed", result.reason));
}

async function notifySubmitterOfProofRequest(context, submissionId, decisionNote) {
  const preferences = await getTenantNotificationPreferences(context.tenant.id);
  if (!preferences.email_proof_requests) return;
  const result = await query(
    `
      SELECT sub.id,
        sub.review_note,
        submitter.email AS submitted_by_email,
        submitter.display_name AS submitted_by_name,
        si.packet_line,
        s.name AS session_name
      FROM item_submissions sub
      JOIN inventory_session_items si ON si.id = sub.session_item_id
      JOIN inventory_sessions s ON s.id = si.session_id
      JOIN app_users submitter ON submitter.id = sub.submitted_by
      WHERE sub.id = $1
        AND s.tenant_id = $2
    `,
    [submissionId, context.tenant.id]
  );

  const row = result.rows[0];
  if (!row?.submitted_by_email) return;

  await sendProofRequestEmail({
    to: row.submitted_by_email,
    tenantName: context.tenant.name,
    sessionName: row.session_name,
    packetLine: row.packet_line,
    requestedByName: displayNameFor(context.user),
    decisionNote: decisionNote || row.review_note,
    taskUrl: buildTenantTaskUrl(context.tenant)
  });
}

function compactText(value, maxLength = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function notificationAction({ label, tab, sessionId = null, sessionItemId = null, submissionId = null }) {
  return {
    label,
    tab,
    sessionId,
    sessionItemId,
    submissionId
  };
}

async function requireContext(request, reply, roles = [], { allowCrew = false } = {}) {
  let auth = null;
  if (allowCrew && !hasPrimaryAuthCredentials(request)) {
    auth = await authenticateCrewRequest(request);
  }
  if (!auth) auth = await authContext(request, reply);
  const context = await tenantContext(request, auth);

  if (auth.authKind === "crew") {
    if (!allowCrew || !context.tenant || context.tenant.id !== auth.crew.tenantId) {
      reply.code(403);
      throw new Error("Crew access is not valid for this platoon.");
    }
    context.authKind = "crew";
    context.crew = auth.crew;
    context.membership = {
      id: `crew:${auth.crew.grantId}`,
      tenant_id: auth.crew.tenantId,
      user_id: auth.user.id,
      role: "crew",
      status: "active",
      source: "session_code"
    };
    context.access = {
      source: "session_code",
      effectiveRole: "crew",
      effectiveStatus: "active",
      databaseMembership: null,
      authentikMembership: null,
      platformAdminOverride: false,
      expectedTenantGroup: "",
      expectedTenantAdminGroup: "",
      matchedGroups: [],
      warnings: []
    };
    return context;
  }

  if (roles.length && !hasTenantRole(context, roles)) {
    reply.code(403);
    throw new Error("Tenant access denied");
  }

  return context;
}

async function requireTenantContext(request, reply, roles = [], options = {}) {
  const context = await requireContext(request, reply, roles, options);

  if (!context.tenant) {
    reply.code(404);
    throw new Error("Tenant not found for this hostname");
  }

  issueMediaSession(request.res, context);

  return context;
}

async function requirePlatformAdmin(request, reply) {
  const auth = await authContext(request, reply);

  if (!auth.identity.isPlatformAdmin) {
    reply.code(403);
    throw new Error("Platform admin access required");
  }

  return auth;
}

async function requireFrgAdmin(request, reply) {
  const auth = await authContext(request, reply);

  if (!auth.identity.isFrgAdmin && !auth.identity.isPlatformAdmin) {
    reply.code(403);
    throw new Error("Newsletter admin access required");
  }

  return auth;
}

async function deliverNewsletterIssue(issue) {
  const subscribers = await query(
    `
      SELECT s.*
      FROM newsletter_subscribers s
      WHERE s.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM newsletter_deliveries d
          WHERE d.issue_id = $1 AND d.email = s.email
        )
      ORDER BY s.created_at ASC
    `,
    [issue.id]
  );
  const counts = { sent: 0, skipped: 0, failed: 0 };

  for (const subscriber of subscribers.rows) {
    let deliveryStatus = "sent";
    let errorText = null;

    try {
      const result = await sendNewsletterIssueEmail({
        to: subscriber.email,
        issue,
        unsubscribeUrl: buildNewsletterUnsubscribeUrl(subscriber.email)
      });

      if (!result.sent) {
        deliveryStatus = "skipped";
        errorText = result.reason || "not_sent";
      }
    } catch (error) {
      deliveryStatus = "failed";
      errorText = error.message || "delivery_failed";
    }

    counts[deliveryStatus] += 1;
    await query(
      `
        INSERT INTO newsletter_deliveries (issue_id, subscriber_id, email, status, error, sent_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)
        ON CONFLICT (issue_id, email) DO NOTHING
      `,
      [issue.id, subscriber.id, subscriber.email, deliveryStatus, errorText]
    );
  }

  return {
    total: subscribers.rows.length,
    ...counts
  };
}

function route(app, method, path, handler) {
  app[method](path, async (request, response, next) => {
    const reply = {
      statusCode: 200,
      code(statusCode) {
        this.statusCode = statusCode;
        response.status(statusCode);
        return this;
      }
    };

    try {
      const result = await handler(request, reply);
      if (!response.headersSent) response.status(reply.statusCode).json(result ?? {});
    } catch (error) {
      if (reply.statusCode >= 400) error.statusCode = reply.statusCode;
      next(error);
    }
  });
}

function statusCodeForError(error) {
  if (error instanceof z.ZodError) return 400;
  if (error?.type === "entity.too.large") return 413;
  if (error?.message === "Origin not allowed") return 403;
  if (error?.code === "23505") return 409;
  if (["22P02", "22001", "23502"].includes(error?.code)) return 400;
  if (error?.code === "23503") return 409;

  const explicitStatus = Number(error?.statusCode || error?.status || 0);
  return explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus : 500;
}

function publicErrorFor(error, statusCode) {
  const message = String(error?.message || "Request failed");

  if (error?.publicCode && /^[a-z0-9_]+$/.test(error.publicCode)) {
    return { code: error.publicCode, message };
  }

  if (error instanceof z.ZodError) {
    return { code: "validation_failed", message: "Validation failed" };
  }
  if (error?.type === "entity.too.large" || /must be .*mb or smaller|payload too large|entity too large/i.test(message)) {
    return { code: "upload_too_large", message: "The upload is too large." };
  }
  if (/unsupported (file|image) type/i.test(message)) {
    return { code: "unsupported_file_type", message };
  }
  if (error?.message === "Origin not allowed") {
    return { code: "cors_origin_denied", message: "This site is not allowed to call the inventory API." };
  }
  if (error?.code === "23505") {
    return { code: "database_conflict", message: "That record already exists." };
  }
  if (error?.code === "23503") {
    return { code: "invalid_reference", message: "A related record is missing or still in use." };
  }
  if (["22P02", "22001", "23502"].includes(error?.code)) {
    return { code: "invalid_input", message: "The submitted data is invalid." };
  }
  if (/enoent|eacces|storage/i.test(`${error?.code || ""} ${message}`) && statusCode >= 500) {
    return { code: "storage_unavailable", message: "File storage is temporarily unavailable." };
  }

  if (statusCode === 400) return { code: "invalid_request", message };
  if (statusCode === 401) return { code: "authentication_required", message: "Authentication required" };
  if (statusCode === 403) return { code: "access_denied", message };
  if (statusCode === 404) {
    return {
      code: /tenant/i.test(message) ? "tenant_not_found" : "not_found",
      message
    };
  }
  if (statusCode === 409) return { code: "conflict", message };
  if (statusCode === 413) return { code: "upload_too_large", message: "The upload is too large." };
  if (statusCode === 422) return { code: "invalid_identity", message };
  if (statusCode >= 500) {
    return { code: "internal_error", message: "The server could not complete this request." };
  }

  return { code: "request_failed", message };
}

function registerErrorHandler(app) {
  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const requestId = request.requestId || crypto.randomUUID();
    const statusCode = statusCodeForError(error);
    const publicError = publicErrorFor(error, statusCode);
    let tenantSlug = null;
    try {
      tenantSlug = tenantSlugFromHost(request) || null;
    } catch {
      tenantSlug = null;
    }

    response.setHeader("X-Request-ID", requestId);
    console.error(JSON.stringify({
      event: "api_request_failed",
      requestId,
      method: request.method,
      path: request.path,
      tenantSlug,
      authenticatedSubject: request.authenticatedSubject || null,
      statusCode,
      errorClass: error?.name || "Error",
      errorCode: error?.code || null,
      publicCode: publicError.code,
      errorMessage: String(error?.message || error),
      stack: statusCode >= 500 ? error?.stack || null : undefined
    }));

    const payload = {
      error: publicError.message,
      code: publicError.code,
      requestId
    };
    if (error instanceof z.ZodError) {
      payload.details = badRequestFromZod(error).details;
    }

    response.status(statusCode).json(payload);
  });
}

function isAllowedOidcRedirectUri(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const baseDomain = config.baseDomain.toLowerCase();
    const isLocal = ["localhost", "127.0.0.1"].includes(hostname);
    const isAppDomain = url.protocol === "https:" && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`));
    return (isAppDomain || isLocal) && url.pathname === "/";
  } catch {
    return false;
  }
}

export function registerRoutes(app) {
  route(app, "get", "/health", async (request, reply) => {
    let database = true;
    let storage = true;

    try {
      await query("SELECT 1");
    } catch (error) {
      database = false;
      console.error(JSON.stringify({
        event: "health_database_failed",
        requestId: request.requestId || null,
        errorCode: error?.code || null,
        errorMessage: error?.message || String(error)
      }));
    }

    try {
      await fs.access(config.storage.root, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      storage = false;
      console.error(JSON.stringify({
        event: "health_storage_failed",
        requestId: request.requestId || null,
        errorCode: error?.code || null,
        errorMessage: error?.message || String(error)
      }));
    }

    const ok = database && storage;
    if (!ok) reply.code(503);
    return { ok, database, storage };
  });

  route(app, "post", "/api/auth/oidc/token", async (request, reply) => {
    const body = z.object({
      code: z.string().min(1),
      codeVerifier: z.string().min(32),
      redirectUri: z.string().url()
    }).parse(request.body);

    if (!isAllowedOidcRedirectUri(body.redirectUri)) {
      reply.code(400);
      throw new Error("OIDC redirect URI is not allowed");
    }

    const tokenSet = await exchangeOidcCode(body);
    request.res.setHeader("Cache-Control", "no-store");
    if (tokenSet.refresh_token) issueOidcRefreshCookie(request.res, tokenSet.refresh_token);
    else clearOidcRefreshCookie(request.res);
    const { refresh_token: refreshToken, ...publicTokenSet } = tokenSet;
    return { ...publicTokenSet, refresh_available: Boolean(refreshToken) };
  });

  route(app, "post", "/api/auth/oidc/refresh", async (request, reply) => {
    const body = z.object({
      refreshToken: z.string().min(16).max(8192).optional()
    }).strict().parse(request.body || {});
    request.res.setHeader("Cache-Control", "no-store");
    const refreshToken = body.refreshToken || readCookie(request, oidcRefreshCookieName);
    if (!refreshToken) {
      reply.code(401);
      throw new Error("No renewable sign-in session is available");
    }

    try {
      const tokenSet = await refreshOidcTokens({ refreshToken });
      issueOidcRefreshCookie(request.res, tokenSet.refresh_token || refreshToken);
      const { refresh_token: rotatedRefreshToken, ...publicTokenSet } = tokenSet;
      return { ...publicTokenSet, refresh_available: Boolean(rotatedRefreshToken || refreshToken) };
    } catch (error) {
      if (error?.clearRefreshCookie) clearOidcRefreshCookie(request.res);
      throw error;
    }
  });

  route(app, "post", "/api/auth/oidc/logout", async (request) => {
    request.res.setHeader("Cache-Control", "no-store");
    clearOidcRefreshCookie(request.res);
    return { ok: true };
  });

  route(app, "get", "/api/auth/health", async (request, reply) => getAuthHealth(request, reply));

  route(app, "post", "/api/crew/consume", async (request, reply) => {
    const tenant = await resolveTenant(request);
    if (!tenant) {
      reply.code(404);
      throw new Error("Tenant not found for this hostname");
    }
    const consumed = await consumeCrewCode({
      request,
      response: request.res,
      tenant,
      code: request.body?.code,
      inviteToken: request.body?.inviteToken
    });
    return {
      authKind: "crew",
      user: {
        id: consumed.user.id,
        email: null,
        display_name: consumed.user.display_name,
        displayName: consumed.user.display_name
      },
      tenant: rowToTenant(tenant),
      session: {
        id: consumed.grant.session_id,
        name: consumed.grant.session_name,
        status: "active"
      },
      crew: {
        grantId: consumed.grant.id,
        sessionId: consumed.grant.session_id,
        expiresAt: consumed.authSession.expires_at
      },
      expiresAt: consumed.authSession.expires_at
    };
  });

  route(app, "post", "/api/crew/logout", async (request) => {
    await revokeCrewAuthSession(request, request.res);
    return { ok: true };
  });

  route(app, "get", "/api/me", async (request, reply) => {
    const context = await requireContext(request, reply, [], { allowCrew: true });
    if (context.authKind === "crew") {
      return {
        authKind: "crew",
        user: {
          id: context.user.id,
          email: null,
          display_name: context.user.display_name,
          displayName: context.user.display_name
        },
        identity: {
          subject: context.identity.subject,
          email: "",
          displayName: context.identity.displayName
        },
        groups: [],
        isPlatformAdmin: false,
        isFrgAdmin: false,
        tenant: rowToTenant(context.tenant),
        membership: context.membership,
        access: context.access,
        workspaces: [{
          id: context.tenant.id,
          slug: context.tenant.slug,
          name: context.tenant.name,
          status: context.tenant.status,
          role: "crew",
          source: "session_code"
        }],
        crew: context.crew
      };
    }
    const workspaces = await listUserWorkspaces(context.identity, context.user);

    return {
      user: context.user,
      identity: {
        subject: context.identity.subject,
        email: context.identity.email,
        displayName: context.identity.displayName
      },
      groups: context.identity.groups,
      isPlatformAdmin: context.identity.isPlatformAdmin,
      isFrgAdmin: context.identity.isFrgAdmin,
      tenant: rowToTenant(context.tenant),
      membership: context.membership,
      access: context.access,
      workspaces
    };
  });

  route(app, "get", "/api/newsletter/public", async () => {
    const [latestResult, recentResult, contentResult] = await Promise.all([
      query(
        `
          SELECT *
          FROM newsletter_issues
          WHERE status = 'published'
          ORDER BY published_at DESC NULLS LAST, created_at DESC
          LIMIT 1
        `
      ),
      query(
        `
          SELECT *
          FROM newsletter_issues
          WHERE status = 'published'
          ORDER BY published_at DESC NULLS LAST, created_at DESC
          LIMIT 5
        `
      ),
      query(
        `
          SELECT *
          FROM frg_content_blocks
          WHERE status = 'published'
          ORDER BY
            block_type ASC,
            sort_order ASC,
            COALESCE(event_at, published_at, updated_at, created_at) ASC
        `
      )
    ]);

    return {
      latestIssue: rowToNewsletterIssue(latestResult.rows[0], { includeBody: true }),
      issues: recentResult.rows.map(row => rowToNewsletterIssue(row)),
      contentBlocks: groupFrgContentBlocks(contentResult.rows)
    };
  });

  route(app, "post", "/api/newsletter/subscribers", async (request, reply) => {
    const body = parseBody(
      z.object({
        email: z.string().email().max(254),
        displayName: z.string().min(2).max(120),
        platoon: z.string().min(2).max(120),
        supervisorName: z.string().min(2).max(120)
      }),
      request.body
    );
    const email = body.email.trim().toLowerCase();
    const displayName = body.displayName.trim();
    const platoon = body.platoon.trim();
    const supervisorName = body.supervisorName.trim();

    const result = await query(
      `
        INSERT INTO newsletter_subscribers (
          email,
          display_name,
          platoon,
          supervisor_name,
          status,
          source,
          last_subscribed_at,
          unsubscribed_at,
          reviewed_by,
          reviewed_at,
          review_note,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending', 'public_site', now(), NULL, NULL, NULL, NULL, now())
        ON CONFLICT (email) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          platoon = EXCLUDED.platoon,
          supervisor_name = EXCLUDED.supervisor_name,
          status = CASE
            WHEN newsletter_subscribers.status = 'active' THEN 'active'
            ELSE 'pending'
          END,
          last_subscribed_at = now(),
          unsubscribed_at = NULL,
          reviewed_by = CASE
            WHEN newsletter_subscribers.status = 'active' THEN newsletter_subscribers.reviewed_by
            ELSE NULL
          END,
          reviewed_at = CASE
            WHEN newsletter_subscribers.status = 'active' THEN newsletter_subscribers.reviewed_at
            ELSE NULL
          END,
          review_note = CASE
            WHEN newsletter_subscribers.status = 'active' THEN newsletter_subscribers.review_note
            ELSE NULL
          END,
          updated_at = now()
        RETURNING *
      `,
      [email, displayName, platoon, supervisorName]
    );

    reply.code(201);
    return { subscriber: rowToNewsletterSubscriber(result.rows[0]) };
  });

  route(app, "post", "/api/newsletter/unsubscribe", async (request) => {
    const body = parseBody(
      z.object({
        email: z.string().email().max(254)
      }),
      request.body
    );
    const email = body.email.trim().toLowerCase();

    await query(
      `
        UPDATE newsletter_subscribers
        SET status = 'unsubscribed',
          unsubscribed_at = now(),
          updated_at = now()
        WHERE email = $1
      `,
      [email]
    );

    return { ok: true, email, status: "unsubscribed" };
  });

  route(app, "get", "/api/newsletter/admin", async (request, reply) => {
    await requireFrgAdmin(request, reply);

    const [issueResult, statsResult, subscriberResult, contentResult, deliveryResult] = await Promise.all([
      query(
        `
          SELECT i.*,
            COUNT(d.id) FILTER (WHERE d.status = 'sent')::int AS sent_count,
            COUNT(d.id) FILTER (WHERE d.status = 'failed')::int AS failed_count,
            COUNT(d.id) FILTER (WHERE d.status = 'skipped')::int AS skipped_count
          FROM newsletter_issues i
          LEFT JOIN newsletter_deliveries d ON d.issue_id = i.id
          GROUP BY i.id
          ORDER BY
            CASE i.status
              WHEN 'draft' THEN 0
              WHEN 'published' THEN 1
              ELSE 2
            END,
            COALESCE(i.published_at, i.updated_at, i.created_at) DESC
        `
      ),
      query(
        `
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
            COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed_count,
            COUNT(*)::int AS total_count
          FROM newsletter_subscribers
        `
      ),
      query(
        `
          SELECT s.*,
            COUNT(d.id) FILTER (WHERE d.status = 'sent')::int AS sent_count,
            COUNT(d.id) FILTER (WHERE d.status = 'failed')::int AS failed_count,
            COUNT(d.id) FILTER (WHERE d.status = 'skipped')::int AS skipped_count,
            latest.status AS last_delivery_status,
            latest.error AS last_delivery_error,
            COALESCE(latest.sent_at, latest.created_at) AS last_delivery_at,
            latest.sent_at AS last_sent_at,
            latest.issue_title AS last_delivery_issue_title
          FROM newsletter_subscribers s
          LEFT JOIN newsletter_deliveries d ON d.email = s.email
          LEFT JOIN LATERAL (
            SELECT d2.status,
              d2.error,
              d2.sent_at,
              d2.created_at,
              i2.title AS issue_title
            FROM newsletter_deliveries d2
            LEFT JOIN newsletter_issues i2 ON i2.id = d2.issue_id
            WHERE d2.email = s.email
            ORDER BY d2.created_at DESC
            LIMIT 1
          ) latest ON true
          GROUP BY s.id,
            latest.status,
            latest.error,
            latest.sent_at,
            latest.created_at,
            latest.issue_title
          ORDER BY
            CASE s.status
              WHEN 'pending' THEN 0
              WHEN 'active' THEN 1
              WHEN 'rejected' THEN 2
              ELSE 3
            END,
            s.updated_at DESC
        `
      ),
      query(
        `
          SELECT *
          FROM frg_content_blocks
          ORDER BY
            CASE status
              WHEN 'draft' THEN 0
              WHEN 'published' THEN 1
              ELSE 2
            END,
            block_type ASC,
            sort_order ASC,
            updated_at DESC
        `
      ),
      query(
        `
          SELECT d.*,
            i.title AS issue_title,
            s.display_name AS subscriber_display_name,
            s.status AS subscriber_status
          FROM newsletter_deliveries d
          JOIN newsletter_issues i ON i.id = d.issue_id
          LEFT JOIN newsletter_subscribers s ON s.id = d.subscriber_id
          ORDER BY d.created_at DESC
        `
      )
    ]);

    return {
      issues: issueResult.rows.map(row => rowToNewsletterIssue(row, { includeBody: true })),
      contentBlocks: contentResult.rows.map(rowToFrgContentBlock),
      subscriberStats: {
        pending: statsResult.rows[0]?.pending_count || 0,
        active: statsResult.rows[0]?.active_count || 0,
        rejected: statsResult.rows[0]?.rejected_count || 0,
        unsubscribed: statsResult.rows[0]?.unsubscribed_count || 0,
        total: statsResult.rows[0]?.total_count || 0
      },
      deliverySettings: {
        emailConfigured: isEmailConfigured()
      },
      subscribers: subscriberResult.rows.map(rowToNewsletterSubscriber),
      deliveries: deliveryResult.rows.map(rowToNewsletterDelivery)
    };
  });

  route(app, "post", "/api/newsletter/admin/content-blocks", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const payload = normalizeFrgContentPayload(parseBody(frgContentBlockSchema, request.body));

    const created = await withTransaction(async client => {
      const result = await client.query(
        `
          INSERT INTO frg_content_blocks (
            block_type, title, summary, body, href, link_label, event_at, sort_order, status,
            created_by, updated_by, published_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, CASE WHEN $9 = 'published' THEN now() ELSE NULL END)
          RETURNING *
        `,
        [
          payload.blockType,
          payload.title,
          payload.summary,
          payload.body,
          payload.href,
          payload.linkLabel,
          payload.eventAt,
          payload.sortOrder,
          payload.status,
          auth.user.id
        ]
      );

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "frg_content.created",
        entityType: "frg_content_block",
        entityId: result.rows[0].id,
        metadata: { title: payload.title, blockType: payload.blockType, status: payload.status }
      });

      return result.rows[0];
    });

    reply.code(201);
    return { contentBlock: rowToFrgContentBlock(created) };
  });

  route(app, "patch", "/api/newsletter/admin/content-blocks/:blockId", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const payload = normalizeFrgContentPayload(parseBody(frgContentBlockSchema, request.body));

    const updated = await withTransaction(async client => {
      const result = await client.query(
        `
          UPDATE frg_content_blocks
          SET block_type = $1,
            title = $2,
            summary = $3,
            body = $4,
            href = $5,
            link_label = $6,
            event_at = $7,
            sort_order = $8,
            status = $9,
            updated_by = $10,
            published_at = CASE
              WHEN $9 = 'published' AND published_at IS NULL THEN now()
              WHEN $9 <> 'published' THEN NULL
              ELSE published_at
            END,
            updated_at = now()
          WHERE id = $11
          RETURNING *
        `,
        [
          payload.blockType,
          payload.title,
          payload.summary,
          payload.body,
          payload.href,
          payload.linkLabel,
          payload.eventAt,
          payload.sortOrder,
          payload.status,
          auth.user.id,
          request.params.blockId
        ]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "frg_content.updated",
        entityType: "frg_content_block",
        entityId: result.rows[0].id,
        metadata: { title: payload.title, blockType: payload.blockType, status: payload.status }
      });

      return result.rows[0];
    });

    if (!updated) {
      reply.code(404);
      throw new Error("FRG content block not found");
    }

    return { contentBlock: rowToFrgContentBlock(updated) };
  });

  route(app, "delete", "/api/newsletter/admin/content-blocks/:blockId", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);

    const deleted = await withTransaction(async client => {
      const result = await client.query(
        `
          DELETE FROM frg_content_blocks
          WHERE id = $1
          RETURNING *
        `,
        [request.params.blockId]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "frg_content.deleted",
        entityType: "frg_content_block",
        entityId: result.rows[0].id,
        metadata: { title: result.rows[0].title, blockType: result.rows[0].block_type }
      });

      return result.rows[0];
    });

    if (!deleted) {
      reply.code(404);
      throw new Error("FRG content block not found");
    }

    return { ok: true, contentBlock: rowToFrgContentBlock(deleted) };
  });

  route(app, "patch", "/api/newsletter/admin/subscribers/:subscriberId/review", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const body = parseBody(
      z.object({
        decision: z.enum(["approved", "rejected"]),
        note: z.string().max(600).optional()
      }),
      request.body
    );
    const nextStatus = body.decision === "approved" ? "active" : "rejected";

    const reviewed = await withTransaction(async client => {
      const result = await client.query(
        `
          UPDATE newsletter_subscribers
          SET status = $1,
            reviewed_by = $2,
            reviewed_at = now(),
            review_note = $3,
            unsubscribed_at = NULL,
            last_subscribed_at = CASE WHEN $1 = 'active' THEN now() ELSE last_subscribed_at END,
            updated_at = now()
          WHERE id = $4
          RETURNING *
        `,
        [nextStatus, auth.user.id, String(body.note || "").trim() || null, request.params.subscriberId]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.subscriber.reviewed",
        entityType: "newsletter_subscriber",
        entityId: result.rows[0].id,
        metadata: {
          email: result.rows[0].email,
          decision: body.decision,
          status: nextStatus
        }
      });

      return result.rows[0];
    });

    if (!reviewed) {
      reply.code(404);
      throw new Error("Newsletter subscriber not found");
    }

    let notification;
    try {
      notification = await sendNewsletterSubscriberReviewEmail({
        to: reviewed.email,
        displayName: reviewed.display_name,
        decision: body.decision,
        publicUrl: config.publicAppUrl
      });
    } catch (error) {
      notification = { sent: false, reason: "send_failed" };
    }

    return { subscriber: rowToNewsletterSubscriber(reviewed), notification };
  });

  route(app, "post", "/api/newsletter/admin/subscribers/:subscriberId/remove", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const removed = await withTransaction(async client => {
      const result = await client.query(
        `
          UPDATE newsletter_subscribers
          SET status = 'unsubscribed',
            unsubscribed_at = now(),
            reviewed_by = $1,
            reviewed_at = now(),
            updated_at = now()
          WHERE id = $2
          RETURNING *
        `,
        [auth.user.id, request.params.subscriberId]
      );
      if (!result.rows[0]) return null;
      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.subscriber.removed",
        entityType: "newsletter_subscriber",
        entityId: result.rows[0].id,
        metadata: { email: result.rows[0].email, status: "unsubscribed" }
      });
      return result.rows[0];
    });

    if (!removed) {
      reply.code(404);
      throw new Error("Newsletter subscriber not found");
    }

    return { subscriber: rowToNewsletterSubscriber(removed) };
  });

  route(app, "post", "/api/newsletter/admin/issues", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const body = parseBody(newsletterIssueSchema, request.body);

    const created = await withTransaction(async client => {
      const result = await client.query(
        `
          INSERT INTO newsletter_issues (title, edition_label, summary, body, created_by)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [
          body.title.trim(),
          String(body.editionLabel || "").trim() || null,
          String(body.summary || "").trim() || null,
          body.body.trim(),
          auth.user.id
        ]
      );

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.issue.created",
        entityType: "newsletter_issue",
        entityId: result.rows[0].id,
        metadata: { title: body.title.trim() }
      });

      return result.rows[0];
    });

    reply.code(201);
    return { issue: rowToNewsletterIssue(created, { includeBody: true }) };
  });

  route(app, "patch", "/api/newsletter/admin/issues/:issueId", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const body = parseBody(newsletterIssueSchema, request.body);

    const updated = await withTransaction(async client => {
      const result = await client.query(
        `
          UPDATE newsletter_issues
          SET title = $1,
            edition_label = $2,
            summary = $3,
            body = $4,
            updated_at = now()
          WHERE id = $5
            AND status <> 'published'
          RETURNING *
        `,
        [
          body.title.trim(),
          String(body.editionLabel || "").trim() || null,
          String(body.summary || "").trim() || null,
          body.body.trim(),
          request.params.issueId
        ]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.issue.updated",
        entityType: "newsletter_issue",
        entityId: result.rows[0].id,
        metadata: { title: body.title.trim() }
      });

      return result.rows[0];
    });

    if (!updated) {
      const existing = await query(
        "SELECT status FROM newsletter_issues WHERE id = $1 LIMIT 1",
        [request.params.issueId]
      );
      if (existing.rows[0]?.status === "published") {
        reply.code(409);
        throw new Error("Published newsletter issues are read-only. Create a new issue instead.");
      }
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    return { issue: rowToNewsletterIssue(updated, { includeBody: true }) };
  });

  route(app, "delete", "/api/newsletter/admin/issues/:issueId", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);

    const deleted = await withTransaction(async client => {
      const deliveryResult = await client.query(
        "SELECT count(*)::int AS count FROM newsletter_deliveries WHERE issue_id = $1",
        [request.params.issueId]
      );
      const result = await client.query(
        `
          DELETE FROM newsletter_issues
          WHERE id = $1
          RETURNING *
        `,
        [request.params.issueId]
      );

      if (!result.rows[0]) return null;

      const deletedDeliveries = Number(deliveryResult.rows[0]?.count || 0);
      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.issue.deleted",
        entityType: "newsletter_issue",
        entityId: result.rows[0].id,
        metadata: {
          title: result.rows[0].title,
          status: result.rows[0].status,
          deletedDeliveries
        }
      });

      return { issue: result.rows[0], deletedDeliveries };
    });

    if (!deleted) {
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    return {
      ok: true,
      issue: rowToNewsletterIssue(deleted.issue, { includeBody: true }),
      deletedDeliveries: deleted.deletedDeliveries
    };
  });

  route(app, "post", "/api/newsletter/admin/issues/:issueId/publish", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);

    const publishResult = await withTransaction(async client => {
      const existing = await client.query(
        `
          SELECT *
          FROM newsletter_issues
          WHERE id = $1
          FOR UPDATE
        `,
        [request.params.issueId]
      );

      if (!existing.rows[0]) return null;
      if (existing.rows[0].status === "published") {
        return { issue: existing.rows[0], publishedNow: false };
      }

      const result = await client.query(
        `
          UPDATE newsletter_issues
          SET status = 'published',
            published_by = $1,
            published_at = CASE
              WHEN status = 'published' AND published_at IS NOT NULL THEN published_at
              ELSE now()
            END,
            updated_at = now()
          WHERE id = $2
          RETURNING *
        `,
        [auth.user.id, request.params.issueId]
      );

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.issue.published",
        entityType: "newsletter_issue",
        entityId: result.rows[0].id,
        metadata: { title: result.rows[0].title }
      });

      return { issue: result.rows[0], publishedNow: true };
    });

    if (!publishResult) {
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    if (!publishResult.publishedNow) {
      return {
        issue: rowToNewsletterIssue(publishResult.issue, { includeBody: true }),
        delivery: { sent: 0, skipped: 0, failed: 0 },
        alreadyPublished: true
      };
    }

    const delivery = await deliverNewsletterIssue(publishResult.issue);
    return {
      issue: rowToNewsletterIssue(publishResult.issue, { includeBody: true }),
      delivery,
      alreadyPublished: false
    };
  });

  route(app, "post", "/api/newsletter/admin/issues/:issueId/test-send", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);
    const body = parseBody(newsletterTestSendSchema, request.body);
    const email = body.email.trim().toLowerCase();

    const issueResult = await query(
      `
        SELECT *
        FROM newsletter_issues
        WHERE id = $1
        LIMIT 1
      `,
      [request.params.issueId]
    );

    if (!issueResult.rows[0]) {
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    const issue = rowToNewsletterIssue(issueResult.rows[0], { includeBody: true });
    let result;
    try {
      result = await sendNewsletterIssueEmail({
        to: email,
        issue,
        unsubscribeUrl: buildNewsletterUnsubscribeUrl(email)
      });
    } catch (error) {
      result = { sent: false, reason: "send_failed", error: error.message || "delivery_failed" };
    }

    await query(
      `
        INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (NULL, $1, 'newsletter.issue.test_sent', 'newsletter_issue', $2, $3::jsonb)
      `,
      [
        auth.user.id,
        issue.id,
        JSON.stringify({
          email,
          sent: Boolean(result.sent),
          reason: result.reason || null,
          error: result.error || null
        })
      ]
    );

    return { testSend: result, email };
  });

  route(app, "post", "/api/platform/identity-check", async (request, reply) => {
    await requirePlatformAdmin(request, reply);
    const body = parseBody(
      z.object({
        email: z.string().trim().email().max(254).transform(value => value.toLowerCase())
      }).strict(),
      request.body
    );
    const inspection = await inspectPermanentIdentityEmail(body.email);
    const candidateCount = inspection.entries.length;
    return {
      status: candidateCount > 1 ? "ambiguous" : candidateCount === 1 ? "existing" : "new",
      candidateCount,
      candidates: inspection.entries.map(entry => entry.safe)
    };
  });

  route(app, "get", "/api/platform/tenants", async (request, reply) => {
    await requirePlatformAdmin(request, reply);

    const result = await query(
      `
        SELECT t.id, t.slug, t.name, t.status, t.created_at,
          COALESCE((
            SELECT d.hostname
            FROM tenant_domains d
            WHERE d.tenant_id = t.id
            ORDER BY d.is_primary DESC, d.created_at ASC
            LIMIT 1
          ), t.slug || '.' || $1) AS hostname,
          (SELECT COUNT(*)::int FROM tenant_memberships m WHERE m.tenant_id = t.id) AS member_count,
          (
            SELECT COUNT(*)::int
            FROM tenant_memberships m
            WHERE m.tenant_id = t.id
              AND m.role = 'tenant_admin'
              AND m.status = 'active'
          ) AS admin_count,
          (
            (SELECT COUNT(*) FROM tenant_memberships m
              WHERE m.tenant_id = t.id
                AND m.role = 'tenant_admin'
                AND m.status = 'invited')
            +
            (SELECT COUNT(*) FROM tenant_invitations i
              WHERE i.tenant_id = t.id
                AND i.role = 'tenant_admin'
                AND i.status = 'pending'
                AND i.expires_at > now())
          )::int AS pending_admin_invite_count,
          (SELECT COUNT(*)::int FROM packet_import_batches b WHERE b.tenant_id = t.id) AS packet_import_count,
          (
            SELECT COUNT(*)::int
            FROM inventory_sessions active_count
            WHERE active_count.tenant_id = t.id
              AND active_count.status = 'active'
          ) AS active_session_count,
          (
            SELECT COUNT(*)::int
            FROM session_crew_grants crew
            WHERE crew.tenant_id = t.id
              AND crew.expires_at > now()
              AND (
                crew.status = 'pending'
                OR (
                  crew.status = 'consumed'
                  AND EXISTS (
                    SELECT 1
                    FROM session_crew_auth_sessions auth_session
                    WHERE auth_session.grant_id = crew.id
                      AND auth_session.revoked_at IS NULL
                      AND auth_session.expires_at > now()
                  )
                )
              )
          ) AS active_temporary_crew_count,
          latest_active.id AS latest_active_session_id,
          latest_active.name AS latest_active_session_name,
          latest_active.started_at AS latest_active_session_started_at,
          latest_active.item_count AS latest_active_session_item_count,
          latest_active.completed_count AS latest_active_session_completed_count
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT session.id,
            session.name,
            COALESCE(session.started_at, session.created_at) AS started_at,
            COUNT(item.id)::int AS item_count,
            COUNT(item.id) FILTER (WHERE item.status IN ('found', 'not_found', 'mismatch', 'approved'))::int AS completed_count
          FROM inventory_sessions session
          LEFT JOIN inventory_session_items item ON item.session_id = session.id
          WHERE session.tenant_id = t.id
            AND session.status = 'active'
          GROUP BY session.id
          ORDER BY COALESCE(session.started_at, session.created_at) DESC, session.id DESC
          LIMIT 1
        ) latest_active ON true
        ORDER BY t.slug ASC
      `,
      [config.baseDomain]
    );

    const tenants = result.rows.map(row => ({
      ...rowToTenant(row),
      hostname: row.hostname,
      memberCount: row.member_count,
      adminCount: row.admin_count,
      pendingAdminInviteCount: row.pending_admin_invite_count,
      packetImportCount: row.packet_import_count,
      activeSessionCount: row.active_session_count,
      activeTemporaryCrewCount: row.active_temporary_crew_count,
      latestActiveSession: row.latest_active_session_id ? {
        id: row.latest_active_session_id,
        name: row.latest_active_session_name,
        startedAt: row.latest_active_session_started_at,
        itemCount: Number(row.latest_active_session_item_count || 0),
        completedCount: Number(row.latest_active_session_completed_count || 0),
        progressPercent: Number(row.latest_active_session_item_count || 0) > 0
          ? Math.round(
            Number(row.latest_active_session_completed_count || 0)
            / Number(row.latest_active_session_item_count) * 100
          )
          : 0
      } : null
    }));
    const setup = await inspectPlatformSetup(tenants);

    return {
      tenants,
      provisioningAvailable: provisioningAvailable(),
      setup
    };
  });

  route(app, "get", "/api/platform/users", async (request, reply) => {
    await requirePlatformAdmin(request, reply);
    const result = await query(
      `
        SELECT user_account.id,
          user_account.email,
          user_account.display_name,
          user_account.account_type,
          user_account.authentik_subject,
          user_account.created_at,
          user_account.last_seen_at,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', membership.id,
                'tenantId', tenant.id,
                'tenantSlug', tenant.slug,
                'tenantName', tenant.name,
                'role', membership.role,
                'status', membership.status,
                'createdAt', membership.created_at
              )
              ORDER BY tenant.slug
            ) FILTER (WHERE membership.id IS NOT NULL),
            '[]'::jsonb
          ) AS memberships
        FROM app_users user_account
        LEFT JOIN tenant_memberships membership ON membership.user_id = user_account.id
        LEFT JOIN tenants tenant ON tenant.id = membership.tenant_id
        WHERE user_account.account_type = 'authentik'
        GROUP BY user_account.id
        ORDER BY lower(COALESCE(user_account.display_name, user_account.email, '')), user_account.id
      `
    );

    return {
      users: result.rows.map(row => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        accountType: row.account_type,
        hasSignedIn: Boolean(row.authentik_subject),
        isPlatformAdmin: config.platformAdminEmails.includes(String(row.email || "").toLowerCase()),
        memberships: Array.isArray(row.memberships) ? row.memberships : [],
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at
      })),
      management: {
        mutationsAvailable: false,
        reason: "Role and status changes must use the tenant member workflow so Authentik provisioning stays consistent."
      }
    };
  });

  route(app, "post", "/api/platform/tenants", async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2),
        slug: z.string().trim().min(1).max(63)
          .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
        hostname: z.string().trim().min(4).optional(),
        adminEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()).optional(),
        adminDisplayName: z.string().trim().min(2).max(120).optional(),
        authentikUserUuid: z.string().uuid().optional()
      }).strict(),
      request.body
    );
    const tenantGroupName = `${config.authentikProvisioning.tenantGroupPrefix}${body.slug}`.toLowerCase();
    if (
      tenantGroupName.length > 255
      || reservedAuthentikGroupNames().has(tenantGroupName)
    ) {
      reply.code(400);
      throw permanentAccountError(
        "This subdomain cannot be used with the configured account groups.",
        400,
        "invalid_slug"
      );
    }
    if (body.adminEmail) requirePermanentProvisioning();
    if (body.authentikUserUuid && !body.adminEmail) {
      throw permanentAccountError(
        "Choose an admin email before selecting a sign-in account.",
        400,
        "identity_email_required"
      );
    }
    const adminIdentityInspection = body.adminEmail
      ? await inspectPermanentIdentityEmail(body.adminEmail)
      : null;
    const selectedAdminIdentity = adminIdentityInspection
      ? choosePermanentIdentity(adminIdentityInspection, body.authentikUserUuid, { isPlatformAdmin: true })
      : null;

    const created = await withTransaction(async client => {
      const tenantResult = await client.query(
        "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name, status, created_at",
        [body.slug, body.name]
      );
      const tenant = tenantResult.rows[0];

      const hostname = String(body.hostname || `${body.slug}.${config.baseDomain}`).toLowerCase();
      await client.query(
        "INSERT INTO tenant_domains (tenant_id, hostname, is_primary) VALUES ($1, $2, true)",
        [tenant.id, hostname]
      );

      let adminMembership = null;
      if (body.adminEmail) {
        const adminUser = await findOrCreatePermanentUser(client, {
          email: body.adminEmail,
          displayName: body.adminDisplayName || null
        });
        if (selectedAdminIdentity) {
          await bindPermanentUserIdentity(client, adminUser.id, selectedAdminIdentity);
        }

        const membershipResult = await client.query(
          `
            INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
            VALUES ($1, $2, 'tenant_admin', 'invited', $3)
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET
              role = 'tenant_admin',
              status = CASE
                WHEN tenant_memberships.status = 'active' THEN 'active'
                ELSE 'invited'
              END,
              invited_by = EXCLUDED.invited_by
            RETURNING id, tenant_id, user_id, role, status, created_at
          `,
          [tenant.id, adminUser.id, auth.user.id]
        );

        await enqueueMembershipProvisioning(client, {
          membershipId: membershipResult.rows[0].id,
          desiredRole: "tenant_admin",
          desiredState: "active",
          requestedBy: auth.user.id
        });

        await createAuditEvent(client, {
          tenantId: tenant.id,
          actorUserId: auth.user.id,
          action: "member.provisioning_requested",
          entityType: "tenant_membership",
          entityId: membershipResult.rows[0].id,
          metadata: {
            email: adminUser.email,
            displayName: adminUser.display_name || null,
            role: "tenant_admin",
            status: membershipResult.rows[0].status
          }
        });

        adminMembership = await findMemberWithProvisioning(
          (text, params) => client.query(text, params),
          tenant.id,
          membershipResult.rows[0].id
        );
      }

      await createAuditEvent(client, {
        tenantId: tenant.id,
        actorUserId: auth.user.id,
        action: "tenant.created",
        entityType: "tenant",
        entityId: tenant.id,
        metadata: {
          slug: body.slug,
          hostname,
          adminEmail: body.adminEmail || null,
          linkedExistingIdentity: Boolean(selectedAdminIdentity)
        }
      });

      return { tenant, adminMembership };
    });

    if (created.adminMembership) startProvisioningWork();
    reply.code(201);
    return {
      tenant: rowToTenant(created.tenant),
      adminMembership: created.adminMembership ? rowToMember(created.adminMembership) : null
    };
  });

  route(app, "delete", "/api/platform/tenants/:tenantId", async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply);
    const tenantId = z.string().uuid().parse(request.params.tenantId);
    const body = parseBody(
      z.object({
        confirmSlug: z.string().trim().min(1).max(63)
      }).strict(),
      request.body
    );

    const targetResult = await query(
      "SELECT id, slug, name, status FROM tenants WHERE id = $1 LIMIT 1",
      [tenantId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      reply.code(404);
      throw new Error("Tenant not found");
    }
    if (body.confirmSlug.toLowerCase() !== target.slug) {
      throw permanentAccountError(
        "Type the exact platoon subdomain to confirm deletion.",
        400,
        "tenant_reset_confirmation_failed"
      );
    }

    await assertTenantGroupRemovedForReset(target);
    const storagePath = platformTenantResetStoragePath(config.storage.root, target.slug);
    const reset = await withTransaction(async client => {
      const lockedResult = await client.query(
        "SELECT id, slug, name, status FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId]
      );
      const locked = lockedResult.rows[0];
      if (!locked) throw requestError("Tenant not found", 404);
      if (locked.slug !== target.slug) throw requestError("Tenant reset target changed", 409);

      const countsResult = await client.query(
        `
          SELECT
            (SELECT count(*)::int FROM tenant_memberships WHERE tenant_id = $1) AS memberships,
            (SELECT count(*)::int FROM inventory_sessions WHERE tenant_id = $1) AS sessions,
            (SELECT count(*)::int FROM inventory_items WHERE tenant_id = $1) AS inventory_items,
            (SELECT count(*)::int FROM packet_import_batches WHERE tenant_id = $1) AS packet_imports,
            (SELECT count(*)::int FROM media_uploads WHERE tenant_id = $1) AS media_uploads,
            (SELECT count(*)::int FROM audit_events WHERE tenant_id = $1) AS audit_events
        `,
        [tenantId]
      );

      await client.query(
        `
          UPDATE submission_photos photo
          SET media_upload_id = NULL
          FROM item_submissions submission,
            inventory_session_items session_item,
            inventory_sessions inventory_session
          WHERE photo.submission_id = submission.id
            AND submission.session_item_id = session_item.id
            AND session_item.session_id = inventory_session.id
            AND inventory_session.tenant_id = $1
        `,
        [tenantId]
      );
      await client.query(
        "UPDATE packet_import_batches SET media_upload_id = NULL WHERE tenant_id = $1",
        [tenantId]
      );
      await client.query(
        `
          DELETE FROM inventory_item_media reference
          USING inventory_items item
          WHERE reference.inventory_item_id = item.id
            AND item.tenant_id = $1
        `,
        [tenantId]
      );
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      const crewCleanup = await client.query(
        `
          DELETE FROM app_users user_account
          WHERE user_account.account_type = 'session_crew'
            AND NOT EXISTS (
              SELECT 1 FROM tenant_memberships membership
              WHERE membership.user_id = user_account.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM audit_events event
              WHERE event.actor_user_id = user_account.id
            )
          RETURNING user_account.id
        `
      );
      return {
        ...countsResult.rows[0],
        temporaryAccounts: crewCleanup.rowCount
      };
    });

    let storageCleanup = "complete";
    try {
      await fs.rm(storagePath, { recursive: true, force: true });
    } catch (error) {
      storageCleanup = "failed";
      console.error(JSON.stringify({
        event: "tenant_reset_storage_cleanup_failed",
        tenantId,
        tenantSlug: target.slug,
        errorCode: error?.code || null
      }));
    }

    await query(
      `
        INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (NULL, $1, 'tenant.reset', 'tenant', $2, $3::jsonb)
      `,
      [
        auth.user.id,
        tenantId,
        JSON.stringify({
          slug: target.slug,
          name: target.name,
          removed: reset,
          storageCleanup
        })
      ]
    );

    return {
      reset: {
        tenant: { id: tenantId, slug: target.slug, name: target.name },
        removed: reset,
        storageCleanup
      }
    };
  });

  route(app, "get", "/api/tenant", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    return {
      tenant: rowToTenant(context.tenant),
      membership: context.membership,
      access: context.access
    };
  });

  route(app, "get", "/api/tenant/audit-events", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const filters = tenantAuditQuerySchema.parse(request.query || {});
    const cursor = filters.cursor ? decodeTenantAuditCursor(filters.cursor) : null;
    const where = ["event.tenant_id = $1"];
    const values = [context.tenant.id];
    const addValue = value => {
      values.push(value);
      return `$${values.length}`;
    };

    if (cursor) {
      const createdAtParameter = addValue(cursor.createdAt);
      const idParameter = addValue(cursor.id);
      where.push(`(event.created_at, event.id) < (${createdAtParameter}::timestamptz, ${idParameter}::uuid)`);
    }
    if (filters.actor === "system") {
      where.push("event.actor_user_id IS NULL");
    } else if (filters.actor) {
      where.push(`event.actor_user_id = ${addValue(filters.actor)}::uuid`);
    }
    if (filters.action) where.push(`event.action = ${addValue(filters.action)}`);
    if (filters.entityType) where.push(`event.entity_type = ${addValue(filters.entityType)}`);
    if (filters.entityId) where.push(`event.entity_id = ${addValue(filters.entityId)}::uuid`);
    if (filters.from) where.push(`event.created_at >= ${addValue(filters.from)}::timestamptz`);
    if (filters.to) where.push(`event.created_at <= ${addValue(filters.to)}::timestamptz`);
    if (filters.category && filters.category !== "other") {
      const categoryPrefixes = addValue(tenantAuditCategoryPrefixes[filters.category]);
      where.push(`EXISTS (
        SELECT 1
        FROM unnest(${categoryPrefixes}::text[]) AS category_prefix(value)
        WHERE starts_with(event.action, category_prefix.value)
      )`);
    } else if (filters.category === "other") {
      const knownPrefixes = addValue(Object.values(tenantAuditCategoryPrefixes).flat());
      where.push(`NOT EXISTS (
        SELECT 1
        FROM unnest(${knownPrefixes}::text[]) AS category_prefix(value)
        WHERE starts_with(event.action, category_prefix.value)
      )`);
    }

    const limitParameter = addValue(filters.limit + 1);
    const [eventResult, optionResult, actorResult] = await Promise.all([
      query(
        `
          SELECT event.*,
            actor.email AS actor_email,
            actor.display_name AS actor_display_name,
            COALESCE(direct_session.id, item_session.id, submission_session.id, request_session.id) AS context_session_id,
            COALESCE(direct_session.name, item_session.name, submission_session.name, request_session.name) AS context_session_name,
            COALESCE(
              CASE WHEN item_session.id IS NOT NULL THEN direct_item.id END,
              CASE WHEN submission_session.id IS NOT NULL THEN submission_item.id END,
              CASE WHEN request_session.id IS NOT NULL THEN request_item.id END
            ) AS context_session_item_id,
            COALESCE(
              CASE WHEN item_session.id IS NOT NULL THEN direct_item.packet_line END,
              CASE WHEN submission_session.id IS NOT NULL THEN submission_item.packet_line END,
              CASE WHEN request_session.id IS NOT NULL THEN request_item.packet_line END
            ) AS context_packet_line
          FROM audit_events event
          LEFT JOIN app_users actor ON actor.id = event.actor_user_id
          LEFT JOIN inventory_sessions direct_session
            ON event.entity_type = 'inventory_session'
            AND direct_session.id = event.entity_id
            AND direct_session.tenant_id = event.tenant_id
          LEFT JOIN inventory_session_items direct_item
            ON event.entity_type = 'inventory_session_item'
            AND direct_item.id = event.entity_id
          LEFT JOIN inventory_sessions item_session
            ON item_session.id = direct_item.session_id
            AND item_session.tenant_id = event.tenant_id
          LEFT JOIN item_submissions event_submission
            ON event.entity_type = 'item_submission'
            AND event_submission.id = event.entity_id
          LEFT JOIN inventory_session_items submission_item
            ON submission_item.id = event_submission.session_item_id
          LEFT JOIN inventory_sessions submission_session
            ON submission_session.id = submission_item.session_id
            AND submission_session.tenant_id = event.tenant_id
          LEFT JOIN evidence_requests event_request
            ON event.entity_type = 'evidence_request'
            AND event_request.id = event.entity_id
          LEFT JOIN item_submissions request_submission
            ON request_submission.id = event_request.submission_id
          LEFT JOIN inventory_session_items request_item
            ON request_item.id = request_submission.session_item_id
          LEFT JOIN inventory_sessions request_session
            ON request_session.id = request_item.session_id
            AND request_session.tenant_id = event.tenant_id
          WHERE ${where.join("\n            AND ")}
          ORDER BY event.created_at DESC, event.id DESC
          LIMIT ${limitParameter}
        `,
        values
      ),
      query(
        `
          SELECT DISTINCT action, entity_type
          FROM audit_events
          WHERE tenant_id = $1
          ORDER BY action, entity_type
        `,
        [context.tenant.id]
      ),
      query(
        `
          SELECT DISTINCT event.actor_user_id, actor.email, actor.display_name
          FROM audit_events event
          LEFT JOIN app_users actor ON actor.id = event.actor_user_id
          WHERE event.tenant_id = $1
          ORDER BY actor.display_name NULLS LAST, actor.email NULLS LAST, event.actor_user_id NULLS LAST
        `,
        [context.tenant.id]
      )
    ]);

    const hasMore = eventResult.rows.length > filters.limit;
    const pageRows = eventResult.rows.slice(0, filters.limit);
    const actions = [...new Set(optionResult.rows.map(row => row.action))];
    const entityTypes = [...new Set(optionResult.rows.map(row => row.entity_type))];
    const actors = actorResult.rows.map(row => row.actor_user_id ? {
      id: row.actor_user_id,
      displayName: row.display_name || null,
      email: row.email || null
    } : {
      id: "system",
      displayName: "System",
      email: null
    });

    request.res.setHeader("Cache-Control", "private, no-store");
    return {
      events: pageRows.map(rowToTenantAuditEvent),
      nextCursor: hasMore && pageRows.length ? encodeTenantAuditCursor(pageRows[pageRows.length - 1]) : null,
      filterOptions: {
        categories: tenantAuditCategoryOptions,
        actors,
        actions,
        entityTypes
      }
    };
  });

  route(app, "get", "/api/tenant/settings", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const result = await query(
      `
        SELECT tenant.name,
          guidance.body AS guidance_body,
          guidance.updated_at AS guidance_updated_at,
          settings.notification_preferences,
          settings.updated_at AS settings_updated_at,
          updater.email AS updated_by_email,
          updater.display_name AS updated_by_name
        FROM tenants tenant
        LEFT JOIN tenant_guidance guidance ON guidance.tenant_id = tenant.id
        LEFT JOIN tenant_settings settings ON settings.tenant_id = tenant.id
        LEFT JOIN app_users updater ON updater.id = COALESCE(settings.updated_by, guidance.updated_by)
        WHERE tenant.id = $1
        LIMIT 1
      `,
      [context.tenant.id]
    );

    return { settings: tenantSettingsResponse(context, result.rows[0]) };
  });

  route(app, "patch", "/api/tenant/settings", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(tenantSettingsSchema, request.body);

    const saved = await withTransaction(async client => {
      await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [context.tenant.id]);
      const currentResult = await client.query(
        `
          SELECT tenant.name,
            guidance.body AS guidance_body,
            settings.notification_preferences
          FROM tenants tenant
          LEFT JOIN tenant_guidance guidance ON guidance.tenant_id = tenant.id
          LEFT JOIN tenant_settings settings ON settings.tenant_id = tenant.id
          WHERE tenant.id = $1
        `,
        [context.tenant.id]
      );
      const current = currentResult.rows[0];
      const nextPreferences = {
        ...normalizeTenantNotificationPreferences(current?.notification_preferences),
        ...(body.notificationPreferences || {}),
        alert_recipient_email: body.alertRecipientEmail !== undefined
          ? body.alertRecipientEmail.trim().toLowerCase()
          : normalizeTenantAlertRecipientEmail(current?.notification_preferences)
      };

      if (body.displayName !== undefined) {
        await client.query(
          "UPDATE tenants SET name = $1 WHERE id = $2",
          [body.displayName.trim(), context.tenant.id]
        );
      }

      if (body.defaultGuidance !== undefined) {
        await client.query(
          `
            INSERT INTO tenant_guidance (tenant_id, body, updated_by)
            VALUES ($1, $2, $3)
            ON CONFLICT (tenant_id) DO UPDATE SET
              body = EXCLUDED.body,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `,
          [context.tenant.id, body.defaultGuidance.trim(), context.user.id]
        );
      }

      await client.query(
        `
          INSERT INTO tenant_settings (tenant_id, notification_preferences, updated_by)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (tenant_id) DO UPDATE SET
            notification_preferences = EXCLUDED.notification_preferences,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
        `,
        [context.tenant.id, JSON.stringify(nextPreferences), context.user.id]
      );

      const changedFields = [
        body.displayName !== undefined ? "display_name" : "",
        body.defaultGuidance !== undefined ? "default_guidance" : "",
        body.alertRecipientEmail !== undefined ? "alert_recipient_email" : "",
        body.notificationPreferences !== undefined ? "notification_preferences" : ""
      ].filter(Boolean);
      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "tenant.settings_updated",
        entityType: "tenant",
        entityId: context.tenant.id,
        metadata: { changedFields }
      });

      const savedResult = await client.query(
        `
          SELECT tenant.name,
            guidance.body AS guidance_body,
            guidance.updated_at AS guidance_updated_at,
            settings.notification_preferences,
            settings.updated_at AS settings_updated_at,
            updater.email AS updated_by_email,
            updater.display_name AS updated_by_name
          FROM tenants tenant
          LEFT JOIN tenant_guidance guidance ON guidance.tenant_id = tenant.id
          LEFT JOIN tenant_settings settings ON settings.tenant_id = tenant.id
          LEFT JOIN app_users updater ON updater.id = settings.updated_by
          WHERE tenant.id = $1
          LIMIT 1
        `,
        [context.tenant.id]
      );
      return savedResult.rows[0];
    });

    context.tenant.name = saved.name;
    return { settings: tenantSettingsResponse(context, saved) };
  });

  route(app, "get", "/api/tenant/guidance", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    const result = await query(
      `
        SELECT g.body,
          g.updated_at,
          updater.email AS updated_by_email,
          updater.display_name AS updated_by_name
        FROM tenant_guidance g
        LEFT JOIN app_users updater ON updater.id = g.updated_by
        WHERE g.tenant_id = $1
        LIMIT 1
      `,
      [context.tenant.id]
    );

    return { guidance: rowToTenantGuidance(result.rows[0]) };
  });

  route(app, "patch", "/api/tenant/guidance", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(tenantGuidanceSchema, request.body);
    const guidanceBody = String(body.body || "").trim();

    const guidance = await withTransaction(async client => {
      const result = await client.query(
        `
          INSERT INTO tenant_guidance (tenant_id, body, updated_by)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id) DO UPDATE SET
            body = EXCLUDED.body,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING body, updated_at
        `,
        [context.tenant.id, guidanceBody, context.user.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "tenant_guidance.updated",
        entityType: "tenant_guidance",
        entityId: context.tenant.id,
        metadata: { length: guidanceBody.length }
      });

      return result.rows[0];
    });

    return {
      guidance: rowToTenantGuidance({
        ...guidance,
        updated_by_email: context.user.email,
        updated_by_name: context.user.display_name
      })
    };
  });

  route(app, "get", "/api/tenant/notifications", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor", "viewer"],
      { allowCrew: true }
    );
    const notifications = [];
    const isTenantAdmin = hasTenantRole(context, ["tenant_admin"]);
    const preferences = await getTenantNotificationPreferences(context.tenant.id);

    if (isTenantAdmin) {
      const pendingProofResult = await query(
        `
          WITH latest_pending AS (
            SELECT sub.id,
              sub.created_at,
              submitter.email AS submitted_by_email,
              submitter.display_name AS submitted_by_name,
              si.id AS session_item_id,
              si.packet_line,
              s.id AS session_id,
              s.name AS session_name,
              row_number() OVER (PARTITION BY si.id ORDER BY sub.created_at DESC) AS queue_rank
            FROM item_submissions sub
            JOIN inventory_session_items si ON si.id = sub.session_item_id
            JOIN inventory_sessions s ON s.id = si.session_id
            JOIN app_users submitter ON submitter.id = sub.submitted_by
            WHERE s.tenant_id = $1
              AND s.status <> 'closed'
              AND sub.review_state = 'pending'
          )
          SELECT *
          FROM latest_pending
          WHERE queue_rank = 1
          ORDER BY created_at DESC
          LIMIT 6
        `,
        [context.tenant.id]
      );

      pendingProofResult.rows.forEach(row => {
        const submitterName = displayNameFor({
          display_name: row.submitted_by_name,
          email: row.submitted_by_email
        }) || "Someone";

        notifications.push({
          id: `proof:${row.id}`,
          type: "proof_submitted",
          priority: "high",
          title: "Proof waiting",
          body: `${submitterName} submitted ${compactText(row.packet_line || "a packet row", 68)}`,
          createdAt: row.created_at,
          tenantSlug: context.tenant.slug,
          sessionId: row.session_id,
          sessionName: row.session_name,
          sessionItemId: row.session_item_id,
          submissionId: row.id,
          action: notificationAction({
            label: "Review proof",
            tab: "review",
            sessionId: row.session_id,
            sessionItemId: row.session_item_id,
            submissionId: row.id
          })
        });
      });

      const withdrawnProofResult = await query(
        `
          SELECT sub.id,
            sub.withdrawn_at AS created_at,
            submitter.email AS submitted_by_email,
            submitter.display_name AS submitted_by_name,
            si.id AS session_item_id,
            si.packet_line,
            s.id AS session_id,
            s.name AS session_name
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          JOIN app_users submitter ON submitter.id = sub.submitted_by
          WHERE s.tenant_id = $1
            AND sub.review_state = 'withdrawn'
            AND sub.withdrawn_at IS NOT NULL
          ORDER BY sub.withdrawn_at DESC
          LIMIT 5
        `,
        [context.tenant.id]
      );

      withdrawnProofResult.rows.forEach(row => {
        const submitterName = displayNameFor({
          display_name: row.submitted_by_name,
          email: row.submitted_by_email
        }) || "The submitter";
        notifications.push({
          id: `proof-withdrawn:${row.id}`,
          type: "proof_withdrawn",
          priority: "medium",
          title: "Proof withdrawn before review",
          body: `${submitterName} withdrew ${compactText(row.packet_line || "a packet row", 68)}. The evidence remains in history.`,
          createdAt: row.created_at,
          tenantSlug: context.tenant.slug,
          sessionId: row.session_id,
          sessionName: row.session_name,
          sessionItemId: row.session_item_id,
          submissionId: row.id,
          action: notificationAction({
            label: "Open session",
            tab: "tasks",
            sessionId: row.session_id,
            sessionItemId: row.session_item_id,
            submissionId: row.id
          })
        });
      });
    }

    const proofRequestResult = await query(
      `
        SELECT sub.id,
          COALESCE(sub.reviewed_at, sub.created_at) AS created_at,
          sub.review_note,
          reviewer.email AS reviewed_by_email,
          reviewer.display_name AS reviewed_by_name,
          si.id AS session_item_id,
          si.packet_line,
          s.id AS session_id,
          s.name AS session_name
        FROM item_submissions sub
        JOIN inventory_session_items si ON si.id = sub.session_item_id
        JOIN inventory_sessions s ON s.id = si.session_id
        LEFT JOIN app_users reviewer ON reviewer.id = sub.reviewed_by
        WHERE s.tenant_id = $1
          AND s.status <> 'closed'
          AND sub.submitted_by = $2
          AND ($3::uuid IS NULL OR s.id = $3)
          AND sub.review_state = 'request_more_info'
          AND NOT EXISTS (
            SELECT 1
            FROM item_submissions newer
            WHERE newer.session_item_id = sub.session_item_id
              AND (
                newer.created_at > sub.created_at
                OR (newer.created_at = sub.created_at AND newer.id > sub.id)
              )
          )
        ORDER BY COALESCE(sub.reviewed_at, sub.created_at) DESC
        LIMIT 5
      `,
      [context.tenant.id, context.user.id, context.crew?.sessionId || null]
    );

    proofRequestResult.rows.forEach(row => {
      const reviewerName = displayNameFor({
        display_name: row.reviewed_by_name,
        email: row.reviewed_by_email
      });

      notifications.push({
        id: `proof-request:${row.id}`,
        type: "proof_request",
        priority: "high",
        title: "More proof requested",
        body: compactText(row.review_note || `${reviewerName || "A platoon admin"} asked for more detail on ${row.packet_line || "a packet row"}`, 112),
        createdAt: row.created_at,
        tenantSlug: context.tenant.slug,
        sessionId: row.session_id,
        sessionName: row.session_name,
        sessionItemId: row.session_item_id,
        submissionId: row.id,
        action: notificationAction({
          label: "Open session",
          tab: "tasks",
          sessionId: row.session_id,
          sessionItemId: row.session_item_id,
          submissionId: row.id
        })
      });
    });

    const rejectedProofResult = await query(
      `
        SELECT sub.id,
          COALESCE(sub.reviewed_at, sub.created_at) AS created_at,
          sub.review_note,
          sub.review_return_route,
          reviewer.email AS reviewed_by_email,
          reviewer.display_name AS reviewed_by_name,
          si.id AS session_item_id,
          si.packet_line,
          s.id AS session_id,
          s.name AS session_name
        FROM item_submissions sub
        JOIN inventory_session_items si ON si.id = sub.session_item_id
        JOIN inventory_sessions s ON s.id = si.session_id
        LEFT JOIN app_users reviewer ON reviewer.id = sub.reviewed_by
        WHERE s.tenant_id = $1
          AND s.status <> 'closed'
          AND sub.submitted_by = $2
          AND ($3::uuid IS NULL OR s.id = $3)
          AND sub.review_state = 'rejected'
          AND si.status NOT IN ('found', 'not_found', 'mismatch', 'approved', 'needs_review')
          AND NOT EXISTS (
            SELECT 1
            FROM item_submissions newer
            WHERE newer.session_item_id = sub.session_item_id
              AND (
                newer.created_at > sub.created_at
                OR (newer.created_at = sub.created_at AND newer.id > sub.id)
              )
          )
        ORDER BY COALESCE(sub.reviewed_at, sub.created_at) DESC
        LIMIT 5
      `,
      [context.tenant.id, context.user.id, context.crew?.sessionId || null]
    );

    rejectedProofResult.rows.forEach(row => {
      const routingText = row.review_return_route === "submitter"
        ? "The row is still assigned to you."
        : "The row was returned to the unclaimed queue.";
      notifications.push({
        id: `proof-rejected:${row.id}`,
        type: "proof_rejected",
        priority: "high",
        title: "Proof rejected",
        body: compactText(`${row.review_note || "The proof was not accepted."} ${routingText}`, 112),
        createdAt: row.created_at,
        tenantSlug: context.tenant.slug,
        sessionId: row.session_id,
        sessionName: row.session_name,
        sessionItemId: row.session_item_id,
        submissionId: row.id,
        action: notificationAction({
          label: row.review_return_route === "submitter" ? "Open returned row" : "Open session",
          tab: "tasks",
          sessionId: row.session_id,
          sessionItemId: row.session_item_id,
          submissionId: row.id
        })
      });
    });

    const uncheckedResult = await query(
      `
        SELECT s.id AS session_id,
          s.name AS session_name,
          count(si.id)::int AS unchecked_count,
          max(si.updated_at) AS updated_at
        FROM inventory_sessions s
        JOIN inventory_session_items si ON si.session_id = s.id
        WHERE s.tenant_id = $1
          AND s.status = 'active'
          AND ($2::uuid IS NULL OR s.id = $2)
          AND si.status = 'unchecked'
        GROUP BY s.id, s.name
        HAVING count(si.id) > 0
        ORDER BY unchecked_count DESC, updated_at DESC
        LIMIT 3
      `,
      [context.tenant.id, context.crew?.sessionId || null]
    );

    uncheckedResult.rows.forEach(row => {
      const count = Number(row.unchecked_count || 0);
      notifications.push({
        id: `unchecked:${row.session_id}`,
        type: "assignment",
        priority: count > 0 ? "medium" : "low",
        title: isTenantAdmin ? "Rows need tasking" : "Rows need attention",
        body: `${count} unchecked ${count === 1 ? "row" : "rows"} in ${row.session_name}`,
        createdAt: row.updated_at,
        tenantSlug: context.tenant.slug,
        sessionId: row.session_id,
        sessionName: row.session_name,
        sessionItemId: null,
        submissionId: null,
        action: notificationAction({
          label: "Open session",
          tab: "tasks",
          sessionId: row.session_id
        })
      });
    });

    const closedSessionResult = await query(
      `
        SELECT id, name, closed_at
        FROM inventory_sessions
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR id = $2)
          AND status = 'closed'
          AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 2
      `,
      [context.tenant.id, context.crew?.sessionId || null]
    );

    closedSessionResult.rows.forEach(row => {
      notifications.push({
        id: `session-closed:${row.id}`,
        type: "session_closed",
        priority: "low",
        title: "Session closed",
        body: `${row.name} is closed and ready for records.`,
        createdAt: row.closed_at,
        tenantSlug: context.tenant.slug,
        sessionId: row.id,
        sessionName: row.name,
        sessionItemId: null,
        submissionId: null,
        action: notificationAction({
          label: "Open sessions",
          tab: "tasks",
          sessionId: row.id
        })
      });
    });

    if (isTenantAdmin) {
      const importTableResult = await query("SELECT to_regclass('public.packet_import_batches') AS table_name");
      if (importTableResult.rows[0]?.table_name) {
        const importResult = await query(
          `
            SELECT b.id,
              b.source_name,
              b.row_count,
              b.created_at,
              s.id AS session_id,
              s.name AS session_name
            FROM packet_import_batches b
            JOIN inventory_sessions s ON s.id = b.session_id
            WHERE b.tenant_id = $1
            ORDER BY b.created_at DESC
            LIMIT 3
          `,
          [context.tenant.id]
        );

        importResult.rows.forEach(row => {
          const rowCount = Number(row.row_count || 0);
          notifications.push({
            id: `packet-import:${row.id}`,
            type: "packet_import",
            priority: "low",
            title: "Packet import complete",
            body: `${rowCount} ${rowCount === 1 ? "row" : "rows"} imported into ${row.session_name}`,
            createdAt: row.created_at,
            tenantSlug: context.tenant.slug,
            sessionId: row.session_id,
            sessionName: row.session_name,
            sessionItemId: null,
            submissionId: null,
            action: notificationAction({
              label: "Open session",
              tab: "tasks",
              sessionId: row.session_id
            })
          });
        });
      }
    }

    const priorityRank = { high: 0, medium: 1, low: 2 };
    const preferenceForType = {
      proof_submitted: "proof_submitted",
      proof_request: "proof_requests",
      proof_rejected: "proof_requests",
      proof_withdrawn: "proof_submitted",
      assignment: "open_rows",
      packet_import: "packet_imports",
      session_closed: "session_closed"
    };
    const sortedNotifications = notifications
      .filter(notification => notification.createdAt)
      .filter(notification => preferences[preferenceForType[notification.type]] !== false)
      .sort((left, right) => {
        const leftPriority = priorityRank[left.priority] ?? 9;
        const rightPriority = priorityRank[right.priority] ?? 9;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      })
      .slice(0, 10);

    return {
      notifications: sortedNotifications,
      unreadCount: sortedNotifications.filter(notification => notification.priority === "high").length,
      persisted: false,
      generatedAt: new Date().toISOString()
    };
  });

  route(app, "get", "/api/tenant/members", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const result = await query(
      `
        SELECT m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
          u.email, u.display_name, u.account_type, u.authentik_subject,
          p.id AS provisioning_job_id,
          p.status AS provisioning_status,
          p.current_step AS provisioning_step,
          p.desired_role AS provisioning_desired_role,
          p.desired_state AS provisioning_desired_state,
          p.next_attempt_at AS provisioning_next_attempt_at,
          p.completed_at AS provisioning_completed_at,
          p.last_error_code AS provisioning_error_code,
          p.enrollment_required AS provisioning_enrollment_required,
          p.enrollment_sent_at AS provisioning_enrollment_sent_at
        FROM tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
        LEFT JOIN authentik_provisioning_jobs p ON p.tenant_membership_id = m.id
        WHERE m.tenant_id = $1
        ORDER BY
          CASE m.role
            WHEN 'tenant_admin' THEN 1
            WHEN 'contributor' THEN 2
            ELSE 3
          END,
          u.email ASC
      `,
      [context.tenant.id]
    );

    return {
      members: result.rows.map(rowToMember),
      provisioningAvailable: provisioningAvailable()
    };
  });

  route(app, "post", "/api/tenant/members/identity-check", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        email: z.string().trim().email().max(254).transform(value => value.toLowerCase())
      }).strict(),
      request.body
    );
    const inspection = await inspectPermanentIdentityEmail(body.email);
    const candidateCount = inspection.entries.length;
    return {
      status: candidateCount > 1 ? "ambiguous" : candidateCount === 1 ? "existing" : "new",
      candidateCount,
      candidates: context.identity.isPlatformAdmin
        ? inspection.entries.map(entry => entry.safe)
        : []
    };
  });

  route(app, "post", "/api/tenant/members", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    requirePermanentProvisioning();
    const body = parseBody(
      z.object({
        email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
        displayName: z.string().trim().min(2).max(120).optional(),
        role: z.enum(tenantRoles).default("contributor"),
        authentikUserUuid: z.string().uuid().optional()
      }).strict(),
      request.body
    );
    const existingMembership = await query(
      `
        SELECT m.id
        FROM tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
          AND lower(u.email) = $2
        LIMIT 1
      `,
      [context.tenant.id, body.email]
    );
    if (existingMembership.rows[0]) {
      throw permanentAccountError(
        "This teammate already has access or a pending invitation. Use Manage to update it.",
        409,
        "member_exists"
      );
    }
    const identityInspection = await inspectPermanentIdentityEmail(body.email);
    const selectedIdentity = choosePermanentIdentity(
      identityInspection,
      body.authentikUserUuid,
      { isPlatformAdmin: context.identity.isPlatformAdmin }
    );

    const member = await withTransaction(async client => {
      const user = await findOrCreatePermanentUser(client, {
        email: body.email,
        displayName: body.displayName || null
      });
      if (selectedIdentity) {
        await bindPermanentUserIdentity(client, user.id, selectedIdentity);
      }
      const legacyInvitations = await client.query(
        `
          SELECT id
          FROM tenant_invitations
          WHERE tenant_id = $1
            AND lower(email) = $2
            AND status IN ('pending', 'expired')
          ORDER BY id
          FOR UPDATE
        `,
        [context.tenant.id, body.email]
      );

      const memberResult = await client.query(
        `
          WITH adopted AS (
            UPDATE tenant_memberships existing
            SET role = $3,
              status = 'invited',
              invited_by = $4
            WHERE existing.tenant_id = $1
              AND existing.user_id = $2
              AND existing.status = 'invited'
              AND NOT EXISTS (
                SELECT 1
                FROM authentik_provisioning_jobs job
                WHERE job.tenant_membership_id = existing.id
              )
            RETURNING existing.id, existing.tenant_id, existing.user_id,
              existing.role, existing.status, existing.created_at,
              true AS adopted_legacy_invitation
          ), inserted AS (
            INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
            SELECT $1, $2, $3, 'invited', $4
            WHERE NOT EXISTS (SELECT 1 FROM adopted)
            ON CONFLICT (tenant_id, user_id) DO NOTHING
            RETURNING id, tenant_id, user_id, role, status, created_at,
              false AS adopted_legacy_invitation
          )
          SELECT * FROM adopted
          UNION ALL
          SELECT * FROM inserted
        `,
        [context.tenant.id, user.id, body.role, context.user.id]
      );
      if (!memberResult.rows[0]) {
        throw permanentAccountError(
          "This teammate already has access. Use Manage to change it.",
          409,
          "member_exists"
        );
      }

      if (memberResult.rows[0].adopted_legacy_invitation) {
        await client.query(
          `
            UPDATE tenant_invitations
            SET status = 'revoked', revoked_at = now()
            WHERE id = ANY($1::uuid[])
          `,
          [legacyInvitations.rows.map(invitation => invitation.id)]
        );
      }

      await enqueueMembershipProvisioning(client, {
        membershipId: memberResult.rows[0].id,
        desiredRole: body.role,
        desiredState: "active",
        requestedBy: context.user.id
      });

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.provisioning_requested",
        entityType: "tenant_membership",
        entityId: memberResult.rows[0].id,
        metadata: {
          email: body.email,
          displayName: user.display_name || null,
          role: body.role,
          status: memberResult.rows[0].status,
          linkedExistingIdentity: Boolean(selectedIdentity),
          adoptedLegacyInvitation: memberResult.rows[0].adopted_legacy_invitation === true
        }
      });

      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberResult.rows[0].id
      );
    });

    startProvisioningWork();
    reply.code(202);
    return { member: rowToMember(member) };
  });

  route(app, "get", "/api/tenant/members/:memberId/identity-candidates", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    if (!context.identity.isPlatformAdmin) {
      throw permanentAccountError(
        "A platform administrator must resolve duplicate sign-in accounts.",
        403,
        "identity_resolution_forbidden"
      );
    }
    const memberId = z.string().uuid().parse(request.params.memberId);
    const current = await findMemberWithProvisioning(query, context.tenant.id, memberId);
    if (!current) {
      reply.code(404);
      throw new Error("Member not found");
    }
    assertPermanentAccount(current);
    if (current.provisioning_error_code !== "identity_ambiguous") {
      throw permanentAccountError(
        "This teammate does not have a duplicate-account issue to resolve.",
        409,
        "identity_resolution_not_needed"
      );
    }
    const inspection = await inspectPermanentIdentityEmail(current.email);
    return {
      member: rowToMember(current),
      candidates: inspection.entries.map(entry => entry.safe)
    };
  });

  route(app, "post", "/api/tenant/members/:memberId/resolve-identity", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    if (!context.identity.isPlatformAdmin) {
      throw permanentAccountError(
        "A platform administrator must resolve duplicate sign-in accounts.",
        403,
        "identity_resolution_forbidden"
      );
    }
    requirePermanentProvisioning();
    const memberId = z.string().uuid().parse(request.params.memberId);
    const body = parseBody(
      z.object({ authentikUserUuid: z.string().uuid() }).strict(),
      request.body
    );
    const initial = await findMemberWithProvisioning(query, context.tenant.id, memberId);
    if (!initial) {
      reply.code(404);
      throw new Error("Member not found");
    }
    const inspection = await inspectPermanentIdentityEmail(initial.email);
    const selectedIdentity = choosePermanentIdentity(
      inspection,
      body.authentikUserUuid,
      { isPlatformAdmin: true }
    );

    const member = await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId,
        { forUpdate: true }
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);
      if (
        current.status !== "invited"
        || String(current.email || "").trim().toLowerCase() !== inspection.normalizedEmail
        || current.authentik_subject
        || current.authentik_user_pk
        || current.authentik_user_uuid
        || current.provisioning_status !== "failed"
        || current.provisioning_error_code !== "identity_ambiguous"
      ) {
        throw permanentAccountError(
          "This invitation changed while it was being resolved. Refresh the team list and try again.",
          409,
          "identity_resolution_stale"
        );
      }

      await bindPermanentUserIdentity(client, current.user_id, selectedIdentity);
      const job = await retryMembershipProvisioning(memberId, context.user.id, {
        tenantId: context.tenant.id,
        client
      });
      if (!job) {
        throw permanentAccountError(
          "Account setup could not be restarted. Refresh the team list and try again.",
          409,
          "identity_resolution_stale"
        );
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.identity_resolved",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: {
          email: current.email,
          role: current.role,
          selectedUsername: selectedIdentity.safe.username
        }
      });
      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId
      );
    });

    startProvisioningWork();
    reply.code(202);
    return { member: rowToMember(member) };
  });

  route(app, "delete", "/api/tenant/members/:memberId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const memberId = z.string().uuid().parse(request.params.memberId);
    await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId,
        { forUpdate: true }
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);
      const canCancel = current.status === "invited"
        && !current.authentik_subject
        && !current.authentik_user_pk
        && !current.authentik_user_uuid
        && current.provisioning_status === "failed"
        && current.provisioning_step === "identity";
      if (!canCancel) {
        throw permanentAccountError(
          "This invitation can no longer be canceled safely. Disable access instead.",
          409,
          "member_cancel_unavailable"
        );
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.invitation_canceled",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: { email: current.email, role: current.role }
      });
      await client.query(
        "DELETE FROM tenant_memberships WHERE tenant_id = $1 AND id = $2",
        [context.tenant.id, memberId]
      );
    });
    return { removed: true };
  });

  route(app, "patch", "/api/tenant/members/:memberId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const memberId = z.string().uuid().parse(request.params.memberId);
    const body = parseBody(
      z.object({
        role: z.enum(tenantRoles).optional(),
        status: z.enum(["active", "disabled"]).optional()
      }).refine(value => value.role || value.status, {
        message: "Provide a role or status change"
      }),
      request.body
    );
    if (body.status === "active") requirePermanentProvisioning();

    const member = await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId,
        { forUpdate: true }
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);

      const nextRole = body.role || current.role;
      const transition = permanentMemberTransition(current.status, body.status);
      if (nextRole !== "tenant_admin" || transition.membershipStatus !== "active") {
        await assertMemberCanLoseAdminRole(client, reply, context.tenant.id, current);
      }

      const updateResult = await client.query(
        `
          UPDATE tenant_memberships m
          SET role = $3, status = $4
          FROM app_users u
          WHERE m.tenant_id = $1
            AND m.id = $2
            AND u.id = m.user_id
          RETURNING m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
            u.email, u.display_name
        `,
        [context.tenant.id, memberId, nextRole, transition.membershipStatus]
      );

      await enqueueMembershipProvisioning(client, {
        membershipId: memberId,
        desiredRole: nextRole,
        desiredState: transition.desiredState,
        requestedBy: context.user.id
      });

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.updated",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: {
          email: current.email,
          previousRole: current.role,
          previousStatus: current.status,
          role: nextRole,
          status: transition.membershipStatus
        }
      });

      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        updateResult.rows[0].id
      );
    });

    startProvisioningWork();
    return { member: rowToMember(member) };
  });

  route(app, "post", "/api/tenant/members/:memberId/disable", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const memberId = z.string().uuid().parse(request.params.memberId);

    const member = await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId,
        { forUpdate: true }
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);

      await assertMemberCanLoseAdminRole(client, reply, context.tenant.id, current);

      const updateResult = await client.query(
        `
          UPDATE tenant_memberships m
          SET status = 'disabled'
          FROM app_users u
          WHERE m.tenant_id = $1
            AND m.id = $2
            AND u.id = m.user_id
          RETURNING m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
            u.email, u.display_name
        `,
        [context.tenant.id, memberId]
      );

      await enqueueMembershipProvisioning(client, {
        membershipId: memberId,
        desiredRole: current.role,
        desiredState: "disabled",
        requestedBy: context.user.id
      });

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.disabled",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: { email: current.email, role: current.role, previousStatus: current.status }
      });

      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        updateResult.rows[0].id
      );
    });

    startProvisioningWork();
    return { member: rowToMember(member) };
  });

  route(app, "post", "/api/tenant/members/:memberId/retry", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    requirePermanentProvisioning();
    const memberId = z.string().uuid().parse(request.params.memberId);
    const member = await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);

      const job = await retryMembershipProvisioning(memberId, context.user.id, {
        tenantId: context.tenant.id,
        client
      });
      if (!job) {
        reply.code(404);
        throw new Error("Account setup request not found");
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.provisioning_retried",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: {
          email: current.email,
          displayName: current.display_name || null,
          role: current.role,
          status: current.status,
          acknowledgedUnknownEnrollment: job.acknowledgedUnknownEnrollment === true
        }
      });
      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId
      );
    });
    startProvisioningWork();
    reply.code(202);
    return { member: rowToMember(member) };
  });

  route(app, "post", "/api/tenant/members/:memberId/resend-enrollment", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    requirePermanentProvisioning();
    const memberId = z.string().uuid().parse(request.params.memberId);
    const member = await withTransaction(async client => {
      const current = await findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId
      );
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }
      assertPermanentAccount(current);

      const job = await requestEnrollmentResend(memberId, context.user.id, {
        tenantId: context.tenant.id,
        client
      });
      if (!job) {
        reply.code(404);
        throw new Error("Account setup request not found");
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.enrollment_resend_requested",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: { email: current.email, displayName: current.display_name || null, role: current.role, status: current.status }
      });
      return findMemberWithProvisioning(
        (text, params) => client.query(text, params),
        context.tenant.id,
        memberId
      );
    });
    startProvisioningWork();
    reply.code(202);
    return { member: rowToMember(member) };
  });

  route(app, "get", "/api/tenant/invitations", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    await expirePendingInvitations(query, context.tenant.id);
    const result = await query(
      `
        SELECT *
        FROM tenant_invitations
        WHERE tenant_id = $1
        ORDER BY created_at DESC
      `,
      [context.tenant.id]
    );

    return { invitations: result.rows.map(rowToInvitation) };
  });

  route(app, "post", "/api/tenant/invitations", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        email: z.string().email().max(254),
        displayName: z.string().optional(),
        role: z.enum(tenantRoles).default("contributor"),
        expiresInDays: z.number().int().min(1).max(60).default(14)
      }),
      request.body
    );

    const token = createInviteToken();
    const tokenHash = hashInviteToken(token);
    const email = body.email.toLowerCase();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const invite = await withTransaction(async client => {
      const user = await findOrCreatePermanentUser(client, {
        email,
        displayName: body.displayName || null
      });

      const membershipResult = await client.query(
        `
          INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
          VALUES ($1, $2, $3, 'invited', $4)
          ON CONFLICT (tenant_id, user_id) DO NOTHING
          RETURNING id
        `,
        [context.tenant.id, user.id, body.role, context.user.id]
      );
      if (!membershipResult.rows[0]) {
        throw permanentAccountError(
          "This teammate already has access. Use Manage to change it.",
          409,
          "member_exists"
        );
      }

      const inviteResult = await client.query(
        `
          INSERT INTO tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [context.tenant.id, email, body.role, tokenHash, context.user.id, expiresAt]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "invitation.created",
        entityType: "tenant_invitation",
        entityId: inviteResult.rows[0].id,
        metadata: { email, role: body.role }
      });

      return inviteResult.rows[0];
    });

    const inviteUrl = buildInviteUrl(context.tenant, token);
    const emailResult = await sendInviteNotification({
      context,
      email,
      role: body.role,
      inviteUrl
    });

    reply.code(201);
    return {
      invitation: {
        ...rowToInvitation(invite),
        inviteUrl
      },
      email: emailResult
    };
  });

  route(app, "post", "/api/tenant/invitations/:invitationId/resend", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        sendEmail: z.boolean().default(true),
        expiresInDays: z.number().int().min(1).max(60).default(14)
      }),
      request.body
    );

    const token = createInviteToken();
    const tokenHash = hashInviteToken(token);
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const invite = await withTransaction(async client => {
      await expirePendingInvitations(client, context.tenant.id);

      const result = await client.query(
        `
          UPDATE tenant_invitations
          SET token_hash = $3,
            status = 'pending',
            expires_at = $4,
            accepted_at = NULL,
            revoked_at = NULL
          WHERE id = $1
            AND tenant_id = $2
            AND status IN ('pending', 'expired')
          RETURNING *
        `,
        [request.params.invitationId, context.tenant.id, tokenHash, expiresAt]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: body.sendEmail ? "invitation.resent" : "invitation.link_refreshed",
        entityType: "tenant_invitation",
        entityId: result.rows[0].id,
        metadata: {
          email: result.rows[0].email,
          role: result.rows[0].role,
          expiresAt: result.rows[0].expires_at
        }
      });

      return result.rows[0];
    });

    if (!invite) {
      reply.code(404);
      throw new Error("Pending or expired invitation not found");
    }

    const inviteUrl = buildInviteUrl(context.tenant, token);
    const emailResult = body.sendEmail
      ? await sendInviteNotification({
        context,
        email: invite.email,
        role: invite.role,
        inviteUrl
      })
      : { sent: false, reason: "not_requested" };

    return {
      invitation: {
        ...rowToInvitation(invite),
        inviteUrl
      },
      email: emailResult
    };
  });

  route(app, "post", "/api/tenant/invitations/:invitationId/revoke", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const revoked = await withTransaction(async client => {
      await expirePendingInvitations(client, context.tenant.id);

      const result = await client.query(
        `
          UPDATE tenant_invitations
          SET status = 'revoked', revoked_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status IN ('pending', 'expired')
          RETURNING *
        `,
        [request.params.invitationId, context.tenant.id]
      );

      if (!result.rows[0]) return null;

      await client.query(
        `
          UPDATE tenant_memberships m
          SET status = 'disabled'
          FROM app_users u
          WHERE m.user_id = u.id
            AND m.tenant_id = $1
            AND lower(u.email) = $2
            AND m.status = 'invited'
        `,
        [context.tenant.id, result.rows[0].email]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "invitation.revoked",
        entityType: "tenant_invitation",
        entityId: result.rows[0].id,
        metadata: { email: result.rows[0].email, role: result.rows[0].role }
      });

      return result.rows[0];
    });

    if (!revoked) {
      reply.code(404);
      throw new Error("Pending or expired invitation not found");
    }

    return { invitation: rowToInvitation(revoked) };
  });

  route(app, "get", "/api/invitations/:token", async (request, reply) => {
    const tokenHash = hashInviteToken(request.params.token);
    const result = await query(
      `
        SELECT i.*, t.slug, t.name AS tenant_name, t.status AS tenant_status
        FROM tenant_invitations i
        JOIN tenants t ON t.id = i.tenant_id
        WHERE i.token_hash = $1
        LIMIT 1
      `,
      [tokenHash]
    );

    const invite = result.rows[0];
    if (!invite || invite.status !== "pending" || new Date(invite.expires_at).getTime() <= Date.now()) {
      reply.code(404);
      throw new Error("Invitation not found or expired");
    }

    return {
      invitation: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expires_at,
        tenant: {
          id: invite.tenant_id,
          slug: invite.slug,
          name: invite.tenant_name,
          status: invite.tenant_status
        }
      }
    };
  });

  route(app, "post", "/api/invitations/accept", async (request, reply) => {
    const auth = await authContext(request, reply);
    const body = parseBody(
      z.object({
        token: z.string().min(20)
      }),
      request.body
    );
    const tokenHash = hashInviteToken(body.token);

    const accepted = await withTransaction(async client => {
      const inviteResult = await client.query(
        `
          SELECT *
          FROM tenant_invitations
          WHERE token_hash = $1
          LIMIT 1
          FOR UPDATE
        `,
        [tokenHash]
      );
      const invite = inviteResult.rows[0];

      if (!invite || invite.status !== "pending" || new Date(invite.expires_at).getTime() <= Date.now()) {
        return null;
      }

      if (!invitationEmailMatches(invite.email, auth.user.email)) {
        return { forbidden: true };
      }

      const currentMembership = await client.query(
        `
          SELECT id, tenant_id, user_id, role, status, created_at
          FROM tenant_memberships
          WHERE tenant_id = $1 AND user_id = $2
          FOR UPDATE
        `,
        [invite.tenant_id, auth.user.id]
      );
      if (currentMembership.rows[0]?.status === "disabled") {
        return { forbidden: true };
      }

      const membershipResult = currentMembership.rows[0]?.status === "active"
        ? currentMembership
        : await client.query(
          `
            INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
            VALUES ($1, $2, $3, 'active', $4)
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET
              role = EXCLUDED.role,
              status = 'active',
              invited_by = EXCLUDED.invited_by
            WHERE tenant_memberships.status = 'invited'
            RETURNING id, tenant_id, user_id, role, status, created_at
          `,
          [invite.tenant_id, auth.user.id, invite.role, invite.invited_by]
        );
      if (!membershipResult.rows[0]) {
        return { forbidden: true };
      }

      const updatedInvite = await client.query(
        `
          UPDATE tenant_invitations
          SET status = 'accepted', accepted_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [invite.id]
      );

      await createAuditEvent(client, {
        tenantId: invite.tenant_id,
        actorUserId: auth.user.id,
        action: "invitation.accepted",
        entityType: "tenant_invitation",
        entityId: invite.id,
        metadata: { email: invite.email, role: invite.role }
      });

      return {
        invitation: updatedInvite.rows[0],
        membership: {
          ...membershipResult.rows[0],
          email: auth.user.email,
          display_name: auth.user.display_name,
          account_type: "authentik",
          authentik_subject: auth.user.authentik_subject
        }
      };
    });

    if (!accepted) {
      reply.code(404);
      throw new Error("Invitation not found or expired");
    }

    if (accepted.forbidden) {
      reply.code(403);
      throw new Error("Invitation belongs to a different email address");
    }

    return {
      invitation: rowToInvitation(accepted.invitation),
      membership: rowToMember(accepted.membership)
    };
  });

  route(app, "get", "/api/inventory/items", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const result = await query(
      `
        SELECT *
        FROM inventory_items
        WHERE tenant_id = $1
        ORDER BY title ASC
      `,
      [context.tenant.id]
    );
    const mediaByItemId = await loadInventoryItemMedia(result.rows.map(row => row.id));

    return {
      items: result.rows.map(row => rowToInventoryItem(row, mediaByItemId.get(row.id) || []))
    };
  });

  route(app, "get", "/api/inventory/reports", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const [sessionResult, rowResult] = await Promise.all([
      query(
        `
          SELECT session.*,
            COUNT(item.id)::int AS item_count,
            COUNT(item.id) FILTER (WHERE item.status IN ('found', 'not_found', 'mismatch', 'approved'))::int AS found_count,
            COUNT(item.id) FILTER (WHERE item.status = 'needs_review')::int AS needs_review_count,
            MAX(item.updated_at) AS last_item_updated_at
          FROM inventory_sessions session
          LEFT JOIN inventory_session_items item ON item.session_id = session.id
          WHERE session.tenant_id = $1
          GROUP BY session.id
          ORDER BY session.created_at DESC
        `,
        [context.tenant.id]
      ),
      query(
        `
          SELECT item.id,
            item.session_id,
            item.inventory_item_id,
            item.packet_line,
            item.expected_qty,
            item.location_hint,
            item.status AS item_status,
            item.assigned_to,
            item.direct_verified_by,
            item.created_at,
            item.updated_at,
            session.name AS session_name,
            session.status AS session_status,
            session.created_at AS session_created_at,
            session.started_at AS session_started_at,
            session.closed_at AS session_closed_at,
            inventory.title AS item_title,
            inventory.common_name,
            inventory.army_name,
            inventory.lin,
            inventory.nsn,
            inventory.description,
            inventory.current_location,
            inventory.metadata AS item_metadata,
            assignee.email AS assigned_to_email,
            assignee.display_name AS assigned_to_name,
            direct_verifier.email AS direct_verified_by_email,
            direct_verifier.display_name AS direct_verified_by_name,
            latest.id AS latest_submission_id,
            latest.submitted_by AS latest_submitted_by,
            latest.status AS latest_submission_status,
            latest.location_text AS latest_location_text,
            latest.note AS latest_note,
            latest.serial_number AS latest_serial_number,
            latest.review_state AS latest_review_state,
            latest.review_note AS latest_review_note,
            latest.review_return_route AS latest_review_return_route,
            latest.reviewed_by AS latest_reviewed_by,
            latest.reviewed_at AS latest_reviewed_at,
            latest.withdrawn_by AS latest_withdrawn_by,
            latest.withdrawn_at AS latest_withdrawn_at,
            latest.created_at AS latest_created_at,
            submitter.email AS latest_submitted_by_email,
            submitter.display_name AS latest_submitted_by_name
          FROM inventory_session_items item
          JOIN inventory_sessions session ON session.id = item.session_id
          LEFT JOIN inventory_items inventory ON inventory.id = item.inventory_item_id
          LEFT JOIN app_users assignee ON assignee.id = item.assigned_to
          LEFT JOIN app_users direct_verifier ON direct_verifier.id = item.direct_verified_by
          LEFT JOIN LATERAL (
            SELECT submission.*
            FROM item_submissions submission
            WHERE submission.session_item_id = item.id
            ORDER BY submission.created_at DESC, submission.id DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN app_users submitter ON submitter.id = latest.submitted_by
          WHERE session.tenant_id = $1
          ORDER BY session.created_at DESC, item.created_at, item.id
        `,
        [context.tenant.id]
      )
    ]);

    return {
      sessions: sessionResult.rows.map(rowToSession),
      rows: rowResult.rows.map(rowToReportItem),
      generatedAt: new Date().toISOString()
    };
  });

  route(app, "post", "/api/inventory/items", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        title: z.string().min(1),
        commonName: z.string().optional(),
        armyName: z.string().optional(),
        lin: z.string().optional(),
        nsn: z.string().optional(),
        serialNumber: z.string().optional(),
        description: z.string().optional(),
        currentLocation: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        mediaUploadIds: z.array(z.string().uuid()).max(3).optional()
      }),
      request.body
    );

    const mediaUploadIds = body.mediaUploadIds || [];
    if (new Set(mediaUploadIds).size !== mediaUploadIds.length) {
      throw requestError("Each inventory reference upload can only be attached once.");
    }
    const localReferenceKeys = localMediaStorageKeys(body.metadata || {});
    if (localReferenceKeys.length !== mediaUploadIds.length) {
      throw requestError("Each local inventory reference must include its matching upload ID.");
    }

    const item = await withTransaction(async client => {
      const referenceUploads = [];
      for (const uploadId of [...mediaUploadIds].sort()) {
        referenceUploads.push(await lockStagedMediaUpload(client, {
          uploadId,
          tenantId: context.tenant.id,
          userId: context.user.id,
          purpose: "inventory_reference",
          canUseAnyUploader: true
        }));
      }
      const attachedStorageKeys = new Set(referenceUploads.map(upload => upload.storage_key));
      if (
        attachedStorageKeys.size !== localReferenceKeys.length ||
        localReferenceKeys.some(storageKey => !attachedStorageKeys.has(storageKey))
      ) {
        throw requestError("Inventory reference upload IDs do not match the local media URLs.");
      }

      const result = await client.query(
        `
          INSERT INTO inventory_items
            (tenant_id, title, common_name, army_name, lin, nsn, serial_number, description, current_location, metadata, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
          RETURNING *
        `,
        [
          context.tenant.id,
          body.title,
          body.commonName || null,
          body.armyName || null,
          body.lin || null,
          body.nsn || null,
          body.serialNumber || null,
          body.description || null,
          body.currentLocation || null,
          JSON.stringify(body.metadata || {}),
          context.user.id
        ]
      );

      for (const [index, upload] of referenceUploads.entries()) {
        await attachMediaUpload(client, upload, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          attachedToType: "inventory_item",
          attachedToId: result.rows[0].id
        });
        await client.query(
          `
            INSERT INTO inventory_item_media (inventory_item_id, media_upload_id, sort_order)
            VALUES ($1, $2, $3)
          `,
          [result.rows[0].id, upload.id, index]
        );
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_item.created",
        entityType: "inventory_item",
        entityId: result.rows[0].id,
        metadata: { mediaUploadCount: referenceUploads.length }
      });

      return result.rows[0];
    });

    reply.code(201);
    const mediaByItemId = await loadInventoryItemMedia([item.id]);
    return { item: rowToInventoryItem(item, mediaByItemId.get(item.id) || []) };
  });

  route(app, "get", "/api/inventory/sessions", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor", "viewer"],
      { allowCrew: true }
    );
    const result = await withTransaction(async client => {
      if (!context.crew) await expireCrewAccess(client, context.tenant.id);
      return client.query(
        `
          SELECT s.*,
            COUNT(si.id)::int AS item_count,
            COUNT(si.id) FILTER (WHERE si.status IN ('found', 'not_found', 'mismatch', 'approved'))::int AS found_count,
            COUNT(si.id) FILTER (WHERE si.status = 'needs_review')::int AS needs_review_count,
            MAX(si.updated_at) AS last_item_updated_at
          FROM inventory_sessions s
          LEFT JOIN inventory_session_items si ON si.session_id = s.id
          WHERE s.tenant_id = $1
            AND ($2::uuid IS NULL OR (s.id = $2 AND s.status = 'active'))
          GROUP BY s.id
          ORDER BY s.created_at DESC
        `,
        [context.tenant.id, context.crew?.sessionId || null]
      );
    });

    return { sessions: result.rows.map(rowToSession) };
  });

  route(app, "post", "/api/inventory/sessions", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        name: z.string().min(2),
        packetSource: z.string().optional(),
        status: z.enum(["draft", "active"]).default("draft")
      }),
      request.body
    );

    const session = await withTransaction(async client => {
      const result = await client.query(
        `
          INSERT INTO inventory_sessions (tenant_id, name, packet_source, status, created_by, started_at)
          VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'active' THEN now() ELSE NULL END)
          RETURNING *
        `,
        [context.tenant.id, body.name, body.packetSource || null, body.status, context.user.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_session.created",
        entityType: "inventory_session",
        entityId: result.rows[0].id,
        metadata: {
          sessionName: result.rows[0].name,
          status: result.rows[0].status
        }
      });

      return result.rows[0];
    });

    reply.code(201);
    return { session: rowToSession(session) };
  });

  route(app, "get", "/api/inventory/sessions/:sessionId/crew-access", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const crew = await withTransaction(async client => {
      await expireCrewAccess(client, context.tenant.id);
      const sessionResult = await client.query(
        "SELECT id FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1",
        [request.params.sessionId, context.tenant.id]
      );
      if (!sessionResult.rows[0]) return null;
      const result = await client.query(
        `
          SELECT id, session_id, display_name, status, expires_at, consumed_at,
            revoked_at, revoke_reason, created_at
          FROM session_crew_grants
          WHERE tenant_id = $1 AND session_id = $2
          ORDER BY created_at DESC, id DESC
        `,
        [context.tenant.id, request.params.sessionId]
      );
      return result.rows;
    });
    if (!crew) {
      reply.code(404);
      throw new Error("Session not found");
    }
    return {
      crew: crew.map(rowToCrewAccess),
      limit: config.crewAccess.maxActiveGrantsPerSession
    };
  });

  route(app, "post", "/api/inventory/sessions/:sessionId/crew-access", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        displayName: z.string().trim().min(2).max(80)
      }),
      request.body
    );
    const created = await withTransaction(async client => {
      const sessionResult = await client.query(
        `
          SELECT id, status
          FROM inventory_sessions
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `,
        [request.params.sessionId, context.tenant.id]
      );
      const session = sessionResult.rows[0];
      if (!session) return null;
      if (session.status !== "active") return { sessionInactive: true };
      const crewGrant = await createCrewGrant(client, {
        tenantId: context.tenant.id,
        sessionId: session.id,
        displayName: body.displayName,
        createdBy: context.user.id
      });
      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "crew_access.created",
        entityType: "session_crew_grant",
        entityId: crewGrant.grant.id,
        metadata: {
          sessionId: session.id,
          displayName: crewGrant.grant.display_name,
          expiresAt: crewGrant.grant.expires_at
        }
      });
      return crewGrant;
    });
    if (!created) {
      reply.code(404);
      throw new Error("Session not found");
    }
    if (created.sessionInactive) {
      reply.code(409);
      throw new Error("Crew passes can only be created for an active session.");
    }
    reply.code(201);
    return {
      access: rowToCrewAccess(created.grant),
      code: created.code,
      inviteToken: created.inviteToken
    };
  });

  route(app, "post", "/api/inventory/sessions/:sessionId/crew-access/:grantId/revoke", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const revoked = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT crew_grant.*
          FROM session_crew_grants crew_grant
          JOIN inventory_sessions inventory_session ON inventory_session.id = crew_grant.session_id
          WHERE crew_grant.id = $1 AND crew_grant.session_id = $2
            AND crew_grant.tenant_id = $3 AND inventory_session.tenant_id = $3
          FOR UPDATE OF crew_grant
        `,
        [request.params.grantId, request.params.sessionId, context.tenant.id]
      );
      const current = currentResult.rows[0];
      if (!current) return null;
      const releasedClaimCount = current.consumed_by
        ? await releaseCrewClaims(client, {
          tenantId: context.tenant.id,
          sessionId: current.session_id,
          userId: current.consumed_by,
          actorUserId: context.user.id,
          reason: "leader_revoked"
        })
        : 0;
      if (["revoked", "expired"].includes(current.status)) return current;
      const result = await client.query(
        `
          UPDATE session_crew_grants
          SET status = 'revoked', revoked_at = now(), revoked_by = $2,
            revoke_reason = 'leader_revoked'
          WHERE id = $1
          RETURNING *
        `,
        [current.id, context.user.id]
      );
      await client.query(
        `
          UPDATE session_crew_auth_sessions
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE grant_id = $1
        `,
        [current.id]
      );
      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "crew_access.revoked",
        entityType: "session_crew_grant",
        entityId: current.id,
        metadata: { sessionId: current.session_id, releasedClaimCount }
      });
      return result.rows[0];
    });
    if (!revoked) {
      reply.code(404);
      throw new Error("Crew pass not found");
    }
    return { revoked: true, access: rowToCrewAccess(revoked) };
  });

  route(app, "get", "/api/inventory/sessions/:sessionId", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor", "viewer"],
      { allowCrew: true }
    );
    if (context.crew && request.params.sessionId !== context.crew.sessionId) {
      reply.code(403);
      throw new Error("Crew access is limited to its assigned session.");
    }
    const sessionResult = await query(
      `
        SELECT s.*,
          COUNT(si.id)::int AS item_count,
          COUNT(si.id) FILTER (WHERE si.status IN ('found', 'not_found', 'mismatch', 'approved'))::int AS found_count,
          COUNT(si.id) FILTER (WHERE si.status = 'needs_review')::int AS needs_review_count,
          MAX(si.updated_at) AS last_item_updated_at
        FROM inventory_sessions s
        LEFT JOIN inventory_session_items si ON si.session_id = s.id
        WHERE s.id = $1 AND s.tenant_id = $2
          AND ($3::boolean = false OR s.status = 'active')
        GROUP BY s.id
        LIMIT 1
      `,
      [request.params.sessionId, context.tenant.id, Boolean(context.crew)]
    );

    const session = sessionResult.rows[0];
    if (!session) {
      reply.code(404);
      throw new Error("Session not found");
    }

    const itemsResult = await query(
      `
        SELECT si.*,
          ii.title AS item_title,
          ii.common_name,
          ii.army_name,
          ii.lin,
          ii.nsn,
          ii.description,
          ii.current_location,
          ii.serial_number AS item_serial_number,
          ii.last_verified_submission_id AS item_last_verified_submission_id,
          ii.last_verified_by AS item_last_verified_by,
          ii.last_verified_at AS item_last_verified_at,
          ii.legacy_media_metadata AS item_legacy_media_metadata,
          ii.metadata AS item_metadata,
          suggested.title AS suggested_item_title,
          suggested.common_name AS suggested_common_name,
          suggested.army_name AS suggested_army_name,
          suggested.lin AS suggested_lin,
          suggested.nsn AS suggested_nsn,
          suggested.description AS suggested_description,
          suggested.current_location AS suggested_current_location,
          suggested.serial_number AS suggested_serial_number,
          suggested.last_verified_submission_id AS suggested_last_verified_submission_id,
          suggested.last_verified_by AS suggested_last_verified_by,
          suggested.last_verified_at AS suggested_last_verified_at,
          suggested.legacy_media_metadata AS suggested_legacy_media_metadata,
          suggested.metadata AS suggested_item_metadata,
          assigned.email AS assigned_to_email,
          assigned.display_name AS assigned_to_name,
          assigner.email AS assigned_by_email,
          assigner.display_name AS assigned_by_name,
          verifier.email AS direct_verified_by_email
        FROM inventory_session_items si
        LEFT JOIN inventory_items ii ON ii.id = si.inventory_item_id AND ii.tenant_id = $2
        LEFT JOIN inventory_items suggested ON suggested.id = si.suggested_inventory_item_id AND suggested.tenant_id = $2
        LEFT JOIN app_users assigned ON assigned.id = si.assigned_to
        LEFT JOIN app_users assigner ON assigner.id = si.assigned_by
        LEFT JOIN app_users verifier ON verifier.id = si.direct_verified_by
        WHERE si.session_id = $1
        ORDER BY si.created_at ASC
      `,
      [session.id, context.tenant.id]
    );

    const submissionsResult = await query(
      `
        SELECT sub.*, submitter.email AS submitted_by_email, submitter.display_name AS submitted_by_name
        FROM item_submissions sub
        JOIN inventory_session_items si ON si.id = sub.session_item_id
        JOIN app_users submitter ON submitter.id = sub.submitted_by
        WHERE si.session_id = $1
        ORDER BY sub.created_at DESC
      `,
      [session.id]
    );

    const mediaByItemId = await loadInventoryItemMedia(itemsResult.rows.flatMap(row => [
      row.inventory_item_id,
      row.suggested_inventory_item_id
    ]));
    const includeSuggestion = hasTenantRole(context, ["tenant_admin"]);
    const items = itemsResult.rows.map(row => rowToSessionItem(row, {
      inventoryPhotos: mediaByItemId.get(row.inventory_item_id) || [],
      suggestedInventoryPhotos: mediaByItemId.get(row.suggested_inventory_item_id) || [],
      includeSuggestion
    }));
    const itemById = new Map(items.map(item => [item.id, item]));
    const submissions = submissionsResult.rows.map(rowToSubmission);
    const submissionById = new Map(submissions.map(submission => [submission.id, submission]));

    if (submissions.length) {
      const photosResult = await query(
        `
          SELECT *
          FROM submission_photos
          WHERE submission_id = ANY($1::uuid[])
          ORDER BY created_at ASC
        `,
        [submissions.map(submission => submission.id)]
      );

      photosResult.rows.forEach(row => {
        const submission = submissionById.get(row.submission_id);
        if (submission) submission.photos.push(rowToPhoto(row));
      });
    }

    submissions.forEach(submission => {
      const item = itemById.get(submission.sessionItemId);
      if (item) item.submissions.push(submission);
    });

    let importBatches = { rows: [] };
    if (hasTenantRole(context, ["tenant_admin"])) {
      const tableResult = await query("SELECT to_regclass('public.packet_import_batches') AS table_name");
      if (tableResult.rows[0]?.table_name) {
        importBatches = await query(
          `
            SELECT b.*, creator.email AS created_by_email, creator.display_name AS created_by_name
            FROM packet_import_batches b
            LEFT JOIN app_users creator ON creator.id = b.created_by
            WHERE b.session_id = $1 AND b.tenant_id = $2
            ORDER BY b.created_at DESC
          `,
          [session.id, context.tenant.id]
        );
      }
    }

    return {
      session: rowToSession(session),
      items,
      importBatches: importBatches.rows.map(row => rowToImportBatch(row, { includeText: true }))
    };
  });

  route(app, "patch", "/api/inventory/sessions/:sessionId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        name: z.string().min(2).optional(),
        status: z.enum(["draft", "active", "closed"]).optional()
      }),
      request.body
    );

    const updated = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT id, status
          FROM inventory_sessions
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `,
        [request.params.sessionId, context.tenant.id]
      );
      const current = currentResult.rows[0];
      if (!current) return null;
      if (body.status === "closed" && current.status !== "closed") {
        const actionableReview = await client.query(
          `
            SELECT 1
            FROM item_submissions submission
            JOIN inventory_session_items item ON item.id = submission.session_item_id
            WHERE item.session_id = $1
              AND submission.review_state IN ('pending', 'request_more_info')
            LIMIT 1
          `,
          [current.id]
        );
        if (actionableReview.rows[0]) return { reviewPending: true };
      }
      const result = await client.query(
        `
          UPDATE inventory_sessions
          SET
            name = COALESCE($1, name),
            status = COALESCE($2, status),
            started_at = CASE
              WHEN $2 IN ('active', 'closed') THEN COALESCE(started_at, now())
              ELSE started_at
            END,
            closed_at = CASE
              WHEN $2 = 'closed' THEN COALESCE(closed_at, now())
              WHEN $2 IN ('draft', 'active') THEN NULL
              ELSE closed_at
            END
          WHERE id = $3 AND tenant_id = $4
          RETURNING *
        `,
        [body.name || null, body.status || null, request.params.sessionId, context.tenant.id]
      );

      let revokedCrewCount = 0;
      if (body.status === "closed" && current.status !== "closed") {
        revokedCrewCount = await revokeCrewAccessForSession(client, {
          tenantId: context.tenant.id,
          sessionId: current.id,
          actorUserId: context.user.id,
          reason: "session_closed"
        });
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_session.updated",
        entityType: "inventory_session",
        entityId: result.rows[0].id,
        metadata: {
          sessionName: result.rows[0].name,
          status: body.status || null,
          revokedCrewCount
        }
      });

      return { session: result.rows[0], revokedCrewCount };
    });

    if (!updated) {
      reply.code(404);
      throw new Error("Session not found");
    }
    if (updated.reviewPending) {
      reply.code(409);
      throw new Error("Review or request the pending proof before closing this session.");
    }

    return {
      session: rowToSession(updated.session),
      crewAccessRevoked: updated.revokedCrewCount
    };
  });

  route(app, "delete", "/api/inventory/sessions/:sessionId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);

    const deleted = await withTransaction(async client => {
      const sessionResult = await client.query(
        `
          SELECT s.*, COUNT(si.id)::int AS item_count
          FROM inventory_sessions s
          LEFT JOIN inventory_session_items si ON si.session_id = s.id
          WHERE s.id = $1 AND s.tenant_id = $2
          GROUP BY s.id
          LIMIT 1
        `,
        [request.params.sessionId, context.tenant.id]
      );

      const session = sessionResult.rows[0];
      if (!session) return null;
      if (Number(session.item_count || 0) > 0) {
        reply.code(409);
        throw new Error("Only empty sessions can be deleted");
      }

      await client.query(
        `
          DELETE FROM inventory_sessions
          WHERE id = $1 AND tenant_id = $2
        `,
        [session.id, context.tenant.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_session.deleted",
        entityType: "inventory_session",
        entityId: session.id,
        metadata: { name: session.name }
      });

      return session;
    });

    if (!deleted) {
      reply.code(404);
      throw new Error("Session not found");
    }

    return { deleted: true, session: rowToSession(deleted) };
  });

  route(app, "post", "/api/inventory/sessions/:sessionId/items", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        inventoryItemId: z.string().uuid().optional(),
        packetLine: z.string().optional(),
        expectedQty: z.number().int().nonnegative().optional(),
        locationHint: z.string().optional()
      }),
      request.body
    );

    const created = await withTransaction(async client => {
      const sessionResult = await client.query(
        `
          SELECT id, name
          FROM inventory_sessions
          WHERE id = $1 AND tenant_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [request.params.sessionId, context.tenant.id]
      );
      const session = sessionResult.rows[0];
      if (!session) return null;

      let confirmedItem = null;
      let suggestedItem = null;
      if (body.inventoryItemId) {
        const inventoryResult = await client.query(
          `
            SELECT id, title, common_name, army_name, lin, nsn, description, current_location
            FROM inventory_items
            WHERE id = $1 AND tenant_id = $2
            LIMIT 1
          `,
          [body.inventoryItemId, context.tenant.id]
        );
        confirmedItem = inventoryResult.rows[0] || null;
        if (!confirmedItem) throw requestError("Choose an inventory item from this workspace.");
      } else if (body.packetLine) {
        const inventoryResult = await client.query(
          `
            SELECT id, title, common_name, army_name, lin, nsn, description, current_location
            FROM inventory_items
            WHERE tenant_id = $1
          `,
          [context.tenant.id]
        );
        suggestedItem = findInventoryItemMatch(body.packetLine, inventoryResult.rows.map(itemMatchProfile))?.item || null;
      }

      const result = await client.query(
        `
          INSERT INTO inventory_session_items (
            session_id,
            inventory_item_id,
            suggested_inventory_item_id,
            packet_line,
            expected_qty,
            location_hint,
            inventory_match_confirmed_by,
            inventory_match_confirmed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END)
          RETURNING *
        `,
        [
          session.id,
          confirmedItem?.id || null,
          suggestedItem?.id || null,
          body.packetLine || null,
          body.expectedQty ?? null,
          body.locationHint || confirmedItem?.current_location || null,
          confirmedItem ? context.user.id : null
        ]
      );
      const sessionItem = result.rows[0];

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "session_item.created",
        entityType: "inventory_session_item",
        entityId: sessionItem.id,
        metadata: {
          sessionName: session.name,
          packetLine: sessionItem.packet_line,
          expectedQty: sessionItem.expected_qty,
          locationHint: sessionItem.location_hint,
          inventoryItemId: sessionItem.inventory_item_id,
          suggestedInventoryItemId: sessionItem.suggested_inventory_item_id
        }
      });

      return sessionItem;
    });

    if (!created) {
      reply.code(404);
      throw new Error("Session not found");
    }

    reply.code(201);
    return { sessionItem: created };
  });

  route(app, "post", "/api/inventory/sessions/:sessionId/items/bulk", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        items: z.array(z.object({
          packetLine: z.string().min(2),
          inventoryItemId: z.string().uuid().optional(),
          expectedQty: z.number().int().nonnegative().optional(),
          locationHint: z.string().optional()
        })).min(1).max(250),
        importBatch: z.object({
          sourceName: z.string().max(240).optional(),
          sourceMimeType: z.string().max(120).optional(),
          extractedText: z.string().max(1_000_000).optional(),
          sourceFile: z.object({
            fileName: z.string().max(240).optional(),
            mimeType: z.string().max(120),
            size: z.number().int().nonnegative().max(10 * 1024 * 1024).optional(),
            dataUrl: z.string().optional(),
            base64: z.string().optional()
          }).optional()
        }).optional()
      }),
      request.body
    );

    const hasImportBatch = Boolean(
      body.importBatch?.sourceName ||
      body.importBatch?.sourceMimeType ||
      body.importBatch?.extractedText ||
      body.importBatch?.sourceFile
    );
    const tableResult = hasImportBatch
      ? await query("SELECT to_regclass('public.packet_import_batches') AS table_name")
      : { rows: [{ table_name: null }] };
    if (hasImportBatch && !tableResult.rows[0]?.table_name) {
      reply.code(503);
      throw new Error("Packet import batch schema is not installed. Run backend/db/003_packet_import_batches.sql.");
    }

    let packetSourceFile = null;
    let created;
    try {
      created = await withTransaction(async client => {
      const sessionResult = await client.query(
        "SELECT id, name FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1",
        [request.params.sessionId, context.tenant.id]
      );

      if (!sessionResult.rows[0]) return null;

      const inventoryResult = await client.query(
        `
          SELECT id, title, common_name, army_name, lin, nsn, description, current_location
          FROM inventory_items
          WHERE tenant_id = $1
        `,
        [context.tenant.id]
      );
      const matchableInventoryItems = inventoryResult.rows.map(itemMatchProfile);
      const inventoryItemById = new Map(inventoryResult.rows.map(item => [item.id, item]));
      let importBatch = null;
      if (hasImportBatch) {
        const sourceUpload = body.importBatch?.sourceFile
          ? await savePacketImportSource(context.tenant, body.importBatch.sourceFile)
          : null;
        packetSourceFile = sourceUpload?.storageKey || null;
        const batchResult = await client.query(
          `
            INSERT INTO packet_import_batches (
              tenant_id,
              session_id,
              source_name,
              source_mime_type,
              source_size_bytes,
              source_storage_key,
              extracted_text,
              row_count,
              created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
          `,
          [
            context.tenant.id,
            request.params.sessionId,
            body.importBatch?.sourceName || body.importBatch?.sourceFile?.fileName || null,
            body.importBatch?.sourceMimeType || body.importBatch?.sourceFile?.mimeType || null,
            sourceUpload?.sizeBytes ?? body.importBatch?.sourceFile?.size ?? null,
            sourceUpload?.storageKey || null,
            body.importBatch?.extractedText || null,
            body.items.length,
            context.user.id
          ]
        );
        importBatch = batchResult.rows[0];
        if (sourceUpload) {
          const mediaResult = await client.query(
            `
              INSERT INTO media_uploads (
                tenant_id,
                uploaded_by,
                storage_key,
                original_file_name,
                mime_type,
                size_bytes,
                purpose,
                state,
                attached_to_type,
                attached_to_id,
                attached_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, 'packet_source', 'attached', 'packet_import_batch', $7, now())
              RETURNING id
            `,
            [
              context.tenant.id,
              context.user.id,
              sourceUpload.storageKey,
              body.importBatch?.sourceName || body.importBatch?.sourceFile?.fileName || null,
              body.importBatch?.sourceMimeType || body.importBatch?.sourceFile?.mimeType || "application/octet-stream",
              sourceUpload.sizeBytes,
              importBatch.id
            ]
          );
          const linkedBatch = await client.query(
            `
              UPDATE packet_import_batches
              SET media_upload_id = $1
              WHERE id = $2
              RETURNING *
            `,
            [mediaResult.rows[0].id, importBatch.id]
          );
          await createAuditEvent(client, {
            tenantId: context.tenant.id,
            actorUserId: context.user.id,
            action: "media_upload.attached",
            entityType: "media_upload",
            entityId: mediaResult.rows[0].id,
            metadata: {
              purpose: "packet_source",
              attachedToType: "packet_import_batch",
              attachedToId: importBatch.id,
              ownerOverride: false
            }
          });
          importBatch = linkedBatch.rows[0];
        }
      }

      const rows = [];
      let matchedCount = 0;
      let possibleMatchCount = 0;
      for (const item of body.items) {
        const explicitlyConfirmedItem = item.inventoryItemId
          ? inventoryItemById.get(item.inventoryItemId) || null
          : null;
        if (item.inventoryItemId && !explicitlyConfirmedItem) {
          throw requestError("Choose inventory items from this workspace.");
        }
        const automaticMatch = explicitlyConfirmedItem
          ? null
          : findInventoryItemMatch(item.packetLine, matchableInventoryItems);
        const uniqueIdentifierItem = explicitlyConfirmedItem
          ? null
          : findUniqueInventoryIdentifierMatch(item.packetLine, matchableInventoryItems);
        const canReuseUniqueSavedItem = Boolean(
          automaticMatch
          && uniqueIdentifierItem
          && automaticMatch.item.id === uniqueIdentifierItem.id
          && (item.expectedQty == null || Number(item.expectedQty) === 1)
          && automaticMatch.score >= 900
          && automaticMatch.reasons.some(reason => reason === "lin" || reason === "nsn")
        );
        const confirmedItem = explicitlyConfirmedItem || (canReuseUniqueSavedItem ? automaticMatch.item : null);
        const suggestedItem = confirmedItem ? null : automaticMatch?.item || null;
        const locationHint = item.locationHint || confirmedItem?.current_location || null;
        if (confirmedItem || suggestedItem) matchedCount += 1;
        if (suggestedItem) possibleMatchCount += 1;

        const result = importBatch
          ? await client.query(
            `
              INSERT INTO inventory_session_items (
                session_id,
                inventory_item_id,
                suggested_inventory_item_id,
                packet_line,
                expected_qty,
                location_hint,
                import_batch_id,
                inventory_match_confirmed_by,
                inventory_match_confirmed_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END)
              RETURNING *
            `,
            [
              request.params.sessionId,
              confirmedItem?.id || null,
              suggestedItem?.id || null,
              item.packetLine.trim(),
              item.expectedQty ?? null,
              locationHint,
              importBatch.id,
              confirmedItem ? context.user.id : null
            ]
          )
          : await client.query(
            `
              INSERT INTO inventory_session_items (
                session_id,
                inventory_item_id,
                suggested_inventory_item_id,
                packet_line,
                expected_qty,
                location_hint,
                inventory_match_confirmed_by,
                inventory_match_confirmed_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END)
              RETURNING *
            `,
            [
              request.params.sessionId,
              confirmedItem?.id || null,
              suggestedItem?.id || null,
              item.packetLine.trim(),
              item.expectedQty ?? null,
              locationHint,
              confirmedItem ? context.user.id : null
            ]
          );
        rows.push(result.rows[0]);
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "session_items.bulk_created",
        entityType: "inventory_session",
        entityId: request.params.sessionId,
        metadata: {
          sessionName: sessionResult.rows[0].name,
          count: rows.length,
          matchedCount,
          importBatchId: importBatch?.id || null,
          sourceName: body.importBatch?.sourceName || null
        }
      });

      return { rows, importBatch, possibleMatchCount };
      });
      packetSourceFile = null;
    } catch (error) {
      if (packetSourceFile) {
        await deleteStoredFile(packetSourceFile).catch(cleanupError => {
          console.error(JSON.stringify({
            event: "packet_source_cleanup_failed",
            storageKey: packetSourceFile,
            errorMessage: cleanupError?.message || String(cleanupError)
          }));
        });
      }
      throw error;
    }

    if (!created) {
      reply.code(404);
      throw new Error("Session not found");
    }

    reply.code(201);
    return {
      sessionItems: created.rows,
      importBatch: created.importBatch ? rowToImportBatch(created.importBatch, { includeText: true }) : null,
      possibleMatchCount: created.possibleMatchCount
    };
  });

  route(app, "post", "/api/uploads/photos", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor"],
      { allowCrew: true }
    );
    const body = parseBody(
      z.object({
        fileName: z.string().max(240).optional(),
        mimeType: z.enum([...imageMimeTypes.keys()]),
        dataUrl: z.string().optional(),
        base64: z.string().optional(),
        caption: z.string().optional(),
        kind: z.enum(photoKinds).default("general"),
        purpose: z.enum(["evidence", "inventory_reference"]).default("evidence")
      }),
      request.body
    );
    if (body.purpose === "inventory_reference" && !hasTenantRole(context, ["tenant_admin"])) {
      throw requestError("Only platoon admins can stage inventory reference photos.", 403);
    }
    if (context.crew && body.purpose !== "evidence") {
      throw requestError("Crew access can only upload proof photos.", 403);
    }

    const stored = await saveUploadedImage(context.tenant, body);
    let upload;
    try {
      upload = await withTransaction(async client => {
        if (context.crew) {
          await assertCrewStagedUploadQuota(client, context);
        }
        const result = await client.query(
          `
            INSERT INTO media_uploads (
              tenant_id,
              uploaded_by,
              storage_key,
              original_file_name,
              mime_type,
              size_bytes,
              purpose,
              staged_expires_at,
              crew_auth_session_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 hour'), $9)
            RETURNING *
          `,
          [
            context.tenant.id,
            context.user.id,
            stored.storageKey,
            body.fileName || null,
            body.mimeType,
            stored.sizeBytes,
            body.purpose,
            config.storage.mediaUploadStagingTtlHours,
            context.crew?.authSessionId || null
          ]
        );
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: "media_upload.staged",
          entityType: "media_upload",
          entityId: result.rows[0].id,
          metadata: {
            purpose: body.purpose,
            mimeType: body.mimeType,
            sizeBytes: stored.sizeBytes
          }
        });
        return result.rows[0];
      });
    } catch (error) {
      await deleteStoredFile(stored.storageKey).catch(cleanupError => {
        console.error(JSON.stringify({
          event: "media_upload_cleanup_failed",
          storageKey: stored.storageKey,
          errorMessage: cleanupError?.message || String(cleanupError)
        }));
      });
      throw error;
    }

    reply.code(201);
    return {
      photo: {
        uploadId: upload.id,
        url: buildMediaUrl(upload.storage_key),
        caption: body.caption || null,
        kind: body.kind,
        purpose: upload.purpose,
        expiresAt: upload.staged_expires_at
      }
    };
  });

  route(app, "delete", "/api/uploads/photos/:uploadId", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor"],
      { allowCrew: true }
    );
    const uploadId = parseBody(z.string().uuid(), request.params.uploadId);
    const discarded = await withTransaction(async client => {
      const result = await client.query(
        `
          SELECT *
          FROM media_uploads
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE
        `,
        [uploadId, context.tenant.id]
      );
      const upload = result.rows[0];
      if (!upload) return null;
      if (upload.uploaded_by !== context.user.id) {
        throw requestError("Photo upload belongs to another user.", 403);
      }
      if (upload.state !== "staged") {
        throw requestError("Attached photos cannot be discarded.", 409);
      }
      if (context.crew) {
        if (upload.crew_auth_session_id !== context.crew.authSessionId) {
          throw requestError("Photo upload belongs to another crew session.", 403);
        }
        await lockActiveCrewAccess(client, {
          authSessionId: context.crew.authSessionId,
          tenantId: context.tenant.id,
          sessionId: context.crew.sessionId,
          userId: context.user.id
        });
      }

      if (!normalizeMediaStorageKey(upload.storage_key)) {
        throw requestError("Photo upload is unavailable.", 409);
      }
      await deleteStoredFile(upload.storage_key);
      const deleted = await client.query(
        `
          DELETE FROM media_uploads
          WHERE id = $1 AND tenant_id = $2 AND uploaded_by = $3 AND state = 'staged'
          RETURNING id
        `,
        [upload.id, context.tenant.id, context.user.id]
      );
      if (!deleted.rows[0]) throw requestError("Photo upload could not be discarded.", 409);
      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "media_upload.discarded",
        entityType: "media_upload",
        entityId: upload.id,
        metadata: {
          purpose: upload.purpose,
          mimeType: upload.mime_type,
          sizeBytes: upload.size_bytes == null ? null : Number(upload.size_bytes)
        }
      });
      return upload;
    });
    if (!discarded) {
      reply.code(404);
      throw new Error("Photo upload not found");
    }
    return { discarded: true, uploadId: discarded.id };
  });

  route(app, "patch", "/api/session-items/:sessionItemId/inventory-match", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({ action: z.enum(["confirm", "dismiss"]) }).strict(),
      request.body
    );

    const match = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT item.id,
            item.inventory_item_id,
            item.suggested_inventory_item_id,
            item.location_hint,
            session.status AS session_status
          FROM inventory_session_items item
          JOIN inventory_sessions session ON session.id = item.session_id
          WHERE item.id = $1
            AND session.tenant_id = $2
          FOR UPDATE OF item, session
        `,
        [request.params.sessionItemId, context.tenant.id]
      );
      const current = currentResult.rows[0];
      if (!current) return null;
      if (current.session_status === "closed") return { sessionClosed: true };
      if (!current.suggested_inventory_item_id) return { staleMatch: true };

      let inventoryItem = null;
      if (body.action === "confirm") {
        const inventoryResult = await client.query(
          `
            SELECT *
            FROM inventory_items
            WHERE id = $1
              AND tenant_id = $2
            FOR UPDATE
          `,
          [current.suggested_inventory_item_id, context.tenant.id]
        );
        inventoryItem = inventoryResult.rows[0] || null;
        if (!inventoryItem) return { invalidSuggestion: true };
      }

      const updatedResult = await client.query(
        `
          UPDATE inventory_session_items
          SET inventory_item_id = CASE WHEN $2 = 'confirm' THEN suggested_inventory_item_id ELSE inventory_item_id END,
            suggested_inventory_item_id = NULL,
            inventory_match_confirmed_by = CASE WHEN $2 = 'confirm' THEN $3 ELSE inventory_match_confirmed_by END,
            inventory_match_confirmed_at = CASE WHEN $2 = 'confirm' THEN now() ELSE inventory_match_confirmed_at END,
            location_hint = CASE
              WHEN $2 = 'confirm' THEN COALESCE(location_hint, $4)
              ELSE location_hint
            END,
            updated_at = now()
          WHERE id = $1
            AND suggested_inventory_item_id IS NOT NULL
          RETURNING *
        `,
        [current.id, body.action, context.user.id, inventoryItem?.current_location || null]
      );
      if (!updatedResult.rows[0]) return { staleMatch: true };

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: body.action === "confirm" ? "session_item.inventory_match_confirmed" : "session_item.inventory_match_dismissed",
        entityType: "inventory_session_item",
        entityId: current.id,
        metadata: {
          inventoryItemId: current.suggested_inventory_item_id
        }
      });

      return { sessionItem: updatedResult.rows[0], inventoryItem };
    });

    if (!match) {
      reply.code(404);
      throw new Error("Session item not found");
    }
    if (match.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (match.staleMatch) {
      reply.code(409);
      throw new Error("This saved-item suggestion has already been resolved.");
    }
    if (match.invalidSuggestion) {
      reply.code(409);
      throw new Error("This saved-item suggestion is no longer available.");
    }

    const photosByItemId = match.inventoryItem
      ? await loadInventoryItemMedia([match.inventoryItem.id])
      : new Map();
    return {
      sessionItem: {
        id: match.sessionItem.id,
        inventoryItemId: match.sessionItem.inventory_item_id,
        suggestedInventoryItemId: match.sessionItem.suggested_inventory_item_id,
        locationHint: match.sessionItem.location_hint,
        inventoryMatchConfirmedBy: match.sessionItem.inventory_match_confirmed_by,
        inventoryMatchConfirmedAt: match.sessionItem.inventory_match_confirmed_at,
        updatedAt: match.sessionItem.updated_at
      },
      inventoryItem: match.inventoryItem
        ? rowToInventoryItem(match.inventoryItem, photosByItemId.get(match.inventoryItem.id) || [])
        : null
    };
  });

  route(app, "patch", "/api/session-items/:sessionItemId/assignment", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor"],
      { allowCrew: true }
    );
    const body = parseBody(
      z.object({
        memberId: z.union([z.string().uuid(), z.literal("self")]).nullable().optional()
      }),
      request.body
    );
    const canManageAssignments = hasTenantRole(context, ["tenant_admin"]);
    const isSelfAssignment = body.memberId === "self";
    const isSelfRelease = body.memberId === null;
    const requestedMemberId = isSelfAssignment ? null : body.memberId || null;

    if (!canManageAssignments && !isSelfAssignment && !isSelfRelease) {
      reply.code(403);
      throw new Error("You can only claim or release rows for yourself.");
    }

    const updated = await withTransaction(async client => {
      if (context.crew) {
        await lockActiveCrewAccess(client, {
          authSessionId: context.crew.authSessionId,
          tenantId: context.tenant.id,
          sessionId: context.crew.sessionId,
          userId: context.user.id
        });
      }
      const currentResult = await client.query(
        `
          SELECT si.id, si.assigned_to, s.id AS session_id, s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1
            AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [request.params.sessionItemId, context.tenant.id]
      );

      if (!currentResult.rows[0]) return null;
      if (currentResult.rows[0].session_status === "closed") return { sessionClosed: true };
      if (context.crew && (
        currentResult.rows[0].session_id !== context.crew.sessionId
        || currentResult.rows[0].session_status !== "active"
      )) return { crewSessionDenied: true };
      let assignedUser = null;
      if (isSelfAssignment) {
        if (currentResult.rows[0].assigned_to && currentResult.rows[0].assigned_to !== context.user.id) {
          reply.code(409);
          throw new Error("This row is already assigned to another user.");
        }

        assignedUser = {
          user_id: context.user.id,
          email: context.user.email,
          display_name: context.user.display_name,
          role: context.membership?.role || null
        };
      } else if (isSelfRelease && !canManageAssignments) {
        if (currentResult.rows[0].assigned_to && currentResult.rows[0].assigned_to !== context.user.id) {
          reply.code(409);
          throw new Error("This row is assigned to another user.");
        }
      } else if (requestedMemberId) {
        const memberResult = await client.query(
          `
            SELECT m.id, m.user_id, m.role, u.email, u.display_name
            FROM tenant_memberships m
            JOIN app_users u ON u.id = m.user_id
            WHERE m.id = $1
              AND m.tenant_id = $2
              AND m.status = 'active'
              AND m.role IN ('tenant_admin', 'contributor')
            LIMIT 1
          `,
          [requestedMemberId, context.tenant.id]
        );

        assignedUser = memberResult.rows[0] || null;
        if (!assignedUser) {
          reply.code(400);
          throw new Error("Choose an active platoon admin or contributor.");
        }
      }

      const result = await client.query(
        `
          UPDATE inventory_session_items si
          SET
            assigned_to = $1,
            assigned_by = CASE WHEN $1::uuid IS NULL THEN NULL ELSE $2 END,
            assigned_at = CASE WHEN $1::uuid IS NULL THEN NULL ELSE now() END,
            updated_at = now()
          FROM inventory_sessions s
          LEFT JOIN app_users assigned ON assigned.id = $1::uuid
          LEFT JOIN app_users assigner ON assigner.id = $2
          WHERE si.session_id = s.id
            AND si.id = $3
            AND s.tenant_id = $4
          RETURNING
            si.id,
            si.assigned_to,
            si.assigned_by,
            si.assigned_at,
            assigned.email AS assigned_to_email,
            assigned.display_name AS assigned_to_name,
            assigner.email AS assigned_by_email,
            assigner.display_name AS assigned_by_name
        `,
        [assignedUser?.user_id || null, context.user.id, request.params.sessionItemId, context.tenant.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: assignedUser ? "session_item.assigned" : "session_item.assignment_cleared",
        entityType: "inventory_session_item",
        entityId: request.params.sessionItemId,
        metadata: {
          assignedTo: assignedUser?.user_id || null,
          assignedToEmail: assignedUser?.email || null,
          assignedToRole: assignedUser?.role || null
        }
      });

      return result.rows[0];
    });

    if (!updated) {
      reply.code(404);
      throw new Error("Session item not found");
    }
    if (updated.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (updated.crewSessionDenied) {
      reply.code(403);
      throw new Error("Crew access is limited to its assigned active session.");
    }

    return {
      assignment: {
        sessionItemId: updated.id,
        assignedTo: updated.assigned_to,
        assignedToEmail: updated.assigned_to_email,
        assignedToName: updated.assigned_to_name,
        assignedBy: updated.assigned_by,
        assignedByEmail: updated.assigned_by_email,
        assignedByName: updated.assigned_by_name,
        assignedAt: updated.assigned_at
      }
    };
  });

  route(app, "patch", "/api/session-items/:sessionItemId/direct-check", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        status: z.enum(["found", "not_found", "mismatch"]),
        note: z.string().optional()
      }),
      request.body
    );

    const updated = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT si.id, s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1
            AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [request.params.sessionItemId, context.tenant.id]
      );

      if (!currentResult.rows[0]) return null;
      if (currentResult.rows[0].session_status === "closed") return { sessionClosed: true };

      if (["found", "not_found", "mismatch"].includes(body.status)) {
        await client.query(
          `
            WITH superseded AS (
              UPDATE item_submissions
              SET review_state = 'superseded',
                review_return_route = NULL,
                reviewed_at = COALESCE(reviewed_at, now())
              WHERE session_item_id = $1
                AND review_state IN ('pending', 'request_more_info', 'rejected')
              RETURNING id
            )
            UPDATE evidence_requests
            SET resolved_at = COALESCE(resolved_at, now())
            WHERE submission_id IN (SELECT id FROM superseded)
              AND resolved_at IS NULL
          `,
          [request.params.sessionItemId]
        );
      }

      const result = await client.query(
        `
          UPDATE inventory_session_items si
          SET status = $1,
            direct_verified_by = $2,
            assigned_to = CASE WHEN $1 IN ('found', 'not_found', 'mismatch') THEN NULL ELSE assigned_to END,
            assigned_by = CASE WHEN $1 IN ('found', 'not_found', 'mismatch') THEN NULL ELSE assigned_by END,
            assigned_at = CASE WHEN $1 IN ('found', 'not_found', 'mismatch') THEN NULL ELSE assigned_at END,
            updated_at = now()
          FROM inventory_sessions s
          WHERE si.session_id = s.id
            AND si.id = $3
            AND s.tenant_id = $4
          RETURNING si.*
        `,
        [body.status, context.user.id, request.params.sessionItemId, context.tenant.id]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "session_item.direct_check",
        entityType: "inventory_session_item",
        entityId: result.rows[0].id,
        metadata: { status: body.status, note: body.note || null }
      });

      return result.rows[0];
    });

    if (!updated) {
      reply.code(404);
      throw new Error("Session item not found");
    }
    if (updated.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }

    return { sessionItem: updated };
  });

  route(app, "post", "/api/session-items/:sessionItemId/submissions", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor"],
      { allowCrew: true }
    );
    const body = parseEvidenceSubmissionBody(request.body);
    const photos = body.photos || [];
    const photoUploadIds = photos.map(photo => photo.uploadId);
    if (new Set(photoUploadIds).size !== photoUploadIds.length) {
      throw requestError("Each photo upload can only be attached once.");
    }

    const submission = await withTransaction(async client => {
      if (context.crew) {
        await lockActiveCrewAccess(client, {
          authSessionId: context.crew.authSessionId,
          tenantId: context.tenant.id,
          sessionId: context.crew.sessionId,
          userId: context.user.id
        });
      }
      const sessionItemResult = await client.query(
        `
          SELECT si.id, si.packet_line, si.assigned_to, s.id AS session_id,
            s.name AS session_name, s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1 AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [request.params.sessionItemId, context.tenant.id]
      );

      if (!sessionItemResult.rows[0]) return null;
      if (sessionItemResult.rows[0].session_status === "closed") return { sessionClosed: true };
      if (context.crew && (
        sessionItemResult.rows[0].session_id !== context.crew.sessionId
        || sessionItemResult.rows[0].session_status !== "active"
      )) return { crewSessionDenied: true };
      if (!hasTenantRole(context, ["tenant_admin"])
        && sessionItemResult.rows[0].assigned_to !== context.user.id) {
        return { assignmentRequired: true };
      }
      const lockedUploads = new Map();
      for (const uploadId of [...photoUploadIds].sort()) {
        const upload = await lockStagedMediaUpload(client, {
          uploadId,
          tenantId: context.tenant.id,
          userId: context.user.id,
          purpose: "evidence",
          canUseAnyUploader: hasTenantRole(context, ["tenant_admin"]),
          crewAuthSessionId: context.crew?.authSessionId || null,
          crewSessionId: context.crew?.sessionId || null
        });
        lockedUploads.set(upload.id, upload);
      }

      await client.query(
        `
          WITH superseded AS (
            UPDATE item_submissions
            SET review_state = 'superseded',
              reviewed_at = COALESCE(reviewed_at, now())
            WHERE session_item_id = $1
              AND review_state IN ('pending', 'request_more_info')
            RETURNING id
          )
          UPDATE evidence_requests
          SET resolved_at = COALESCE(resolved_at, now())
          WHERE submission_id IN (SELECT id FROM superseded)
        `,
        [request.params.sessionItemId]
      );

      const result = await client.query(
        `
          INSERT INTO item_submissions
            (session_item_id, submitted_by, status, location_text, note, serial_number)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `,
        [
          request.params.sessionItemId,
          context.user.id,
          body.status,
          body.locationText || null,
          body.note || null,
          body.serialNumber || null
        ]
      );

      for (const photo of photos) {
        const upload = lockedUploads.get(photo.uploadId);
        if (!upload) throw requestError("Photo upload is invalid. Upload the file again.");

        await client.query(
          `
            INSERT INTO submission_photos (submission_id, media_upload_id, storage_key, caption, kind)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [result.rows[0].id, upload.id, upload.storage_key, photo.caption || null, photo.kind || "general"]
        );
        await attachMediaUpload(client, upload, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          attachedToType: "item_submission",
          attachedToId: result.rows[0].id
        });
      }

      await client.query(
        `
          UPDATE inventory_session_items
          SET status = 'needs_review',
            direct_verified_by = NULL,
            updated_at = now()
          WHERE id = $1
        `,
        [request.params.sessionItemId]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "submission.created",
        entityType: "item_submission",
        entityId: result.rows[0].id,
        metadata: { status: body.status, mediaUploadIds: photoUploadIds, photoCount: photos.length }
      });

      return {
        ...result.rows[0],
        packet_line: sessionItemResult.rows[0].packet_line,
        session_name: sessionItemResult.rows[0].session_name
      };
    });

    if (!submission) {
      reply.code(404);
      throw new Error("Session item not found");
    }
    if (submission.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (submission.crewSessionDenied) {
      reply.code(403);
      throw new Error("Crew access is limited to its assigned active session.");
    }
    if (submission.assignmentRequired) {
      reply.code(409);
      throw new Error("Claim this item before submitting proof.");
    }
    runNotification("Proof submission", () => notifyTenantAdminsOfSubmission(context, submission, {
      photoCount: (body.photos || []).length
    }));

    reply.code(201);
    return { submission };
  });

  route(app, "post", "/api/submissions/:submissionId/withdraw", async (request, reply) => {
    const context = await requireTenantContext(
      request,
      reply,
      ["tenant_admin", "contributor"],
      { allowCrew: true }
    );

    const withdrawn = await withTransaction(async client => {
      if (context.crew) {
        await lockActiveCrewAccess(client, {
          authSessionId: context.crew.authSessionId,
          tenantId: context.tenant.id,
          sessionId: context.crew.sessionId,
          userId: context.user.id
        });
      }

      const pointerResult = await client.query(
        `
          SELECT submission.session_item_id
          FROM item_submissions submission
          JOIN inventory_session_items item ON item.id = submission.session_item_id
          JOIN inventory_sessions session ON session.id = item.session_id
          WHERE submission.id = $1
            AND session.tenant_id = $2
        `,
        [request.params.submissionId, context.tenant.id]
      );
      if (!pointerResult.rows[0]) return null;

      const sessionItemResult = await client.query(
        `
          SELECT item.id,
            item.assigned_to,
            session.id AS session_id,
            session.status AS session_status
          FROM inventory_session_items item
          JOIN inventory_sessions session ON session.id = item.session_id
          WHERE item.id = $1
            AND session.tenant_id = $2
          FOR UPDATE OF item, session
        `,
        [pointerResult.rows[0].session_item_id, context.tenant.id]
      );
      const sessionItem = sessionItemResult.rows[0];
      if (!sessionItem) return null;
      if (sessionItem.session_status === "closed") return { sessionClosed: true };
      if (context.crew && (
        sessionItem.session_id !== context.crew.sessionId
        || sessionItem.session_status !== "active"
      )) return { crewSessionDenied: true };

      const submissionResult = await client.query(
        `
          SELECT *
          FROM item_submissions
          WHERE id = $1
            AND session_item_id = $2
          FOR UPDATE
        `,
        [request.params.submissionId, sessionItem.id]
      );
      const submission = submissionResult.rows[0];
      if (!submission) return null;
      if (submission.submitted_by !== context.user.id) return { notSubmitter: true };

      if (!["pending", "request_more_info"].includes(submission.review_state)) {
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: "submission.withdrawal_conflicted",
          entityType: "item_submission",
          entityId: submission.id,
          metadata: { currentReviewState: submission.review_state }
        });
        return { staleWithdrawal: true, submission };
      }

      const previousReviewState = submission.review_state;
      const withdrawnResult = await client.query(
        `
          UPDATE item_submissions
          SET review_state = 'withdrawn',
            review_return_route = NULL,
            withdrawn_by = $2,
            withdrawn_at = now()
          WHERE id = $1
            AND submitted_by = $2
            AND review_state IN ('pending', 'request_more_info')
          RETURNING *
        `,
        [submission.id, context.user.id]
      );
      if (!withdrawnResult.rows[0]) return { staleWithdrawal: true, submission };

      await client.query(
        `
          UPDATE evidence_requests
          SET resolved_at = COALESCE(resolved_at, now())
          WHERE submission_id = $1
            AND resolved_at IS NULL
        `,
        [submission.id]
      );

      const itemResult = await client.query(
        `
          UPDATE inventory_session_items
          SET status = 'unchecked',
            direct_verified_by = NULL,
            updated_at = now()
          WHERE id = $1
          RETURNING id, status, assigned_to, updated_at
        `,
        [sessionItem.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "submission.withdrawn",
        entityType: "item_submission",
        entityId: submission.id,
        metadata: { previousReviewState }
      });

      return {
        submission: withdrawnResult.rows[0],
        sessionItem: itemResult.rows[0]
      };
    });

    if (!withdrawn) {
      reply.code(404);
      throw new Error("Submission not found");
    }
    if (withdrawn.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (withdrawn.crewSessionDenied) {
      reply.code(403);
      throw new Error("Crew access is limited to its assigned active session.");
    }
    if (withdrawn.notSubmitter) {
      reply.code(403);
      throw new Error("Only the person who submitted this proof can withdraw it.");
    }
    if (withdrawn.staleWithdrawal) {
      reply.code(409);
      return {
        error: "This proof can no longer be withdrawn because its review state changed.",
        code: "submission_not_actionable",
        conflict: {
          operation: "withdraw",
          currentReviewState: withdrawn.submission?.review_state || null
        },
        submission: withdrawn.submission ? rowToSubmission(withdrawn.submission) : null
      };
    }

    return {
      withdrawn: true,
      submission: rowToSubmission(withdrawn.submission),
      sessionItem: {
        id: withdrawn.sessionItem.id,
        status: withdrawn.sessionItem.status,
        assignedTo: withdrawn.sessionItem.assigned_to,
        updatedAt: withdrawn.sessionItem.updated_at
      }
    };
  });

  route(app, "get", "/api/inventory/review-queue", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const result = await query(
      `
        WITH actionable AS (
          SELECT sub.*, submitter.email AS submitted_by_email, submitter.display_name AS submitted_by_name,
            si.id AS session_item_id,
            si.packet_line,
            si.status AS session_item_status,
            si.expected_qty,
            si.inventory_item_id,
            si.suggested_inventory_item_id,
            si.inventory_match_confirmed_by,
            si.inventory_match_confirmed_at,
            s.id AS session_id,
            s.name AS session_name,
            row_number() OVER (
              PARTITION BY si.id
              ORDER BY
                CASE WHEN sub.review_state = 'pending' THEN 0 ELSE 1 END,
                sub.created_at DESC
            ) AS queue_rank
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          JOIN app_users submitter ON submitter.id = sub.submitted_by
          WHERE s.tenant_id = $1
            AND sub.review_state = 'pending'
            AND s.status <> 'closed'
        )
        SELECT *
        FROM actionable
        WHERE queue_rank = 1
        ORDER BY
          CASE WHEN review_state = 'pending' THEN 0 ELSE 1 END,
          created_at DESC
      `,
      [context.tenant.id]
    );

    const submissions = result.rows.map(row => ({
      ...rowToSubmission(row),
      session: {
        id: row.session_id,
        name: row.session_name
      },
      sessionItem: {
        id: row.session_item_id,
        packetLine: row.packet_line,
        status: row.session_item_status,
        expectedQty: row.expected_qty,
        inventoryItemId: row.inventory_item_id,
        suggestedInventoryItemId: row.suggested_inventory_item_id,
        inventoryMatchConfirmedBy: row.inventory_match_confirmed_by,
        inventoryMatchConfirmedAt: row.inventory_match_confirmed_at,
        inventoryItem: null,
        suggestedInventoryItem: null
      }
    }));

    if (submissions.length) {
      const sessionItemIds = submissions.map(submission => submission.sessionItem.id);
      const historyResult = await query(
        `
          SELECT sub.*, submitter.email AS submitted_by_email, submitter.display_name AS submitted_by_name
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          JOIN app_users submitter ON submitter.id = sub.submitted_by
          WHERE s.tenant_id = $1
            AND si.id = ANY($2::uuid[])
          ORDER BY sub.created_at DESC
        `,
        [context.tenant.id, sessionItemIds]
      );

      const history = historyResult.rows.map(rowToSubmission);
      const historyById = new Map(history.map(submission => [submission.id, submission]));
      const photosResult = await query(
        `
          SELECT *
          FROM submission_photos
          WHERE submission_id = ANY($1::uuid[])
          ORDER BY created_at ASC
        `,
        [history.map(submission => submission.id)]
      );

      photosResult.rows.forEach(row => {
        const submission = historyById.get(row.submission_id);
        if (submission) submission.photos.push(rowToPhoto(row));
      });

      const historyBySessionItemId = new Map();
      history.forEach(historySubmission => {
        const list = historyBySessionItemId.get(historySubmission.sessionItemId) || [];
        list.push(historySubmission);
        historyBySessionItemId.set(historySubmission.sessionItemId, list);
      });

      submissions.forEach(submission => {
        const itemHistory = historyBySessionItemId.get(submission.sessionItem.id) || [];
        const primary = itemHistory.find(historySubmission => historySubmission.id === submission.id);
        submission.photos = primary?.photos || [];
        submission.history = itemHistory;
      });
    }

    const inventoryItemsById = await loadInventoryItemsById(
      context.tenant.id,
      submissions.flatMap(submission => [
        submission.sessionItem.inventoryItemId,
        submission.sessionItem.suggestedInventoryItemId
      ])
    );
    submissions.forEach(submission => {
      submission.sessionItem.inventoryItem = inventoryItemsById.get(submission.sessionItem.inventoryItemId) || null;
      submission.sessionItem.suggestedInventoryItem = inventoryItemsById.get(submission.sessionItem.suggestedInventoryItemId) || null;
    });

    return { submissions };
  });

  route(app, "patch", "/api/submissions/:submissionId/review", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseSubmissionReviewBody(request.body);
    const requestedSavedMediaUploadIds = body.savedMediaUploadIds || [];
    if (new Set(requestedSavedMediaUploadIds).size !== requestedSavedMediaUploadIds.length) {
      throw requestError("Choose each saved photo only once.");
    }
    if (body.savedMediaUploadIds && !body.saveItem) {
      throw requestError("Saved photo choices require saving the approved item.");
    }
    if (body.saveItem && body.decision !== "approved") {
      throw requestError("Only approved proof can be saved for future inventory sessions.");
    }

    const reviewed = await withTransaction(async client => {
      const pointerResult = await client.query(
        `
          SELECT sub.session_item_id
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE sub.id = $1
            AND s.tenant_id = $2
        `,
        [request.params.submissionId, context.tenant.id]
      );
      if (!pointerResult.rows[0]) return null;

      const sessionItemResult = await client.query(
        `
          SELECT si.id,
            si.inventory_item_id,
            si.suggested_inventory_item_id,
            si.expected_qty,
            si.packet_line,
            s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1
            AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [pointerResult.rows[0].session_item_id, context.tenant.id]
      );
      const sessionItem = sessionItemResult.rows[0];
      if (!sessionItem) return null;
      if (sessionItem.session_status === "closed") return { sessionClosed: true };

      const currentResult = await client.query(
        `
          SELECT *
          FROM item_submissions
          WHERE id = $1
            AND session_item_id = $2
          FOR UPDATE
        `,
        [request.params.submissionId, sessionItem.id]
      );

      const current = currentResult.rows[0];
      if (!current) return null;
      current.session_item_id = sessionItem.id;
      if (!["pending", "request_more_info"].includes(current.review_state)) {
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: "submission.review_conflicted",
          entityType: "item_submission",
          entityId: current.id,
          metadata: { currentReviewState: current.review_state }
        });
        return { staleReview: true, submission: current };
      }
      if (body.decision === "approved" && sessionItem.suggested_inventory_item_id) {
        return { unresolvedSuggestion: true };
      }

      let savePlan = null;
      if (body.saveItem) {
        if (current.status !== "found") return { saveRequiresFound: true };
        if (sessionItem.expected_qty != null && Number(sessionItem.expected_qty) !== 1) {
          return { saveRequiresSingleItem: true };
        }

        let inventoryItem = null;
        if (sessionItem.inventory_item_id) {
          const inventoryResult = await client.query(
            `
              SELECT *
              FROM inventory_items
              WHERE id = $1
                AND tenant_id = $2
              FOR UPDATE
            `,
            [sessionItem.inventory_item_id, context.tenant.id]
          );
          inventoryItem = inventoryResult.rows[0] || null;
          if (!inventoryItem) return { invalidInventoryItem: true };
        }

        const currentPhotosResult = await client.query(
          `
            SELECT photo.media_upload_id, upload.storage_key
            FROM submission_photos photo
            JOIN media_uploads upload ON upload.id = photo.media_upload_id
            WHERE photo.submission_id = $1
              AND upload.tenant_id = $2
              AND upload.state = 'attached'
              AND upload.attached_to_type = 'item_submission'
              AND upload.attached_to_id = $1
            ORDER BY photo.created_at, photo.id
          `,
          [current.id, context.tenant.id]
        );
        const currentPhotoIds = currentPhotosResult.rows.map(row => row.media_upload_id);
        const existingReferencesResult = inventoryItem
          ? await client.query(
            `
              SELECT reference.media_upload_id
              FROM inventory_item_media reference
              JOIN media_uploads upload ON upload.id = reference.media_upload_id
              WHERE reference.inventory_item_id = $1
                AND upload.tenant_id = $2
                AND upload.state = 'attached'
              ORDER BY reference.sort_order, reference.created_at, reference.id
              FOR UPDATE OF reference
            `,
            [inventoryItem.id, context.tenant.id]
          )
          : { rows: [] };
        const existingReferenceIds = existingReferencesResult.rows.map(row => row.media_upload_id);
        const selectedMediaUploadIds = body.savedMediaUploadIds === undefined
          ? defaultSavedEvidenceMediaUploadIds(existingReferenceIds)
          : requestedSavedMediaUploadIds;
        const allowedMediaUploadIds = new Set([...currentPhotoIds, ...existingReferenceIds]);
        if (selectedMediaUploadIds.some(id => !allowedMediaUploadIds.has(id))) {
          return { invalidSavedMedia: true };
        }

        if (selectedMediaUploadIds.length) {
          const lockedUploads = await client.query(
            `
              SELECT id
              FROM media_uploads
              WHERE id = ANY($1::uuid[])
                AND tenant_id = $2
                AND state = 'attached'
              ORDER BY id
              FOR UPDATE
            `,
            [selectedMediaUploadIds, context.tenant.id]
          );
          if (lockedUploads.rows.length !== selectedMediaUploadIds.length) {
            return { invalidSavedMedia: true };
          }
          const conflictingReference = await client.query(
            `
              SELECT media_upload_id
              FROM inventory_item_media
              WHERE media_upload_id = ANY($1::uuid[])
                AND ($2::uuid IS NULL OR inventory_item_id <> $2)
              LIMIT 1
              FOR UPDATE
            `,
            [selectedMediaUploadIds, inventoryItem?.id || null]
          );
          if (conflictingReference.rows[0]) return { invalidSavedMedia: true };
        }

        savePlan = {
          inventoryItem,
          selectedMediaUploadIds
        };
      }

      if (body.decision !== "request_more_info") {
        await client.query(
          `
            UPDATE item_submissions
            SET review_state = 'superseded',
              reviewed_at = COALESCE(reviewed_at, now())
            WHERE session_item_id = $1
              AND id <> $2
              AND review_state IN ('pending', 'request_more_info')
          `,
          [current.session_item_id, current.id]
        );

        await client.query(
          `
            UPDATE evidence_requests request
            SET resolved_at = COALESCE(request.resolved_at, now())
            FROM item_submissions sibling
            WHERE request.submission_id = sibling.id
              AND request.resolved_at IS NULL
              AND sibling.session_item_id = $1
              AND (sibling.id = $2 OR sibling.review_state = 'superseded')
          `,
          [current.session_item_id, current.id]
        );
      }

      const result = await client.query(
        `
          UPDATE item_submissions
          SET review_state = $1,
            review_note = $2,
            review_return_route = $3,
            reviewed_by = $4,
            reviewed_at = now()
          WHERE id = $5
            AND review_state IN ('pending', 'request_more_info')
          RETURNING *
        `,
        [
          body.decision,
          body.note || null,
          body.decision === "rejected" ? body.returnAssignment : null,
          context.user.id,
          current.id
        ]
      );

      if (!result.rows[0]) return { staleReview: true, submission: current };
      result.rows[0].session_item_id = current.session_item_id;

      if (body.decision === "approved") {
        await client.query(
          "UPDATE inventory_session_items SET status = 'approved', updated_at = now() WHERE id = $1",
          [result.rows[0].session_item_id]
        );
      } else if (body.decision === "rejected") {
        await client.query(
          `
            UPDATE inventory_session_items
            SET status = 'unchecked',
              direct_verified_by = NULL,
              assigned_to = CASE WHEN $2 = 'submitter' THEN $3 ELSE NULL END,
              assigned_by = CASE WHEN $2 = 'submitter' THEN $4 ELSE NULL END,
              assigned_at = CASE WHEN $2 = 'submitter' THEN now() ELSE NULL END,
              updated_at = now()
            WHERE id = $1
          `,
          [result.rows[0].session_item_id, body.returnAssignment, current.submitted_by, context.user.id]
        );
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: body.returnAssignment === "submitter"
            ? "session_item.assigned"
            : "session_item.assignment_cleared",
          entityType: "inventory_session_item",
          entityId: result.rows[0].session_item_id,
          metadata: {
            assignedTo: body.returnAssignment === "submitter" ? current.submitted_by : null,
            assignedToRole: "submission_return"
          }
        });
      } else {
        await client.query(
          `
            UPDATE inventory_session_items
            SET status = 'needs_review',
              assigned_to = $2,
              assigned_by = $3,
              assigned_at = now(),
              updated_at = now()
            WHERE id = $1
          `,
          [result.rows[0].session_item_id, current.submitted_by, context.user.id]
        );
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: "session_item.assigned",
          entityType: "inventory_session_item",
          entityId: result.rows[0].session_item_id,
          metadata: {
            assignedTo: current.submitted_by,
            assignedToRole: "proof_follow_up"
          }
        });
      }

      let savedInventoryItem = null;
      if (savePlan) {
        if (savePlan.inventoryItem) {
          const savedResult = await client.query(
            `
              UPDATE inventory_items
              SET current_location = COALESCE(NULLIF(btrim($2), ''), current_location),
                serial_number = COALESCE(NULLIF(btrim($3), ''), serial_number),
                last_verified_submission_id = $4,
                last_verified_by = $5,
                last_verified_at = now(),
                legacy_media_metadata = false,
                metadata = $7::jsonb,
                updated_at = now()
              WHERE id = $1
                AND tenant_id = $6
              RETURNING *
            `,
            [
              savePlan.inventoryItem.id,
              current.location_text || "",
              current.serial_number || "",
              current.id,
              context.user.id,
              context.tenant.id,
              JSON.stringify(withoutLegacyInventoryImages(savePlan.inventoryItem.metadata || {}))
            ]
          );
          savedInventoryItem = savedResult.rows[0] || null;
        } else {
          const packetLine = String(sessionItem.packet_line || "Verified inventory item").trim() || "Verified inventory item";
          const lin = [...extractLinValues(packetLine)][0] || null;
          const nsn = [...extractNsnValues(packetLine)][0] || null;
          const savedResult = await client.query(
            `
              INSERT INTO inventory_items (
                tenant_id,
                title,
                army_name,
                lin,
                nsn,
                serial_number,
                current_location,
                created_by,
                last_verified_submission_id,
                last_verified_by,
                last_verified_at
              )
              VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $7, now())
              RETURNING *
            `,
            [
              context.tenant.id,
              packetLine,
              lin,
              nsn,
              current.serial_number || null,
              current.location_text || null,
              context.user.id,
              current.id
            ]
          );
          savedInventoryItem = savedResult.rows[0];
        }

        if (!savedInventoryItem) throw new Error("Saved inventory item update did not return a row.");
        await client.query(
          "DELETE FROM inventory_item_media WHERE inventory_item_id = $1",
          [savedInventoryItem.id]
        );
        for (const [index, mediaUploadId] of savePlan.selectedMediaUploadIds.entries()) {
          await client.query(
            `
              INSERT INTO inventory_item_media (inventory_item_id, media_upload_id, sort_order)
              VALUES ($1, $2, $3)
            `,
            [savedInventoryItem.id, mediaUploadId, index]
          );
        }
        await client.query(
          `
            UPDATE inventory_session_items
            SET inventory_item_id = $2,
              suggested_inventory_item_id = NULL,
              inventory_match_confirmed_by = $3,
              inventory_match_confirmed_at = now(),
              location_hint = COALESCE(location_hint, NULLIF(btrim($4), '')),
              updated_at = now()
            WHERE id = $1
          `,
          [sessionItem.id, savedInventoryItem.id, context.user.id, current.location_text || ""]
        );
        await createAuditEvent(client, {
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: "inventory_item.verified",
          entityType: "inventory_item",
          entityId: savedInventoryItem.id,
          metadata: {
            submissionId: current.id,
            sessionItemId: sessionItem.id,
            photoCount: savePlan.selectedMediaUploadIds.length,
            created: !savePlan.inventoryItem
          }
        });
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "submission.reviewed",
        entityType: "item_submission",
        entityId: result.rows[0].id,
        metadata: {
          decision: body.decision,
          note: body.note || null,
          returnAssignment: body.returnAssignment || null
        }
      });

      return { submission: result.rows[0], savedInventoryItem };
    });

    if (!reviewed) {
      reply.code(404);
      throw new Error("Submission not found");
    }
    if (reviewed.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (reviewed.staleReview) {
      reply.code(409);
      return {
        error: reviewed.submission?.review_state === "withdrawn"
          ? "The submitter withdrew this proof before it could be reviewed."
          : "This proof has already been reviewed or replaced.",
        code: "submission_not_actionable",
        conflict: {
          operation: "review",
          currentReviewState: reviewed.submission?.review_state || null
        },
        submission: reviewed.submission ? rowToSubmission(reviewed.submission) : null
      };
    }
    if (reviewed.unresolvedSuggestion) {
      reply.code(409);
      throw new Error("Confirm or dismiss the suggested saved item before approving this proof.");
    }
    if (reviewed.saveRequiresFound) {
      reply.code(409);
      throw new Error("Only found proof can be saved for future inventory sessions.");
    }
    if (reviewed.saveRequiresSingleItem) {
      reply.code(409);
      throw new Error("Save individual items only when the packet quantity is one.");
    }
    if (reviewed.invalidInventoryItem) {
      reply.code(409);
      throw new Error("The saved inventory item is no longer available.");
    }
    if (reviewed.invalidSavedMedia) {
      reply.code(400);
      throw new Error("Choose saved photos from this item or the proof being approved.");
    }

    const submission = reviewed.submission;

    if (body.decision === "request_more_info") {
      runNotification("Proof request", () => notifySubmitterOfProofRequest(context, submission.id, body.note));
    }

    const savedMediaByItemId = reviewed.savedInventoryItem
      ? await loadInventoryItemMedia([reviewed.savedInventoryItem.id])
      : new Map();
    return {
      submission,
      savedItem: reviewed.savedInventoryItem
        ? rowToInventoryItem(
          reviewed.savedInventoryItem,
          savedMediaByItemId.get(reviewed.savedInventoryItem.id) || []
        )
        : null
    };
  });

  route(app, "post", "/api/submissions/:submissionId/evidence-requests", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        message: z.string().min(2),
        requestedFields: z.array(z.string()).default([])
      }),
      request.body
    );

    const evidenceRequest = await withTransaction(async client => {
      const pointerResult = await client.query(
        `
          SELECT sub.session_item_id
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE sub.id = $1 AND s.tenant_id = $2
        `,
        [request.params.submissionId, context.tenant.id]
      );
      if (!pointerResult.rows[0]) return null;

      const sessionItemResult = await client.query(
        `
          SELECT si.id, s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1
            AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [pointerResult.rows[0].session_item_id, context.tenant.id]
      );
      const sessionItem = sessionItemResult.rows[0];
      if (!sessionItem) return null;
      if (sessionItem.session_status === "closed") return { sessionClosed: true };

      const submissionResult = await client.query(
        `
          SELECT id, submitted_by, review_state
          FROM item_submissions
          WHERE id = $1
            AND session_item_id = $2
          FOR UPDATE
        `,
        [request.params.submissionId, sessionItem.id]
      );

      const submission = submissionResult.rows[0];
      if (!submission) return null;
      submission.session_item_id = sessionItem.id;
      if (!["pending", "request_more_info"].includes(submission.review_state)) {
        return { staleReview: true };
      }

      const result = await client.query(
        `
          INSERT INTO evidence_requests (submission_id, requested_by, message, requested_fields)
          VALUES ($1, $2, $3, $4::jsonb)
          RETURNING *
        `,
        [request.params.submissionId, context.user.id, body.message, JSON.stringify(body.requestedFields)]
      );

      await client.query(
        `
          UPDATE item_submissions
          SET review_state = 'request_more_info',
            review_note = $2,
            reviewed_by = $3,
            reviewed_at = now()
          WHERE id = $1
        `,
        [request.params.submissionId, body.message, context.user.id]
      );

      await client.query(
        `
          UPDATE inventory_session_items
          SET status = 'needs_review',
            assigned_to = $2,
            assigned_by = $3,
            assigned_at = now(),
            updated_at = now()
          WHERE id = $1
        `,
        [submission.session_item_id, submission.submitted_by, context.user.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "session_item.assigned",
        entityType: "inventory_session_item",
        entityId: submission.session_item_id,
        metadata: {
          assignedTo: submission.submitted_by,
          assignedToRole: "proof_follow_up"
        }
      });

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "evidence_request.created",
        entityType: "evidence_request",
        entityId: result.rows[0].id,
        metadata: { requestedFields: body.requestedFields, message: body.message }
      });

      return result.rows[0];
    });

    if (!evidenceRequest) {
      reply.code(404);
      throw new Error("Submission not found");
    }
    if (evidenceRequest.sessionClosed) {
      reply.code(409);
      throw new Error("Closed sessions are read-only.");
    }
    if (evidenceRequest.staleReview) {
      reply.code(409);
      throw new Error("This proof has already been reviewed or replaced.");
    }

    runNotification("Evidence request", () => notifySubmitterOfProofRequest(context, request.params.submissionId, body.message));

    reply.code(201);
    return { evidenceRequest };
  });

  registerErrorHandler(app);
}
