import "dotenv/config";
import { config } from "./config.js";
import { closePool, query } from "./db.js";

function hostForSlug(slug) {
  return `${slug}.${config.baseDomain}`;
}

async function upsertUser({ subject, email, displayName }) {
  const result = await query(
    `
      INSERT INTO app_users (authentik_subject, email, display_name, last_seen_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (email) DO UPDATE SET
        authentik_subject = EXCLUDED.authentik_subject,
        display_name = EXCLUDED.display_name,
        last_seen_at = now()
      RETURNING id, email, display_name
    `,
    [subject, email, displayName]
  );
  return result.rows[0];
}

async function upsertTenant({ slug, name }) {
  const tenantResult = await query(
    `
      INSERT INTO tenants (slug, name, status)
      VALUES ($1, $2, 'active')
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        status = 'active'
      RETURNING id, slug, name
    `,
    [slug, name]
  );
  const tenant = tenantResult.rows[0];

  await query(
    `
      INSERT INTO tenant_domains (tenant_id, hostname, is_primary)
      VALUES ($1, $2, true)
      ON CONFLICT (hostname) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        is_primary = EXCLUDED.is_primary
    `,
    [tenant.id, hostForSlug(slug)]
  );

  return tenant;
}

async function upsertMembership({ tenantId, userId, role }) {
  await query(
    `
      INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        role = EXCLUDED.role,
        status = 'active'
    `,
    [tenantId, userId, role]
  );
}

async function upsertInventoryItem(tenantId, item) {
  const existing = await query(
    `
      SELECT id
      FROM inventory_items
      WHERE tenant_id = $1 AND title = $2
      LIMIT 1
    `,
    [tenantId, item.title]
  );

  if (existing.rows[0]) {
    const result = await query(
      `
        UPDATE inventory_items
        SET common_name = $2,
            army_name = $3,
            lin = $4,
            nsn = $5,
            description = $6,
            current_location = $7,
            metadata = $8,
            updated_at = now()
        WHERE id = $1
        RETURNING id
      `,
      [
        existing.rows[0].id,
        item.commonName,
        item.armyName,
        item.lin,
        item.nsn,
        item.description,
        item.currentLocation,
        item.metadata || {}
      ]
    );
    return result.rows[0];
  }

  const result = await query(
    `
      INSERT INTO inventory_items (
        tenant_id, title, common_name, army_name, lin, nsn, description, current_location, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `,
    [
      tenantId,
      item.title,
      item.commonName,
      item.armyName,
      item.lin,
      item.nsn,
      item.description,
      item.currentLocation,
      item.metadata || {}
    ]
  );
  return result.rows[0];
}

async function upsertSession({ tenantId, createdBy, name }) {
  const existing = await query(
    `
      SELECT id
      FROM inventory_sessions
      WHERE tenant_id = $1 AND name = $2
      LIMIT 1
    `,
    [tenantId, name]
  );

  if (existing.rows[0]) {
    await query("UPDATE inventory_sessions SET status = 'active' WHERE id = $1", [existing.rows[0].id]);
    return existing.rows[0];
  }

  const result = await query(
    `
      INSERT INTO inventory_sessions (tenant_id, name, status, packet_source, created_by)
      VALUES ($1, $2, 'active', 'QA seed packet', $3)
      RETURNING id
    `,
    [tenantId, name, createdBy]
  );
  return result.rows[0];
}

async function upsertSessionItem({ sessionId, inventoryItemId, packetLine, expectedQty, locationHint, status = "unchecked" }) {
  const existing = await query(
    `
      SELECT id
      FROM inventory_session_items
      WHERE session_id = $1 AND packet_line = $2
      LIMIT 1
    `,
    [sessionId, packetLine]
  );

  if (existing.rows[0]) {
    await query(
      `
        UPDATE inventory_session_items
        SET inventory_item_id = $2,
            expected_qty = $3,
            location_hint = $4,
            status = $5,
            updated_at = now()
        WHERE id = $1
      `,
      [existing.rows[0].id, inventoryItemId, expectedQty, locationHint, status]
    );
    return existing.rows[0];
  }

  const result = await query(
    `
      INSERT INTO inventory_session_items (
        session_id, inventory_item_id, packet_line, expected_qty, location_hint, status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [sessionId, inventoryItemId, packetLine, expectedQty, locationHint, status]
  );
  return result.rows[0];
}

async function upsertSubmission({ sessionItemId, submittedBy, status, locationText, note, serialNumber }) {
  const existing = await query(
    `
      SELECT id
      FROM item_submissions
      WHERE session_item_id = $1 AND submitted_by = $2
      LIMIT 1
    `,
    [sessionItemId, submittedBy]
  );

  if (existing.rows[0]) return existing.rows[0];

  const result = await query(
    `
      INSERT INTO item_submissions (
        session_item_id, submitted_by, status, location_text, note, serial_number, review_state
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING id
    `,
    [sessionItemId, submittedBy, status, locationText, note, serialNumber]
  );
  return result.rows[0];
}

async function seedTenantGuidance(tenantId, updatedBy) {
  const body = [
    "Inventory guidance",
    "",
    "- Start with the packet line and search by LIN, NSN, serial, or the plain item name.",
    "- Check the location hint and any existing photos before asking for help.",
    "- Take a wide photo first, then serial number or data plate photos when available.",
    "- If an item does not match the packet line, submit it as a mismatch and add a short note.",
    "- If you are unsure, submit what you found and ask the platoon admin to review it."
  ].join("\n");

  await query(
    `
      INSERT INTO tenant_guidance (tenant_id, body, updated_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id) DO UPDATE SET
        body = EXCLUDED.body,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `,
    [tenantId, body, updatedBy]
  );
}

async function seedTenantSettings(tenantId, updatedBy) {
  await query(
    `
      INSERT INTO tenant_settings (tenant_id, notification_preferences, updated_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id) DO UPDATE SET
        notification_preferences = EXCLUDED.notification_preferences,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `,
    [tenantId, {
      proof_submitted: true,
      proof_requests: true,
      open_rows: true,
      packet_imports: true,
      session_closed: true,
      email_proof_submitted: true,
      email_proof_requests: true
    }, updatedBy]
  );
}

async function seedSearchTenant({ tenant, root, searchAdmin, searchHelper, legacyLead, legacyNco }) {
  await query(
    `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id IN ($2, $3)`,
    [tenant.id, legacyLead.id, legacyNco.id]
  );
  await upsertMembership({ tenantId: tenant.id, userId: searchAdmin.id, role: "tenant_admin" });
  await upsertMembership({ tenantId: tenant.id, userId: searchHelper.id, role: "contributor" });

  const radio = await upsertInventoryItem(tenant.id, {
    title: "Search Radio",
    commonName: "Field Radio",
    armyName: "RADIO SET SEARCH FIXTURE",
    lin: "R20684",
    nsn: "5820015244763",
    description: "Search fixture tactical radio and handset.",
    currentLocation: "Cage Alpha, left shelf"
  });
  const generator = await upsertInventoryItem(tenant.id, {
    title: "Search Generator",
    commonName: "Quiet Generator",
    armyName: "GENERATOR SET DIESEL SEARCH FIXTURE",
    lin: "G18358",
    nsn: "6115015476713",
    description: "Search fixture generator with power cables.",
    currentLocation: "Connex Bravo, floor"
  });
  const session = await upsertSession({
    tenantId: tenant.id,
    createdBy: root.id,
    name: "Search behavior fixture"
  });
  const radioRow = await upsertSessionItem({
    sessionId: session.id,
    inventoryItemId: radio.id,
    packetLine: "000009148 R20684 RADIO SET SEARCH FIXTURE",
    expectedQty: 1,
    locationHint: "Cage Alpha, left shelf",
    status: "needs_review"
  });
  await upsertSessionItem({
    sessionId: session.id,
    inventoryItemId: generator.id,
    packetLine: "000018603 G18358 GENERATOR SET SEARCH FIXTURE",
    expectedQty: 1,
    locationHint: "Connex Bravo, floor",
    status: "unchecked"
  });
  await upsertSubmission({
    sessionItemId: radioRow.id,
    submittedBy: searchHelper.id,
    status: "found",
    locationText: "Cage Alpha, left shelf",
    note: "Search proof note: handset and battery counted.",
    serialNumber: "SEARCH-SERIAL-20684"
  });

  await seedTenantGuidance(tenant.id, root.id);
  await seedTenantSettings(tenant.id, root.id);
}

async function seedNewsletter(rootUserId) {
  await query(
    `
      INSERT INTO newsletter_subscribers (
        email, display_name, platoon, supervisor_name, status, reviewed_by, reviewed_at, review_note
      )
      VALUES (
        'qa-family@example.com', 'QA Family Member', 'MS', 'QA Platoon Admin',
        'active', $1, now(), 'Seeded approved subscriber'
      )
      ON CONFLICT (email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        platoon = EXCLUDED.platoon,
        supervisor_name = EXCLUDED.supervisor_name,
        status = EXCLUDED.status,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        review_note = EXCLUDED.review_note,
        updated_at = now()
    `,
    [rootUserId]
  );

  const contentBlocks = [
    {
      blockType: "announcement",
      title: "Family readiness updates",
      summary: "General updates for Black Shadow Company families will be posted here.",
      body: "Newsletter admins can replace this with current public-facing updates.",
      sortOrder: 10
    },
    {
      blockType: "event",
      title: "Community check-in",
      summary: "A simple reminder for upcoming family readiness touchpoints.",
      body: "Family readiness reminders and community check-ins can be posted here.",
      sortOrder: 20
    },
    {
      blockType: "resource",
      title: "Family resources",
      summary: "Helpful public resources and contact notes can be linked here.",
      body: "Keep public content broad and family-focused.",
      href: "https://www.nationalguard.mil/Resources/Family-Programs/",
      linkLabel: "Open resource",
      sortOrder: 30
    }
  ];

  for (const block of contentBlocks) {
    const updated = await query(
      `
        UPDATE frg_content_blocks
        SET summary = $3,
          body = $4,
          href = $5,
          link_label = $6,
          sort_order = $7,
          status = 'published',
          updated_by = $8,
          published_at = COALESCE(published_at, now()),
          updated_at = now()
        WHERE block_type = $1 AND title = $2
      `,
      [
        block.blockType,
        block.title,
        block.summary,
        block.body,
        block.href || null,
        block.linkLabel || null,
        block.sortOrder,
        rootUserId
      ]
    );

    if (updated.rowCount) continue;

    await query(
      `
        INSERT INTO frg_content_blocks (
          block_type, title, summary, body, href, link_label, sort_order, status,
          created_by, updated_by, published_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, 'published', $8, $8, now()
        WHERE NOT EXISTS (
          SELECT 1
          FROM frg_content_blocks
          WHERE block_type = $1 AND title = $2
        )
      `,
      [
        block.blockType,
        block.title,
        block.summary,
        block.body,
        block.href || null,
        block.linkLabel || null,
        block.sortOrder,
        rootUserId
      ]
    );
  }

  const existingIssue = await query(
    "SELECT id FROM newsletter_issues WHERE title = ANY($1::text[]) LIMIT 1",
    [["Black Shadow QA Update", "Black Shadow Family Update"]]
  );
  if (existingIssue.rows[0]) {
    await query(
      `
        UPDATE newsletter_issues
        SET title = 'Black Shadow Family Update',
          edition_label = 'Family update',
          summary = 'A short public update for Black Shadow families.',
          body = 'Thanks for checking in with Black Shadow Company. Family readiness reminders, upcoming events, and helpful resources will be shared here as they are published.',
          status = 'published',
          published_by = $2,
          published_at = COALESCE(published_at, now()),
          updated_at = now()
        WHERE id = $1
      `,
      [existingIssue.rows[0].id, rootUserId]
    );
    return;
  }

  await query(
    `
      INSERT INTO newsletter_issues (
        title, edition_label, summary, body, status, created_by, published_by, published_at
      )
      VALUES (
        'Black Shadow Family Update',
        'Family update',
        'A short public update for Black Shadow families.',
        'Thanks for checking in with Black Shadow Company. Family readiness reminders, upcoming events, and helpful resources will be shared here as they are published.',
        'published',
        $1,
        $1,
        now()
      )
    `,
    [rootUserId]
  );
}

async function main() {
  if (config.env === "production") {
    throw new Error("Refusing to seed QA data in production");
  }

  const root = await upsertUser({
    subject: "qa-root",
    email: "qa-root@876en.test",
    displayName: "QA Root Admin"
  });
  const lead = await upsertUser({
    subject: "qa-lead",
    email: "qa-lead@876en.test",
    displayName: "QA Platoon Admin"
  });
  const nco = await upsertUser({
    subject: "qa-nco",
    email: "qa-nco@876en.test",
    displayName: "QA NCO"
  });
  const searchAdmin = await upsertUser({
    subject: "qa-search-admin",
    email: "qa-search-admin@876en.test",
    displayName: "QA Search Admin"
  });
  const searchHelper = await upsertUser({
    subject: "qa-search-helper",
    email: "qa-search-helper@876en.test",
    displayName: "QA Search Helper"
  });
  await upsertUser({
    subject: "qa-frg",
    email: "qa-frg@876en.test",
    displayName: "QA Newsletter Admin"
  });

  const tenant = await upsertTenant({ slug: "ms", name: "MS Platoon" });
  const isolationTenant = await upsertTenant({ slug: "qa-other", name: "QA Isolation Tenant" });
  const settingsDesktopTenant = await upsertTenant({ slug: "qa-settings-desktop", name: "QA Settings Desktop" });
  const settingsMobileTenant = await upsertTenant({ slug: "qa-settings-mobile", name: "QA Settings Mobile" });
  const searchDesktopTenant = await upsertTenant({ slug: "qa-search-desktop", name: "QA Search Desktop" });
  const searchMobileTenant = await upsertTenant({ slug: "qa-search-mobile", name: "QA Search Mobile" });
  await upsertMembership({ tenantId: tenant.id, userId: lead.id, role: "tenant_admin" });
  await upsertMembership({ tenantId: tenant.id, userId: nco.id, role: "contributor" });

  const items = [
    {
      title: "PRC Radio",
      commonName: "PRC Radio",
      armyName: "RADIO SET: AN/PRC",
      lin: "R20684",
      nsn: "5820015244763",
      description: "Handheld tactical radio with accessories.",
      currentLocation: "Cage 2, left shelf"
    },
    {
      title: "Generator",
      commonName: "Generator",
      armyName: "GENERATOR SET DIESEL ENGINE",
      lin: "G18358",
      nsn: "6115015476713",
      description: "Portable generator set.",
      currentLocation: "Connex B, floor"
    },
    {
      title: "M4 Optic",
      commonName: "M4 Optic",
      armyName: "SIGHT REFLEX COLLIMATOR",
      lin: "M150",
      nsn: "1240015251648",
      description: "Rifle optic in protective case.",
      currentLocation: "Cage 3, right side"
    },
    {
      title: "Tool Kit",
      commonName: "Tool Kit",
      armyName: "TOOL KIT CARPENTERS: ENGINEER SQUAD",
      lin: "W34648",
      nsn: "5180003923175",
      description: "Engineer squad carpenter tool kit.",
      currentLocation: "Connex B, top shelf"
    }
  ];

  const seededItems = [];
  for (const item of items) {
    seededItems.push(await upsertInventoryItem(tenant.id, item));
  }

  const session = await upsertSession({
    tenantId: tenant.id,
    createdBy: lead.id,
    name: "July sensitive items"
  });

  const sessionRows = [
    {
      inventoryItemId: seededItems[0].id,
      packetLine: "000009148 R20684 RADIAC SET: AN/VDR-2",
      expectedQty: 1,
      locationHint: "Cage 2, left shelf",
      status: "needs_review"
    },
    {
      inventoryItemId: seededItems[1].id,
      packetLine: "0000186033 M05000 TAMPER,VIBRATING TYPE,INTERNAL COMBUST",
      expectedQty: 2,
      locationHint: "Connex B, floor"
    },
    {
      inventoryItemId: seededItems[2].id,
      packetLine: "000004336 N96248 NAVIGATION SET: SATELLITE SIGNALS AN/PSN",
      expectedQty: 4,
      locationHint: "Cage 3, right side"
    },
    {
      inventoryItemId: seededItems[3].id,
      packetLine: "000002115 W34648 TOOL KIT CARPENTERS: ENGINEER SQUAD",
      expectedQty: 1,
      locationHint: "Connex B, top shelf"
    }
  ];

  const firstSessionItem = await upsertSessionItem({ sessionId: session.id, ...sessionRows[0] });
  for (const row of sessionRows.slice(1)) {
    await upsertSessionItem({ sessionId: session.id, ...row });
  }

  await upsertSubmission({
    sessionItemId: firstSessionItem.id,
    submittedBy: nco.id,
    status: "found",
    locationText: "Cage 2, left shelf",
    note: "Found with radio accessories.",
    serialNumber: "QA-PRC-001"
  });

  await seedTenantGuidance(tenant.id, lead.id);
  await seedTenantGuidance(settingsDesktopTenant.id, root.id);
  await seedTenantGuidance(settingsMobileTenant.id, root.id);
  await seedTenantSettings(tenant.id, lead.id);
  await seedTenantSettings(isolationTenant.id, root.id);
  await seedTenantSettings(settingsDesktopTenant.id, root.id);
  await seedTenantSettings(settingsMobileTenant.id, root.id);
  await seedSearchTenant({
    tenant: searchDesktopTenant,
    root,
    searchAdmin,
    searchHelper,
    legacyLead: lead,
    legacyNco: nco
  });
  await seedSearchTenant({
    tenant: searchMobileTenant,
    root,
    searchAdmin,
    searchHelper,
    legacyLead: lead,
    legacyNco: nco
  });
  await seedNewsletter(root.id);

  console.log("QA seed complete: root, MS workspace, isolation/settings/search tenants, session rows, review item, tenant guidance/settings, and newsletter content are ready");
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
