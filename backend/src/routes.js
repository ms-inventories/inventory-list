import { z } from "zod";
import { authContext } from "./auth.js";
import { query, withTransaction } from "./db.js";
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

async function createAuditEvent(client, { tenantId, actorUserId, action, entityType, entityId, metadata = {} }) {
  await client.query(
    `
      INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [tenantId, actorUserId, action, entityType, entityId, JSON.stringify(metadata)]
  );
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

  route(app, "post", "/api/platform/tenants", async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply);
    const body = parseBody(
      z.object({
        name: z.string().min(2),
        slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
        hostname: z.string().min(4).optional()
      }),
      request.body
    );

    const tenant = await withTransaction(async client => {
      const tenantResult = await client.query(
        "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name, status",
        [body.slug, body.name]
      );
      const created = tenantResult.rows[0];

      if (body.hostname) {
        await client.query(
          "INSERT INTO tenant_domains (tenant_id, hostname, is_primary) VALUES ($1, $2, true)",
          [created.id, body.hostname.toLowerCase()]
        );
      }

      await createAuditEvent(client, {
        tenantId: created.id,
        actorUserId: auth.user.id,
        action: "tenant.created",
        entityType: "tenant",
        entityId: created.id,
        metadata: { slug: body.slug, hostname: body.hostname || null }
      });

      return created;
    });

    reply.code(201);
    return { tenant: rowToTenant(tenant) };
  });

  route(app, "get", "/api/tenant", async (request, reply) => {
    const context = await requireTenantContext(request, reply, ["tenant_admin", "contributor", "viewer"]);
    return {
      tenant: rowToTenant(context.tenant),
      membership: context.membership
    };
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

    return { sessions: result.rows };
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
    return { session };
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
