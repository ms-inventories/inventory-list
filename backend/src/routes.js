import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authenticate, authContext, ensureUser, exchangeOidcCode } from "./auth.js";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import {
  buildMediaUrl,
  issueMediaSession,
  mediaStorageKeyFromUrl,
  normalizeMediaStorageKey
} from "./media.js";
import {
  isEmailConfigured,
  sendNewsletterIssueEmail,
  sendNewsletterSubscriberReviewEmail,
  sendProofRequestEmail,
  sendProofSubmittedEmail,
  sendTenantInviteEmail
} from "./email.js";
import { hasTenantRole, tenantContext, tenantSlugFromHost } from "./tenant.js";

const tenantRoles = ["tenant_admin", "contributor", "viewer"];
const memberStatuses = ["active", "disabled"];
const itemStatuses = ["unchecked", "found", "not_found", "mismatch", "needs_review", "approved"];
const submissionStatuses = ["found", "not_found", "mismatch", "needs_review"];
const reviewDecisions = ["approved", "request_more_info", "rejected"];
const photoKinds = ["general", "serial", "location", "damage"];
const newsletterIssueSchema = z.object({
  title: z.string().min(2).max(160),
  editionLabel: z.string().max(80).optional(),
  summary: z.string().max(600).optional(),
  body: z.string().min(10).max(10000)
});
const newsletterTestSendSchema = z.object({
  email: z.string().email()
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

function rowToMember(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at
  };
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

function getTenantGroupSlugs(identity) {
  const prefix = String(config.oidc.tenantGroupPrefix || "876en-").toLowerCase();
  const reserved = new Set([
    "876en",
    "876en-admins",
    "876en-frg-admins",
    "876en-platoon-admin",
    String(config.oidc.platformAdminGroup || "").toLowerCase(),
    String(config.oidc.frgAdminGroup || "").toLowerCase(),
    String(config.oidc.tenantAdminGroup || "").toLowerCase()
  ].filter(Boolean));

  return [...new Set((identity?.groups || [])
    .map(group => String(group || "").trim().toLowerCase())
    .filter(group => group.startsWith(prefix) && !reserved.has(group))
    .map(group => group.slice(prefix.length))
    .filter(slug => /^[a-z0-9-]+$/.test(slug)))]
    .sort();
}

async function listUserWorkspaces(identity, user) {
  if (!user?.id) return [];

  if (identity?.isPlatformAdmin) {
    const result = await query(
      `
        SELECT id, slug, name, status, 'tenant_admin' AS role, 'platform_admin' AS source
        FROM tenants
        WHERE status = 'active'
        ORDER BY name, slug
      `
    );
    return result.rows.map(rowToWorkspace);
  }

  const groupSlugs = getTenantGroupSlugs(identity);
  const hasTenantAdminGroup = (identity?.groups || [])
    .map(group => String(group || "").trim().toLowerCase())
    .includes(String(config.oidc.tenantAdminGroup || "").toLowerCase());

  const result = await query(
    `
      SELECT DISTINCT ON (t.slug)
        t.id,
        t.slug,
        t.name,
        t.status,
        COALESCE(
          m.role,
          CASE WHEN $3::boolean THEN 'tenant_admin' ELSE 'contributor' END
        ) AS role,
        CASE WHEN m.id IS NULL THEN 'authentik' ELSE 'database' END AS source
      FROM tenants t
      LEFT JOIN tenant_memberships m
        ON m.tenant_id = t.id
       AND m.user_id = $1
       AND m.status = 'active'
      WHERE t.status = 'active'
        AND (
          m.id IS NOT NULL
          OR t.slug = ANY($2::text[])
        )
      ORDER BY t.slug, m.id NULLS LAST
    `,
    [user.id, groupSlugs, hasTenantAdminGroup]
  );

  return result.rows.map(rowToWorkspace);
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

function rowToInventoryItem(row) {
  return {
    id: row.id,
    title: row.title,
    commonName: row.common_name,
    armyName: row.army_name,
    lin: row.lin,
    nsn: row.nsn,
    description: row.description,
    currentLocation: row.current_location,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSession(row) {
  if (!row) return null;
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
    closedAt: row.closed_at
  };
}

function rowToSessionItem(row) {
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
}

function rowToReportItem(row) {
  const item = {
    id: row.id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    sessionStatus: row.session_status,
    sessionCreatedAt: row.session_created_at,
    sessionClosedAt: row.session_closed_at,
    inventoryItemId: row.inventory_item_id,
    packetLine: row.packet_line,
    expectedQty: row.expected_qty,
    locationHint: row.location_hint,
    status: row.item_status,
    assignedTo: row.assigned_to,
    assignedToEmail: row.assigned_to_email,
    assignedToName: row.assigned_to_name,
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
      reviewedBy: row.latest_reviewed_by,
      reviewedAt: row.latest_reviewed_at,
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
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    photos: []
  };
}

function rowToPhoto(row) {
  return {
    id: row.id,
    submissionId: row.submission_id,
    storageKey: row.storage_key,
    url: buildMediaUrl(row.storage_key),
    caption: row.caption,
    kind: row.kind,
    createdAt: row.created_at
  };
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

async function getTenantNotificationPreferences(tenantId, client = null) {
  const runQuery = client ? client.query.bind(client) : query;
  const result = await runQuery(
    "SELECT notification_preferences FROM tenant_settings WHERE tenant_id = $1 LIMIT 1",
    [tenantId]
  );
  return normalizeTenantNotificationPreferences(result.rows[0]?.notification_preferences);
}

function tenantSettingsResponse(context, row = {}) {
  const tenantGroup = `${config.oidc.tenantGroupPrefix}${context.tenant.slug}`.toLowerCase();
  return {
    displayName: row.name || context.tenant.name,
    defaultGuidance: row.guidance_body || "",
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
      previousRole: auditText(metadata.previousRole, 80),
      previousStatus: auditText(metadata.previousStatus, 80),
      role: auditText(metadata.role, 80),
      status: auditText(metadata.status, 80)
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
      note: auditText(metadata.note)
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

async function lockStagedMediaUpload(client, {
  uploadId,
  tenantId,
  userId,
  purpose,
  canUseAnyUploader = false
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
  await verifyRegisteredUploadFile(upload);
  return upload;
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
  const preferences = await getTenantNotificationPreferences(context.tenant.id);
  if (!preferences.email_proof_submitted) return;
  const recipients = await getTenantAdminRecipients(context.tenant.id, context.user.id);
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

async function requireContext(request, reply, roles = []) {
  const auth = await authContext(request, reply);
  const context = await tenantContext(request, auth);

  if (roles.length && !hasTenantRole(context, roles)) {
    reply.code(403);
    throw new Error("Tenant access denied");
  }

  return context;
}

async function requireTenantContext(request, reply, roles = []) {
  const context = await requireContext(request, reply, roles);

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
  route(app, "get", "/health", async () => ({ ok: true }));

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

    return exchangeOidcCode(body);
  });

  route(app, "get", "/api/auth/health", async (request, reply) => getAuthHealth(request, reply));

  route(app, "get", "/api/me", async (request, reply) => {
    const context = await requireContext(request, reply);
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
        email: z.string().email(),
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
        email: z.string().email()
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
          LIMIT 40
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
          LIMIT 200
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
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    return { issue: rowToNewsletterIssue(updated, { includeBody: true }) };
  });

  route(app, "post", "/api/newsletter/admin/issues/:issueId/publish", async (request, reply) => {
    const auth = await requireFrgAdmin(request, reply);

    const published = await withTransaction(async client => {
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

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: null,
        actorUserId: auth.user.id,
        action: "newsletter.issue.published",
        entityType: "newsletter_issue",
        entityId: result.rows[0].id,
        metadata: { title: result.rows[0].title }
      });

      return result.rows[0];
    });

    if (!published) {
      reply.code(404);
      throw new Error("Newsletter issue not found");
    }

    const delivery = await deliverNewsletterIssue(published);
    return { issue: rowToNewsletterIssue(published, { includeBody: true }), delivery };
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

  route(app, "get", "/api/platform/tenants", async (request, reply) => {
    await requirePlatformAdmin(request, reply);

    const result = await query(
      `
        SELECT t.id, t.slug, t.name, t.status, t.created_at,
          COUNT(m.id)::int AS member_count,
          COUNT(m.id) FILTER (WHERE m.role = 'tenant_admin' AND m.status = 'active')::int AS admin_count
        FROM tenants t
        LEFT JOIN tenant_memberships m ON m.tenant_id = t.id
        GROUP BY t.id
        ORDER BY t.slug ASC
      `
    );

    return {
      tenants: result.rows.map(row => ({
        ...rowToTenant(row),
        memberCount: row.member_count,
        adminCount: row.admin_count
      }))
    };
  });

  route(app, "post", "/api/platform/tenants", async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply);
    const body = parseBody(
      z.object({
        name: z.string().min(2),
        slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
        hostname: z.string().min(4).optional(),
        adminEmail: z.string().email().optional(),
        adminDisplayName: z.string().optional()
      }),
      request.body
    );

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
        const userResult = await client.query(
          `
            INSERT INTO app_users (email, display_name)
            VALUES ($1, $2)
            ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, app_users.display_name)
            RETURNING id, email, display_name
          `,
          [body.adminEmail.toLowerCase(), body.adminDisplayName || null]
        );
        const adminUser = userResult.rows[0];

        const membershipResult = await client.query(
          `
            INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
            VALUES ($1, $2, 'tenant_admin', 'active', $3)
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'tenant_admin', status = 'active'
            RETURNING id, tenant_id, user_id, role, status, created_at
          `,
          [tenant.id, adminUser.id, auth.user.id]
        );

        adminMembership = {
          ...membershipResult.rows[0],
          email: adminUser.email,
          display_name: adminUser.display_name
        };
      }

      await createAuditEvent(client, {
        tenantId: tenant.id,
        actorUserId: auth.user.id,
        action: "tenant.created",
        entityType: "tenant",
        entityId: tenant.id,
        metadata: { slug: body.slug, hostname, adminEmail: body.adminEmail || null }
      });

      return { tenant, adminMembership };
    });

    reply.code(201);
    return {
      tenant: rowToTenant(created.tenant),
      adminMembership: created.adminMembership ? rowToMember(created.adminMembership) : null
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
        ...(body.notificationPreferences || {})
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
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
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
          AND sub.review_state = 'request_more_info'
        ORDER BY COALESCE(sub.reviewed_at, sub.created_at) DESC
        LIMIT 5
      `,
      [context.tenant.id, context.user.id]
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
          AND si.status = 'unchecked'
        GROUP BY s.id, s.name
        HAVING count(si.id) > 0
        ORDER BY unchecked_count DESC, updated_at DESC
        LIMIT 3
      `,
      [context.tenant.id]
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
          AND status = 'closed'
          AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 2
      `,
      [context.tenant.id]
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
          u.email, u.display_name
        FROM tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
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

    return { members: result.rows.map(rowToMember) };
  });

  route(app, "post", "/api/tenant/members", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        email: z.string().email(),
        displayName: z.string().optional(),
        role: z.enum(tenantRoles)
      }),
      request.body
    );

    const member = await withTransaction(async client => {
      const userResult = await client.query(
        `
          INSERT INTO app_users (email, display_name)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, app_users.display_name)
          RETURNING id, email, display_name
        `,
        [body.email.toLowerCase(), body.displayName || null]
      );
      const user = userResult.rows[0];

      const memberResult = await client.query(
        `
          INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
          VALUES ($1, $2, $3, 'active', $4)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
          RETURNING id, tenant_id, user_id, role, status, created_at
        `,
        [context.tenant.id, user.id, body.role, context.user.id]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.added",
        entityType: "tenant_membership",
        entityId: memberResult.rows[0].id,
        metadata: { email: body.email.toLowerCase(), role: body.role }
      });

      return { ...memberResult.rows[0], email: user.email, displayName: user.display_name };
    });

    reply.code(201);
    return { member };
  });

  route(app, "patch", "/api/tenant/members/:memberId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const memberId = z.string().uuid().parse(request.params.memberId);
    const body = parseBody(
      z.object({
        role: z.enum(tenantRoles).optional(),
        status: z.enum(memberStatuses).optional()
      }).refine(value => value.role || value.status, {
        message: "Provide a role or status change"
      }),
      request.body
    );

    const member = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
            u.email, u.display_name
          FROM tenant_memberships m
          JOIN app_users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.id = $2
          FOR UPDATE OF m
        `,
        [context.tenant.id, memberId]
      );

      const current = currentResult.rows[0];
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }

      const nextRole = body.role || current.role;
      const nextStatus = body.status || current.status;
      if ((nextRole !== "tenant_admin" || nextStatus !== "active")) {
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
        [context.tenant.id, memberId, nextRole, nextStatus]
      );

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
          status: nextStatus
        }
      });

      return updateResult.rows[0];
    });

    return { member: rowToMember(member) };
  });

  route(app, "post", "/api/tenant/members/:memberId/disable", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const memberId = z.string().uuid().parse(request.params.memberId);

    const member = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT m.id, m.tenant_id, m.user_id, m.role, m.status, m.created_at,
            u.email, u.display_name
          FROM tenant_memberships m
          JOIN app_users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.id = $2
          FOR UPDATE OF m
        `,
        [context.tenant.id, memberId]
      );

      const current = currentResult.rows[0];
      if (!current) {
        reply.code(404);
        throw new Error("Member not found");
      }

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

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "member.disabled",
        entityType: "tenant_membership",
        entityId: memberId,
        metadata: { email: current.email, role: current.role, previousStatus: current.status }
      });

      return updateResult.rows[0];
    });

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
        email: z.string().email(),
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
      const userResult = await client.query(
        `
          INSERT INTO app_users (email, display_name)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, app_users.display_name)
          RETURNING id, email, display_name
        `,
        [email, body.displayName || null]
      );
      const user = userResult.rows[0];

      await client.query(
        `
          INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
          VALUES ($1, $2, $3, 'invited', $4)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET
            role = EXCLUDED.role,
            status = CASE
              WHEN tenant_memberships.status = 'active' THEN 'active'
              ELSE 'invited'
            END,
            invited_by = EXCLUDED.invited_by
        `,
        [context.tenant.id, user.id, body.role, context.user.id]
      );

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

      if (invite.email !== auth.user.email && !auth.identity.isPlatformAdmin) {
        return { forbidden: true };
      }

      const membershipResult = await client.query(
        `
          INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by)
          VALUES ($1, $2, $3, 'active', $4)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
          RETURNING id, tenant_id, user_id, role, status, created_at
        `,
        [invite.tenant_id, auth.user.id, invite.role, invite.invited_by]
      );

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
          display_name: auth.user.display_name
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
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    const result = await query(
      `
        SELECT *
        FROM inventory_items
        WHERE tenant_id = $1
        ORDER BY title ASC
      `,
      [context.tenant.id]
    );

    return { items: result.rows.map(rowToInventoryItem) };
  });

  route(app, "get", "/api/inventory/reports", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const [sessionResult, rowResult] = await Promise.all([
      query(
        `
          SELECT session.*,
            COUNT(item.id)::int AS item_count,
            COUNT(item.id) FILTER (WHERE item.status IN ('found', 'approved'))::int AS found_count,
            COUNT(item.id) FILTER (WHERE item.status = 'needs_review')::int AS needs_review_count
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
            item.created_at,
            item.updated_at,
            session.name AS session_name,
            session.status AS session_status,
            session.created_at AS session_created_at,
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
            latest.id AS latest_submission_id,
            latest.submitted_by AS latest_submitted_by,
            latest.status AS latest_submission_status,
            latest.location_text AS latest_location_text,
            latest.note AS latest_note,
            latest.serial_number AS latest_serial_number,
            latest.review_state AS latest_review_state,
            latest.review_note AS latest_review_note,
            latest.reviewed_by AS latest_reviewed_by,
            latest.reviewed_at AS latest_reviewed_at,
            latest.created_at AS latest_created_at,
            submitter.email AS latest_submitted_by_email,
            submitter.display_name AS latest_submitted_by_name
          FROM inventory_session_items item
          JOIN inventory_sessions session ON session.id = item.session_id
          LEFT JOIN inventory_items inventory ON inventory.id = item.inventory_item_id
          LEFT JOIN app_users assignee ON assignee.id = item.assigned_to
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
        description: z.string().optional(),
        currentLocation: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        mediaUploadIds: z.array(z.string().uuid()).max(8).optional()
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
            (tenant_id, title, common_name, army_name, lin, nsn, description, current_location, metadata, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
          RETURNING *
        `,
        [
          context.tenant.id,
          body.title,
          body.commonName || null,
          body.armyName || null,
          body.lin || null,
          body.nsn || null,
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
    return { item: rowToInventoryItem(item) };
  });

  route(app, "get", "/api/inventory/sessions", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    const result = await query(
      `
        SELECT s.*,
          COUNT(si.id)::int AS item_count,
          COUNT(si.id) FILTER (WHERE si.status IN ('found', 'approved'))::int AS found_count,
          COUNT(si.id) FILTER (WHERE si.status = 'needs_review')::int AS needs_review_count
        FROM inventory_sessions s
        LEFT JOIN inventory_session_items si ON si.session_id = s.id
        WHERE s.tenant_id = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `,
      [context.tenant.id]
    );

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
          INSERT INTO inventory_sessions (tenant_id, name, packet_source, status, created_by)
          VALUES ($1, $2, $3, $4, $5)
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

  route(app, "get", "/api/inventory/sessions/:sessionId", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    const sessionResult = await query(
      `
        SELECT s.*,
          COUNT(si.id)::int AS item_count,
          COUNT(si.id) FILTER (WHERE si.status IN ('found', 'approved'))::int AS found_count,
          COUNT(si.id) FILTER (WHERE si.status = 'needs_review')::int AS needs_review_count
        FROM inventory_sessions s
        LEFT JOIN inventory_session_items si ON si.session_id = s.id
        WHERE s.id = $1 AND s.tenant_id = $2
        GROUP BY s.id
        LIMIT 1
      `,
      [request.params.sessionId, context.tenant.id]
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
          ii.metadata AS item_metadata,
          assigned.email AS assigned_to_email,
          assigned.display_name AS assigned_to_name,
          assigner.email AS assigned_by_email,
          assigner.display_name AS assigned_by_name,
          verifier.email AS direct_verified_by_email
        FROM inventory_session_items si
        LEFT JOIN inventory_items ii ON ii.id = si.inventory_item_id
        LEFT JOIN app_users assigned ON assigned.id = si.assigned_to
        LEFT JOIN app_users assigner ON assigner.id = si.assigned_by
        LEFT JOIN app_users verifier ON verifier.id = si.direct_verified_by
        WHERE si.session_id = $1
        ORDER BY si.created_at ASC
      `,
      [session.id]
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

    const items = itemsResult.rows.map(rowToSessionItem);
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
      const result = await client.query(
        `
          UPDATE inventory_sessions
          SET
            name = COALESCE($1, name),
            status = COALESCE($2, status),
            closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END
          WHERE id = $3 AND tenant_id = $4
          RETURNING *
        `,
        [body.name || null, body.status || null, request.params.sessionId, context.tenant.id]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_session.updated",
        entityType: "inventory_session",
        entityId: result.rows[0].id,
        metadata: {
          sessionName: result.rows[0].name,
          status: body.status || null
        }
      });

      return result.rows[0];
    });

    if (!updated) {
      reply.code(404);
      throw new Error("Session not found");
    }

    return { session: rowToSession(updated) };
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

      let matchedItem = null;
      if (!body.inventoryItemId && body.packetLine) {
        const inventoryResult = await client.query(
          `
            SELECT id, title, common_name, army_name, lin, nsn, description, current_location
            FROM inventory_items
            WHERE tenant_id = $1
          `,
          [context.tenant.id]
        );
        matchedItem = findInventoryItemMatch(body.packetLine, inventoryResult.rows.map(itemMatchProfile))?.item || null;
      }

      const result = await client.query(
        `
          INSERT INTO inventory_session_items (session_id, inventory_item_id, packet_line, expected_qty, location_hint)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [
          session.id,
          body.inventoryItemId || matchedItem?.id || null,
          body.packetLine || null,
          body.expectedQty ?? null,
          body.locationHint || matchedItem?.current_location || null
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
          locationHint: sessionItem.location_hint
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
      for (const item of body.items) {
        const matchedItem = item.inventoryItemId
          ? null
          : findInventoryItemMatch(item.packetLine, matchableInventoryItems)?.item || null;
        const inventoryItemId = item.inventoryItemId || matchedItem?.id || null;
        const locationHint = item.locationHint || matchedItem?.current_location || null;
        if (inventoryItemId) matchedCount += 1;

        const result = importBatch
          ? await client.query(
            `
              INSERT INTO inventory_session_items (session_id, inventory_item_id, packet_line, expected_qty, location_hint, import_batch_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING *
            `,
            [
              request.params.sessionId,
              inventoryItemId,
              item.packetLine.trim(),
              item.expectedQty ?? null,
              locationHint,
              importBatch.id
            ]
          )
          : await client.query(
            `
              INSERT INTO inventory_session_items (session_id, inventory_item_id, packet_line, expected_qty, location_hint)
              VALUES ($1, $2, $3, $4, $5)
              RETURNING *
            `,
            [
              request.params.sessionId,
              inventoryItemId,
              item.packetLine.trim(),
              item.expectedQty ?? null,
              locationHint
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

        return { rows, importBatch };
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
      importBatch: created.importBatch ? rowToImportBatch(created.importBatch, { includeText: true }) : null
    };
  });

  route(app, "post", "/api/uploads/photos", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor"]);
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

    const stored = await saveUploadedImage(context.tenant, body);
    let upload;
    try {
      upload = await withTransaction(async client => {
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
              staged_expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 hour'))
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
            config.storage.mediaUploadStagingTtlHours
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

  route(app, "patch", "/api/session-items/:sessionItemId/assignment", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor"]);
    const body = parseBody(
      z.object({
        memberId: z.union([z.string().uuid(), z.literal("self")]).nullable().optional()
      }),
      request.body
    );
    const canManageAssignments = hasTenantRole(context, ["tenant_admin"]);
    const isSelfAssignment = body.memberId === "self";
    const requestedMemberId = isSelfAssignment ? null : body.memberId || null;

    if (!canManageAssignments && !isSelfAssignment) {
      reply.code(403);
      throw new Error("Contributors can only claim rows for themselves.");
    }

    const updated = await withTransaction(async client => {
      const currentResult = await client.query(
        `
          SELECT si.id, si.assigned_to, s.status AS session_status
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
        status: z.enum(itemStatuses),
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

      const result = await client.query(
        `
          UPDATE inventory_session_items si
          SET status = $1, direct_verified_by = $2, updated_at = now()
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
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor"]);
    const body = parseBody(
      z.object({
        status: z.enum(submissionStatuses),
        locationText: z.string().optional(),
        note: z.string().optional(),
        serialNumber: z.string().optional(),
        photoIds: z.array(z.string().uuid()).optional(),
        photos: z.array(z.object({
          uploadId: z.string().uuid(),
          caption: z.string().optional(),
          kind: z.enum(photoKinds).default("general")
        })).max(8).optional()
      }),
      request.body
    );
    const photos = body.photos || [];
    const photoUploadIds = photos.map(photo => photo.uploadId);
    if (new Set(photoUploadIds).size !== photoUploadIds.length) {
      throw requestError("Each photo upload can only be attached once.");
    }

    const submission = await withTransaction(async client => {
      const sessionItemResult = await client.query(
        `
          SELECT si.id, si.packet_line, s.name AS session_name, s.status AS session_status
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1 AND s.tenant_id = $2
          FOR UPDATE OF si, s
        `,
        [request.params.sessionItemId, context.tenant.id]
      );

      if (!sessionItemResult.rows[0]) return null;
      if (sessionItemResult.rows[0].session_status === "closed") return { sessionClosed: true };

      const lockedUploads = new Map();
      for (const uploadId of [...photoUploadIds].sort()) {
        const upload = await lockStagedMediaUpload(client, {
          uploadId,
          tenantId: context.tenant.id,
          userId: context.user.id,
          purpose: "evidence",
          canUseAnyUploader: hasTenantRole(context, ["tenant_admin"])
        });
        lockedUploads.set(upload.id, upload);
      }

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
          SET status = 'needs_review', updated_at = now()
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

    runNotification("Proof submission", () => notifyTenantAdminsOfSubmission(context, submission, {
      photoCount: (body.photos || []).length
    }));

    reply.code(201);
    return { submission };
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
            AND sub.review_state IN ('pending', 'request_more_info')
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
        status: row.session_item_status
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

    return { submissions };
  });

  route(app, "patch", "/api/submissions/:submissionId/review", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin"]);
    const body = parseBody(
      z.object({
        decision: z.enum(reviewDecisions),
        note: z.string().optional()
      }),
      request.body
    );

    const submission = await withTransaction(async client => {
      const result = await client.query(
        `
          UPDATE item_submissions sub
          SET review_state = $1, review_note = $2, reviewed_by = $3, reviewed_at = now()
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE sub.session_item_id = si.id
            AND sub.id = $4
            AND s.tenant_id = $5
          RETURNING sub.*, si.id AS session_item_id
        `,
        [body.decision, body.note || null, context.user.id, request.params.submissionId, context.tenant.id]
      );

      if (!result.rows[0]) return null;

      if (body.decision === "approved") {
        await client.query(
          "UPDATE inventory_session_items SET status = 'approved', updated_at = now() WHERE id = $1",
          [result.rows[0].session_item_id]
        );
      } else if (body.decision === "request_more_info") {
        await client.query(
          "UPDATE inventory_session_items SET status = 'needs_review', updated_at = now() WHERE id = $1",
          [result.rows[0].session_item_id]
        );
      }

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "submission.reviewed",
        entityType: "item_submission",
        entityId: result.rows[0].id,
        metadata: { decision: body.decision, note: body.note || null }
      });

      return result.rows[0];
    });

    if (!submission) {
      reply.code(404);
      throw new Error("Submission not found");
    }

    if (body.decision === "request_more_info") {
      runNotification("Proof request", () => notifySubmitterOfProofRequest(context, submission.id, body.note));
    }

    return { submission };
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
      const submissionResult = await client.query(
        `
          SELECT sub.id, si.id AS session_item_id
          FROM item_submissions sub
          JOIN inventory_session_items si ON si.id = sub.session_item_id
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE sub.id = $1 AND s.tenant_id = $2
        `,
        [request.params.submissionId, context.tenant.id]
      );

      if (!submissionResult.rows[0]) return null;

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
        "UPDATE inventory_session_items SET status = 'needs_review', updated_at = now() WHERE id = $1",
        [submissionResult.rows[0].session_item_id]
      );

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

    runNotification("Evidence request", () => notifySubmitterOfProofRequest(context, request.params.submissionId, body.message));

    reply.code(201);
    return { evidenceRequest };
  });

  registerErrorHandler(app);
}
