import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authContext, exchangeOidcCode } from "./auth.js";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import {
  isEmailConfigured,
  sendNewsletterIssueEmail,
  sendNewsletterSubscriberReviewEmail,
  sendProofRequestEmail,
  sendProofSubmittedEmail,
  sendTenantInviteEmail
} from "./email.js";
import { hasTenantRole, tenantContext } from "./tenant.js";

const tenantRoles = ["tenant_admin", "contributor", "viewer"];
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

function safeStorageKey(key) {
  const normalized = String(key || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return "";
  return normalized;
}

function buildMediaUrl(storageKey) {
  const safeKey = safeStorageKey(storageKey);
  if (!safeKey) return "";
  const base = String(config.storage.publicMediaBaseUrl || "/media").replace(/\/+$/, "");
  return `${base}/${safeKey}`;
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
  await fs.writeFile(absolutePath, buffer);
  return storageKey;
}

async function saveUploadedImage(tenant, body) {
  const { buffer, extension } = parseImagePayload(body);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const fileName = `${crypto.randomUUID()}${extension}`;
  const storageKey = `tenants/${tenant.slug}/submissions/${month}/${fileName}`;
  return saveBufferToStorage(storageKey, buffer);
}

async function savePacketImportSource(tenant, body) {
  const { buffer, extension } = parseFilePayload(body, packetSourceMimeTypes, 10 * 1024 * 1024);
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const fileName = `${crypto.randomUUID()}${extension}`;
  const storageKey = `tenants/${tenant.slug}/packet-imports/${month}/${fileName}`;
  return saveBufferToStorage(storageKey, buffer);
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
  if (slug) return `https://${slug}.${config.baseDomain}`;
  return config.publicAppUrl;
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

function registerErrorHandler(app) {
  app.use((error, request, response, next) => {
    console.error(error);

    if (error instanceof z.ZodError) {
      response.status(400).json(badRequestFromZod(error));
      return;
    }

    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    response.status(statusCode).json({
      error: statusCode >= 500 ? "Internal server error" : error.message
    });
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

  route(app, "get", "/api/me", async (request, reply) => {
    const context = await requireContext(request, reply);

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
      membership: context.membership
    };
  });

  route(app, "get", "/api/newsletter/public", async () => {
    const latestResult = await query(
      `
        SELECT *
        FROM newsletter_issues
        WHERE status = 'published'
        ORDER BY published_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `
    );
    const recentResult = await query(
      `
        SELECT *
        FROM newsletter_issues
        WHERE status = 'published'
        ORDER BY published_at DESC NULLS LAST, created_at DESC
        LIMIT 5
      `
    );

    return {
      latestIssue: rowToNewsletterIssue(latestResult.rows[0], { includeBody: true }),
      issues: recentResult.rows.map(row => rowToNewsletterIssue(row))
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

    const [issueResult, statsResult, subscriberResult] = await Promise.all([
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
          SELECT *
          FROM newsletter_subscribers
          ORDER BY
            CASE status
              WHEN 'pending' THEN 0
              WHEN 'active' THEN 1
              WHEN 'rejected' THEN 2
              ELSE 3
            END,
            updated_at DESC
          LIMIT 40
        `
      )
    ]);

    return {
      issues: issueResult.rows.map(row => rowToNewsletterIssue(row, { includeBody: true })),
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
      subscribers: subscriberResult.rows.map(rowToNewsletterSubscriber)
    };
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
      membership: context.membership
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
        metadata: z.record(z.unknown()).optional()
      }),
      request.body
    );

    const item = await withTransaction(async client => {
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

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "inventory_item.created",
        entityType: "inventory_item",
        entityId: result.rows[0].id
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
        entityId: result.rows[0].id
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
          verifier.email AS direct_verified_by_email
        FROM inventory_session_items si
        LEFT JOIN inventory_items ii ON ii.id = si.inventory_item_id
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
        metadata: { status: body.status || null }
      });

      return result.rows[0];
    });

    if (!updated) {
      reply.code(404);
      throw new Error("Session not found");
    }

    return { session: rowToSession(updated) };
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

    let matchedItem = null;
    if (!body.inventoryItemId && body.packetLine) {
      const inventoryResult = await query(
        `
          SELECT id, title, common_name, army_name, lin, nsn, description, current_location
          FROM inventory_items
          WHERE tenant_id = $1
        `,
        [context.tenant.id]
      );
      matchedItem = findInventoryItemMatch(body.packetLine, inventoryResult.rows.map(itemMatchProfile))?.item || null;
    }

    const result = await query(
      `
        INSERT INTO inventory_session_items (session_id, inventory_item_id, packet_line, expected_qty, location_hint)
        SELECT s.id, $2, $3, $4, $5
        FROM inventory_sessions s
        WHERE s.id = $1 AND s.tenant_id = $6
        RETURNING *
      `,
      [
        request.params.sessionId,
        body.inventoryItemId || matchedItem?.id || null,
        body.packetLine || null,
        body.expectedQty ?? null,
        body.locationHint || matchedItem?.current_location || null,
        context.tenant.id
      ]
    );

    if (!result.rows[0]) {
      reply.code(404);
      throw new Error("Session not found");
    }

    reply.code(201);
    return { sessionItem: result.rows[0] };
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

    const created = await withTransaction(async client => {
      const sessionResult = await client.query(
        "SELECT id FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1",
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
        const sourceStorageKey = body.importBatch?.sourceFile
          ? await savePacketImportSource(context.tenant, body.importBatch.sourceFile)
          : null;
        const batchResult = await client.query(
          `
            INSERT INTO packet_import_batches (
              tenant_id,
              session_id,
              source_name,
              source_mime_type,
              source_storage_key,
              extracted_text,
              row_count,
              created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
          `,
          [
            context.tenant.id,
            request.params.sessionId,
            body.importBatch?.sourceName || body.importBatch?.sourceFile?.fileName || null,
            body.importBatch?.sourceMimeType || body.importBatch?.sourceFile?.mimeType || null,
            sourceStorageKey,
            body.importBatch?.extractedText || null,
            body.items.length,
            context.user.id
          ]
        );
        importBatch = batchResult.rows[0];
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
          count: rows.length,
          matchedCount,
          importBatchId: importBatch?.id || null,
          sourceName: body.importBatch?.sourceName || null
        }
      });

      return { rows, importBatch };
    });

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
        fileName: z.string().optional(),
        mimeType: z.enum([...imageMimeTypes.keys()]),
        dataUrl: z.string().optional(),
        base64: z.string().optional(),
        caption: z.string().optional(),
        kind: z.enum(photoKinds).default("general")
      }),
      request.body
    );

    const storageKey = await saveUploadedImage(context.tenant, body);

    return {
      photo: {
        storageKey,
        url: buildMediaUrl(storageKey),
        caption: body.caption || null,
        kind: body.kind
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
          storageKey: z.string().min(8),
          caption: z.string().optional(),
          kind: z.enum(photoKinds).default("general")
        })).max(8).optional()
      }),
      request.body
    );

    const submission = await withTransaction(async client => {
      const sessionItemResult = await client.query(
        `
          SELECT si.id, si.packet_line, s.name AS session_name
          FROM inventory_session_items si
          JOIN inventory_sessions s ON s.id = si.session_id
          WHERE si.id = $1 AND s.tenant_id = $2
        `,
        [request.params.sessionItemId, context.tenant.id]
      );

      if (!sessionItemResult.rows[0]) return null;

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

      const photos = body.photos || [];
      for (const photo of photos) {
        const storageKey = safeStorageKey(photo.storageKey);
        if (!storageKey.startsWith(`tenants/${context.tenant.slug}/`)) {
          const error = new Error("Photo does not belong to this tenant");
          error.statusCode = 400;
          throw error;
        }

        await client.query(
          `
            INSERT INTO submission_photos (submission_id, storage_key, caption, kind)
            VALUES ($1, $2, $3, $4)
          `,
          [result.rows[0].id, storageKey, photo.caption || null, photo.kind || "general"]
        );
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
        metadata: { status: body.status, photoIds: body.photoIds || [], photoCount: photos.length }
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
