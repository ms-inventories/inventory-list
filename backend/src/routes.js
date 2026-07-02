import crypto from "node:crypto";
import { z } from "zod";
import { authContext } from "./auth.js";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { sendTenantInviteEmail } from "./email.js";
import { hasTenantRole, tenantContext } from "./tenant.js";

const tenantRoles = ["tenant_admin", "contributor", "viewer"];
const itemStatuses = ["unchecked", "found", "not_found", "mismatch", "needs_review", "approved"];
const submissionStatuses = ["found", "not_found", "mismatch", "needs_review"];
const reviewDecisions = ["approved", "request_more_info", "rejected"];

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
    status: row.status
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
    itemCount: row.item_count,
    foundCount: row.found_count,
    needsReviewCount: row.needs_review_count,
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
      currentLocation: row.current_location
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
    createdAt: row.created_at
  };
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

export function registerRoutes(app) {
  route(app, "get", "/health", async () => ({ ok: true }));

  route(app, "get", "/api/me", async (request, reply) => {
    const context = await requireContext(request, reply);

    return {
      user: context.user,
      groups: context.identity.groups,
      isPlatformAdmin: context.identity.isPlatformAdmin,
      tenant: rowToTenant(context.tenant),
      membership: context.membership
    };
  });

  route(app, "get", "/api/platform/tenants", async (request, reply) => {
    await requirePlatformAdmin(request, reply);

    const result = await query(
      `
        SELECT t.id, t.slug, t.name, t.status,
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
        "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name, status",
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
    let emailResult;
    try {
      emailResult = await sendTenantInviteEmail({
        to: email,
        tenantName: context.tenant.name,
        role: body.role,
        inviteUrl,
        invitedByName: context.user.display_name || context.user.email
      });
    } catch (error) {
      console.error("invite email failed", error);
      emailResult = { sent: false, reason: "send_failed" };
    }

    reply.code(201);
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
      const result = await client.query(
        `
          UPDATE tenant_invitations
          SET status = 'revoked', revoked_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
          RETURNING *
        `,
        [request.params.invitationId, context.tenant.id]
      );

      if (!result.rows[0]) return null;

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "invitation.revoked",
        entityType: "tenant_invitation",
        entityId: result.rows[0].id
      });

      return result.rows[0];
    });

    if (!revoked) {
      reply.code(404);
      throw new Error("Pending invitation not found");
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
          ii.current_location,
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
    submissionsResult.rows.forEach(row => {
      const item = itemById.get(row.session_item_id);
      if (item) item.submissions.push(rowToSubmission(row));
    });

    return {
      session: rowToSession(session),
      items
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
        body.inventoryItemId || null,
        body.packetLine || null,
        body.expectedQty ?? null,
        body.locationHint || null,
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
          expectedQty: z.number().int().nonnegative().optional(),
          locationHint: z.string().optional()
        })).min(1).max(250)
      }),
      request.body
    );

    const created = await withTransaction(async client => {
      const sessionResult = await client.query(
        "SELECT id FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 LIMIT 1",
        [request.params.sessionId, context.tenant.id]
      );

      if (!sessionResult.rows[0]) return null;

      const rows = [];
      for (const item of body.items) {
        const result = await client.query(
          `
            INSERT INTO inventory_session_items (session_id, packet_line, expected_qty, location_hint)
            VALUES ($1, $2, $3, $4)
            RETURNING *
          `,
          [
            request.params.sessionId,
            item.packetLine.trim(),
            item.expectedQty ?? null,
            item.locationHint || null
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
        metadata: { count: rows.length }
      });

      return rows;
    });

    if (!created) {
      reply.code(404);
      throw new Error("Session not found");
    }

    reply.code(201);
    return { sessionItems: created };
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
        photoIds: z.array(z.string().uuid()).optional()
      }),
      request.body
    );

    const submission = await withTransaction(async client => {
      const sessionItemResult = await client.query(
        `
          SELECT si.id
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
        metadata: { status: body.status, photoIds: body.photoIds || [] }
      });

      return result.rows[0];
    });

    if (!submission) {
      reply.code(404);
      throw new Error("Session item not found");
    }

    reply.code(201);
    return { submission };
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
          SELECT sub.id
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
        "UPDATE item_submissions SET review_state = 'request_more_info' WHERE id = $1",
        [request.params.submissionId]
      );

      await createAuditEvent(client, {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "evidence_request.created",
        entityType: "evidence_request",
        entityId: result.rows[0].id,
        metadata: { requestedFields: body.requestedFields }
      });

      return result.rows[0];
    });

    if (!evidenceRequest) {
      reply.code(404);
      throw new Error("Submission not found");
    }

    reply.code(201);
    return { evidenceRequest };
  });

  registerErrorHandler(app);
}
