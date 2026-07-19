import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ORIGIN,
  API_ORIGIN,
  AUTHENTIK_ORIGIN,
  appRequest,
  oidcAccessToken,
  requiredEnv
} from "./production-auth-session.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const verifyOnly = process.argv.includes("--verify");
const repair = process.argv.includes("--repair");
if (apply && verifyOnly) throw new Error("Choose either --apply or --verify.");
if (repair && !apply) throw new Error("--repair must be used with --apply.");

const tenantDefinitions = [
  { slug: "demo-1st", name: "[Demo] 1st Platoon", accent: "Alpha" },
  { slug: "demo-2nd", name: "[Demo] 2nd Platoon", accent: "Bravo" },
  { slug: "demo-maint", name: "[Demo] Maintenance Platoon", accent: "Maintenance" }
];
const historicalSessionName = "[Demo] Previous inventory - June";
const activeSessionDefinitions = [
  { name: "[Demo] Active hand receipt inventory", variant: "hand-receipt" },
  { name: "[Demo] Active motor pool spot check", variant: "spot-check" }
];
const defaultGuidance = [
  "Demo workspace for testing Shadow Tracer.",
  "Claim an unclaimed row, add proof, and use the saved-item relationship information shown in the queue.",
  "Equipment details, names, locations, serials, and images are test data. Setup audit history may show the administrator who created the demo fixture."
].join("\n\n");
const notificationPreferences = Object.freeze({
  proof_submitted: true,
  proof_requests: true,
  open_rows: true,
  packet_imports: true,
  session_closed: true,
  email_proof_submitted: false,
  email_proof_requests: false
});
function exactOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be an absolute origin URL.`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${label} must contain only a scheme, host, and optional port.`);
  }
  return parsed.origin;
}

function controlledEmail(value, label = "MVP_DEMO_EMAIL_BASE") {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || /[\s\u0000-\u001f\u007f]/.test(email)) {
    throw new Error(`${label} must be a valid email address no longer than 254 characters.`);
  }
  const parts = email.split("@");
  if (parts.length !== 2) throw new Error(`${label} must contain one @ separator.`);
  const [local, domain] = parts;
  if (
    !local
    || local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[a-z0-9.!#$%&'*+/=?^_{}|~-]+$/i.test(local)
  ) {
    throw new Error(`${label} has an invalid email local part.`);
  }
  if (!domain || domain.length > 253 || !domain.includes(".")) {
    throw new Error(`${label} must use a fully qualified domain name.`);
  }
  const labels = domain.split(".");
  if (
    labels.some(part => !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))
    || !/^[a-z]{2,63}$/i.test(labels.at(-1))
  ) {
    throw new Error(`${label} has an invalid email domain.`);
  }
  return email;
}

const apiOrigin = exactOrigin(API_ORIGIN, "MVP_API_ORIGIN");
const authentikOrigin = exactOrigin(AUTHENTIK_ORIGIN, "MVP_AUTHENTIK_ORIGIN");
const adminOrigin = exactOrigin(ADMIN_ORIGIN, "MVP_ADMIN_ORIGIN");
const productionOrigins = Object.freeze({
  api: "https://api.876en.org",
  authentik: "https://auth.876en.org",
  admin: "https://admin.876en.org"
});
const usesProductionOrigins = apiOrigin === productionOrigins.api
  && authentikOrigin === productionOrigins.authentik
  && adminOrigin === productionOrigins.admin;
const nonProductionOriginOverride = `ALLOW NON-PRODUCTION ORIGINS API=${apiOrigin} AUTH=${authentikOrigin} ADMIN=${adminOrigin}`;
if (!usesProductionOrigins && process.env.MVP_CONFIRM_NON_PRODUCTION_ORIGINS !== nonProductionOriginOverride) {
  throw new Error(`Non-production origins require MVP_CONFIRM_NON_PRODUCTION_ORIGINS=${nonProductionOriginOverride}`);
}

const defaultManifestPath = path.join(os.homedir(), ".shadow-tracer-private", "production-demo-manifest.json");
const explicitManifestPath = String(process.env.MVP_DEMO_MANIFEST_PATH || "").trim();
const manifestPath = path.resolve(explicitManifestPath || defaultManifestPath);
if (!explicitManifestPath && /(?:^|[\\/])onedrive(?:[\\/]|$)/i.test(manifestPath)) {
  throw new Error("The default demo manifest path resolves inside OneDrive; set MVP_DEMO_MANIFEST_PATH to a private local path.");
}
const manifestLockPath = `${manifestPath}.lock`;
const adminUsername = requiredEnv("MVP_ADMIN_USERNAME");
const adminPassword = requiredEnv("MVP_ADMIN_PASSWORD");
const skipMembers = String(process.env.MVP_DEMO_SKIP_MEMBERS || "").toLowerCase() === "true";
const emailBase = skipMembers ? "" : controlledEmail(process.env.MVP_DEMO_EMAIL_BASE);
const confirmationVerb = repair ? "REPAIR" : "CREATE";
const confirmationRecipient = skipMembers ? "WITHOUT MEMBERS" : `FOR ${emailBase}`;
const expectedConfirmation = `${confirmationVerb} ${tenantDefinitions.map(tenant => tenant.slug).join(",")} ${confirmationRecipient} VIA ${apiOrigin}`;

if (apply && process.env.MVP_CONFIRM_PRODUCTION_DEMO !== expectedConfirmation) {
  throw new Error(`MVP_CONFIRM_PRODUCTION_DEMO must equal ${expectedConfirmation}`);
}
const token = await oidcAccessToken(adminUsername, adminPassword);
const me = await appRequest("/api/me", { token });
if (me?.isPlatformAdmin !== true) throw new Error("Demo seed operator is not a platform administrator.");

function plusAddress(email, tag) {
  const separator = email.lastIndexOf("@");
  if (separator < 1) throw new Error("Demo email base must be a valid email address.");
  const local = email.slice(0, separator).replace(/\+.*/, "");
  return controlledEmail(`${local}+shadow-${tag}${email.slice(separator)}`, `Generated ${tag} demo alias`);
}

const demoMembers = skipMembers ? [] : [
  { email: plusAddress(emailBase, "leader"), displayName: "Demo Platoon Leader", role: "tenant_admin" },
  { email: plusAddress(emailBase, "specialist"), displayName: "Demo Inventory Specialist", role: "contributor" },
  { email: plusAddress(emailBase, "observer"), displayName: "Demo Read-only Observer", role: "viewer" }
];

async function tenantRequest(slug, requestPath, options = {}) {
  return appRequest(requestPath, { ...options, token, tenantSlug: slug });
}

async function readManifest() {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Demo manifest must contain a JSON object.");
    }
    if (parsed.invites !== undefined && !Array.isArray(parsed.invites)) {
      throw new Error("Demo manifest invites must be an array.");
    }
    return { ...parsed, version: 1, invites: parsed.invites || [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, invites: [] };
    throw error;
  }
}

async function writeManifest(manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  let writeError = null;
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close();
  }
  if (writeError) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw writeError;
  }
  try {
    await fs.rename(temporaryPath, manifestPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  await fs.chmod(manifestPath, 0o600).catch(error => {
    console.error(`WARNING: could not enforce owner-only mode on ${manifestPath}: ${error?.code || "unknown error"}`);
  });
}

async function preflightManifest() {
  const directory = path.dirname(manifestPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(error => {
    console.error(`WARNING: could not enforce owner-only mode on ${directory}: ${error?.code || "unknown error"}`);
  });
  const directoryStat = await fs.stat(directory);
  if (!directoryStat.isDirectory()) throw new Error(`Demo manifest parent is not a directory: ${directory}`);
  await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
  try {
    await fs.access(manifestPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const probePath = `${manifestPath}.preflight-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.open(probePath, "wx", 0o600);
  try {
    await handle.writeFile("Shadow Tracer production demo manifest write check.\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    await fs.rm(probePath, { force: true });
  }

  console.error(`WARNING: ${manifestPath} stores plaintext one-time crew codes and invite tokens.`);
  console.error("Keep this file private, do not copy it into logs or source control, and revoke its passes when demo testing ends.");
  console.error("The script requests owner-only file mode, but effective access controls vary by operating system and synchronized folder.");
}

async function acquireManifestLock() {
  let handle;
  try {
    handle = await fs.open(manifestLockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Another demo seed may be running, or a stale lock needs review: ${manifestLockPath}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiOrigin })}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(manifestLockPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function releaseManifestLock(handle) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await fs.rm(manifestLockPath, { force: true });
}

async function loadPlatformTenants() {
  return (await appRequest("/api/platform/tenants", { token })).tenants || [];
}

async function ensureTenant(definition) {
  const matches = (await loadPlatformTenants()).filter(tenant => tenant.slug === definition.slug);
  if (matches.length > 1) throw new Error(`Duplicate workspace slug ${definition.slug}.`);
  if (matches[0]) {
    if (matches[0].name !== definition.name) {
      throw new Error(`${definition.slug} exists without the exact demo name; refusing to reuse it.`);
    }
    return matches[0];
  }
  const created = await appRequest("/api/platform/tenants", {
    token,
    method: "POST",
    body: { name: definition.name, slug: definition.slug }
  });
  return created.tenant;
}

async function ensureSettings(slug) {
  await tenantRequest(slug, "/api/tenant/settings", {
    method: "PATCH",
    body: {
      defaultGuidance,
      notificationPreferences
    }
  });
}

async function ensureMembers(slug) {
  let current = await tenantRequest(slug, "/api/tenant/members");
  if (!current.provisioningAvailable && demoMembers.length) {
    throw new Error(`Permanent account provisioning is unavailable in ${slug}.`);
  }
  const retriedMemberIds = new Set();
  for (const member of demoMembers) {
    const existing = (current.members || []).find(candidate => String(candidate.email || "").toLowerCase() === member.email);
    if (existing) {
      let updateRequested = false;
      if (existing.displayName !== member.displayName) {
        throw new Error(`Existing demo member ${member.email} has a different display name in ${slug}; refusing to adopt it.`);
      }
      const provisioningNeedsReconcile = !existing.provisioning
        || existing.provisioning.desiredRole !== member.role
        || existing.provisioning.desiredState !== "active"
        || (existing.provisioning.status === "succeeded" && existing.status !== "active");
      if (existing.role !== member.role || existing.status === "disabled" || provisioningNeedsReconcile) {
        if (!repair) {
          throw new Error(`Existing demo member ${member.email} does not match the requested role, enabled state, and provisioning target in ${slug}; rerun with --apply --repair.`);
        }
        await tenantRequest(slug, `/api/tenant/members/${existing.id}`, {
          method: "PATCH",
          body: { role: member.role, status: "active" }
        });
        updateRequested = true;
      }
      if (["failed", "retry_wait"].includes(existing.provisioning?.status) && !updateRequested) {
        if (!repair) {
          throw new Error(`Demo member provisioning previously failed for ${member.email} in ${slug}; rerun with --apply --repair.`);
        }
        await tenantRequest(slug, `/api/tenant/members/${existing.id}/retry`, { method: "POST" });
        retriedMemberIds.add(existing.id);
      }
    } else {
      await tenantRequest(slug, "/api/tenant/members", {
        method: "POST",
        body: member
      });
    }
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    current = await tenantRequest(slug, "/api/tenant/members");
    const matched = demoMembers.map(member => ({
      expected: member,
      actual: (current.members || []).find(candidate => String(candidate.email || "").toLowerCase() === member.email)
    }));
    const mismatch = matched.find(({ expected, actual }) => actual && (
      actual.displayName !== expected.displayName
      || actual.role !== expected.role
      || actual.status === "disabled"
    ));
    if (mismatch) throw new Error(`Demo member ${mismatch.expected.email} changed to an unexpected state in ${slug}.`);
    const failed = matched.find(({ actual }) => ["failed", "retry_wait"].includes(actual?.provisioning?.status));
    if (failed) {
      if (repair && failed.actual?.id && !retriedMemberIds.has(failed.actual.id)) {
        await tenantRequest(slug, `/api/tenant/members/${failed.actual.id}/retry`, { method: "POST" });
        retriedMemberIds.add(failed.actual.id);
        await new Promise(resolve => setTimeout(resolve, 2_000));
        continue;
      }
      throw new Error(`Demo member provisioning failed for ${failed.expected.email} in ${slug}: ${failed.actual.provisioning.safeError || "review Team setup"}`);
    }
    if (matched.every(({ actual }) => actual?.status === "active" && actual?.provisioning?.status === "succeeded")) {
      return matched.map(({ actual }) => actual);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Demo members did not finish provisioning in ${slug} within two minutes.`);
}

async function loadSessions(slug) {
  return (await tenantRequest(slug, "/api/inventory/sessions")).sessions || [];
}

async function ensureSession(slug, name, desiredStatus = "active") {
  const matches = (await loadSessions(slug)).filter(session => session.name === name);
  if (matches.length > 1) throw new Error(`Duplicate demo session ${name} in ${slug}.`);
  let session = matches[0];
  if (!session) {
    session = (await tenantRequest(slug, "/api/inventory/sessions", {
      method: "POST",
      body: { name, packetSource: "Shadow Tracer demo data", status: desiredStatus === "closed" ? "active" : desiredStatus }
    })).session;
  } else if (desiredStatus === "active" && session.status !== "active") {
    if (!repair) {
      throw new Error(`${name} is ${session.status} in ${slug}; rerun with --apply --repair to reopen it.`);
    }
  }
  return session;
}

async function sessionDetail(slug, sessionId) {
  return tenantRequest(slug, `/api/inventory/sessions/${sessionId}`);
}

async function ensureRow(slug, session, row) {
  const detail = await sessionDetail(slug, session.id);
  const matches = (detail.items || []).filter(item => item.packetLine === row.packetLine);
  if (matches.length > 1) throw new Error(`Duplicate demo row ${row.packetLine} in ${session.name}.`);
  if (matches[0]) return { item: matches[0], created: false };
  const item = (await tenantRequest(slug, `/api/inventory/sessions/${session.id}/items`, {
    method: "POST",
    body: {
      ...(row.inventoryItemId ? { inventoryItemId: row.inventoryItemId } : {}),
      packetLine: row.packetLine,
      expectedQty: row.expectedQty ?? 1,
      locationHint: row.locationHint
    }
  })).sessionItem;
  return { item, created: true };
}

function assetMimeType(assetPath) {
  return path.extname(assetPath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

async function uploadAsset(slug, assetName, caption, kind = "general") {
  const assetPath = path.join(projectRoot, "assets", assetName);
  const bytes = await fs.readFile(assetPath);
  return (await tenantRequest(slug, "/api/uploads/photos", {
    method: "POST",
    body: {
      fileName: assetName,
      mimeType: assetMimeType(assetPath),
      base64: bytes.toString("base64"),
      caption,
      kind,
      purpose: "evidence"
    }
  })).photo;
}

async function submitWithPhoto(slug, itemId, scenario) {
  const photo = await uploadAsset(slug, scenario.asset, scenario.caption, scenario.kind || "general");
  const response = await tenantRequest(slug, `/api/session-items/${itemId}/submissions`, {
    method: "POST",
    body: {
      status: scenario.status || "found",
      locationText: scenario.location,
      serialNumber: scenario.serial,
      note: scenario.note,
      photos: [{ uploadId: photo.uploadId, caption: scenario.caption, kind: scenario.kind || "general" }]
    }
  });
  return { submission: response.submission, photo };
}

function historicalRow(slug, accent) {
  return {
    packetLine: `000009148 R20684 RADIO SET AN/PRC-152 - ${accent}`,
    expectedQty: 1,
    locationHint: `${accent} cage, shelf 2`
  };
}

async function ensureHistoricalRecord(slug, accent) {
  let session = await ensureSession(slug, historicalSessionName, "closed");
  const expectedRow = historicalRow(slug, accent);
  let detail = await sessionDetail(slug, session.id);
  const unexpectedHistoricalRows = (detail.items || []).filter(candidate => candidate.packetLine !== expectedRow.packetLine);
  if (unexpectedHistoricalRows.length) {
    throw new Error(`${historicalSessionName} contains non-fixture rows in ${slug} and cannot be repaired safely; reset the demo workspace instead.`);
  }
  let item = (detail.items || []).find(candidate => candidate.packetLine === expectedRow.packetLine) || null;
  const initiallyComplete = Boolean(
    item?.inventoryItem?.id
    && item.inventoryItem.lastVerifiedSubmissionId
    && (item.inventoryItem.photos || []).length
    && (item.submissions || []).some(submission => (
      submission.reviewState === "approved"
      && submission.id === item.inventoryItem.lastVerifiedSubmissionId
      && (submission.photos || []).length
    ))
  );
  if (session.status === "closed" && !initiallyComplete) {
    if (!repair) {
      throw new Error(`${historicalSessionName} is closed but incomplete in ${slug}; rerun with --apply --repair.`);
    }
    session = (await tenantRequest(slug, `/api/inventory/sessions/${session.id}`, {
      method: "PATCH",
      body: { status: "active" }
    })).session;
  }

  const ensured = await ensureRow(slug, session, expectedRow);
  item = ensured.item;
  detail = await sessionDetail(slug, session.id);
  item = detail.items.find(candidate => candidate.id === item.id);
  const savedSubmission = (item?.submissions || []).find(submission => (
    submission.id === item?.inventoryItem?.lastVerifiedSubmissionId
  ));
  const savedRecordReady = Boolean(
    item?.inventoryItem?.id
    && item.inventoryItem.lastVerifiedSubmissionId
    && (item.inventoryItem.photos || []).length
    && savedSubmission?.reviewState === "approved"
    && (savedSubmission.photos || []).length
  );
  if (!savedRecordReady) {
    if (!ensured.created && !repair) {
      throw new Error(`Historical saved-item proof is incomplete in ${slug}; rerun with --apply --repair.`);
    }
    let pending = (item.submissions || []).find(submission => (
      submission.reviewState === "pending"
      && submission.photos?.[0]?.mediaUploadId
    ));
    let uploadId = pending?.photos?.[0]?.mediaUploadId || "";
    if (!pending) {
      const created = await submitWithPhoto(slug, item.id, {
        asset: "radio.jpg",
        caption: "Radio and data plate from the previous inventory",
        kind: "serial",
        location: `${accent} cage, shelf 2`,
        serial: `DEMO-${slug.toUpperCase()}-RADIO-01`,
        note: "Previous inventory confirmed the radio, handset, battery, and data plate."
      });
      pending = created.submission;
      uploadId = created.photo.uploadId;
    }
    await tenantRequest(slug, `/api/submissions/${pending.id}/review`, {
      method: "PATCH",
      body: { decision: "approved", saveItem: true, savedMediaUploadIds: [uploadId] }
    });
  }
  detail = await sessionDetail(slug, session.id);
  item = detail.items.find(candidate => candidate.id === item.id);
  if (
    !item?.inventoryItem?.id
    || !item.inventoryItem.lastVerifiedSubmissionId
    || !(item.inventoryItem.photos || []).length
  ) {
    throw new Error(`Historical saved item with verified photo was not created in ${slug}.`);
  }
  const currentSession = (await loadSessions(slug)).find(candidate => candidate.id === session.id);
  if (currentSession?.status !== "closed") {
    await tenantRequest(slug, `/api/inventory/sessions/${session.id}`, {
      method: "PATCH",
      body: { status: "closed" }
    });
  }
  return item.inventoryItem;
}

function activeRows(slug, accent, savedItemId, variant) {
  const prefix = variant === "hand-receipt" ? "HR" : "SPOT";
  return [
    {
      key: "linked",
      packetLine: `000009148 R20684 RADIO SET AN/PRC-152 - ${accent} ${prefix}`,
      locationHint: `${accent} cage, shelf 2`,
      inventoryItemId: savedItemId
    },
    {
      key: "suggested",
      packetLine: `000019148 R20684 RADIO SET AN/PRC-152 RECHECK - ${accent} ${prefix}`,
      locationHint: `${accent} cage, shelf 2`,
      suggestedInventoryItemId: savedItemId
    },
    {
      key: "unclaimed",
      packetLine: `000018603 G18358 GENERATOR SET DIESEL - ${accent} ${prefix}`,
      locationHint: `${accent} motor pool, bay 1`
    },
    {
      key: "assigned",
      packetLine: `000002115 W34648 TOOL KIT ENGINEER SQUAD - ${accent} ${prefix}`,
      locationHint: `${accent} connex, top shelf`
    },
    {
      key: "pending",
      packetLine: `000004336 N96248 NAVIGATION SET DAGR - ${accent} ${prefix}`,
      locationHint: `${accent} arms room, cabinet 3`
    },
    {
      key: "rejected",
      packetLine: `000007410 RADIAC SET AN/VDR-2 - ${accent} ${prefix}`,
      locationHint: `${accent} CBRN cage`
    },
    {
      key: "approved",
      packetLine: `000006220 TAMPER VIBRATING TYPE - ${accent} ${prefix}`,
      locationHint: `${accent} equipment line`
    }
  ];
}

async function inspectPreExistingTenant(definition, tenant) {
  const failures = [];
  if (tenant.name !== definition.name) {
    failures.push(`${definition.slug} has name ${JSON.stringify(tenant.name)} instead of ${JSON.stringify(definition.name)}.`);
  }

  const [membersResponse, sessions] = await Promise.all([
    tenantRequest(definition.slug, "/api/tenant/members"),
    loadSessions(definition.slug)
  ]);
  const members = membersResponse.members || [];
  if (demoMembers.length && !membersResponse.provisioningAvailable) {
    failures.push(`${definition.slug} cannot provision permanent demo accounts.`);
  }
  const expectedMembersByEmail = new Map(demoMembers.map(member => [member.email, member]));
  for (const actual of members) {
    const email = String(actual.email || "").toLowerCase();
    const expected = expectedMembersByEmail.get(email);
    if (!expected) {
      failures.push(`${definition.slug} contains unexpected permanent membership ${email || actual.id}.`);
      continue;
    }
    if (actual.displayName !== expected.displayName) {
      failures.push(`${definition.slug} member ${expected.email} has a display-name mismatch that repair will not adopt.`);
    }
    if (actual.accountType === "session_crew") {
      failures.push(`${definition.slug} member ${expected.email} is a temporary crew identity, not a permanent account.`);
    }
    if (!["active", "invited", "disabled"].includes(actual.status)) {
      failures.push(`${definition.slug} member ${expected.email} has unsupported status ${actual.status || "missing"}.`);
    }
    if (
      actual.provisioning
      && !["pending", "running", "retry_wait", "failed", "succeeded"].includes(actual.provisioning.status)
    ) {
      failures.push(`${definition.slug} member ${expected.email} has unsupported provisioning status ${actual.provisioning.status || "missing"}.`);
    }
  }
  for (const expected of demoMembers) {
    const matches = members.filter(actual => String(actual.email || "").toLowerCase() === expected.email);
    if (matches.length > 1) failures.push(`${definition.slug} contains duplicate membership ownership for ${expected.email}.`);
  }

  const expectedSessionNames = new Set([
    historicalSessionName,
    ...activeSessionDefinitions.map(candidate => candidate.name)
  ]);
  for (const session of sessions) {
    if (!expectedSessionNames.has(session.name)) {
      failures.push(`${definition.slug} contains unexpected session ${JSON.stringify(session.name)} that repair cannot remove.`);
    }
    if (!["draft", "active", "closed"].includes(session.status)) {
      failures.push(`${definition.slug} session ${JSON.stringify(session.name)} has unsupported status ${session.status || "missing"}.`);
    }
  }
  for (const name of expectedSessionNames) {
    if (sessions.filter(session => session.name === name).length > 1) {
      failures.push(`${definition.slug} contains duplicate session ${JSON.stringify(name)}.`);
    }
  }

  const sessionDetails = new Map();
  for (const session of sessions.filter(candidate => expectedSessionNames.has(candidate.name))) {
    sessionDetails.set(session.id, await sessionDetail(definition.slug, session.id));
  }

  let historicalSavedItemId = null;
  const historical = sessions.find(session => session.name === historicalSessionName) || null;
  if (historical) {
    const detail = sessionDetails.get(historical.id) || { items: [] };
    const expected = historicalRow(definition.slug, definition.accent);
    const matches = (detail.items || []).filter(item => item.packetLine === expected.packetLine);
    const unexpected = (detail.items || []).filter(item => item.packetLine !== expected.packetLine);
    if (unexpected.length) failures.push(`${definition.slug} historical fixture contains rows repair cannot remove.`);
    if (matches.length > 1) failures.push(`${definition.slug} historical fixture contains a duplicate radio row.`);
    const row = matches[0] || null;
    if (row) {
      if (Number(row.expectedQty) !== 1 || row.locationHint !== expected.locationHint) {
        failures.push(`${definition.slug} historical radio row has immutable quantity or location data that does not match the fixture.`);
      }
      if (row.suggestedInventoryItem?.id) {
        failures.push(`${definition.slug} historical radio row has an unresolved saved-item suggestion that repair cannot approve safely.`);
      }
      historicalSavedItemId = row.inventoryItem?.id || null;
    }
  }

  for (const sessionDefinition of activeSessionDefinitions) {
    const session = sessions.find(candidate => candidate.name === sessionDefinition.name) || null;
    if (!session) continue;
    const detail = sessionDetails.get(session.id) || { items: [] };
    const expectedRows = activeRows(
      definition.slug,
      definition.accent,
      historicalSavedItemId || "missing-historical-saved-item",
      sessionDefinition.variant
    );
    const expectedByPacketLine = new Map(expectedRows.map(row => [row.packetLine, row]));
    const unexpected = (detail.items || []).filter(item => !expectedByPacketLine.has(item.packetLine));
    if (unexpected.length) failures.push(`${definition.slug} ${sessionDefinition.name} contains rows repair cannot remove.`);

    for (const expected of expectedRows) {
      const matches = (detail.items || []).filter(item => item.packetLine === expected.packetLine);
      if (matches.length > 1) {
        failures.push(`${definition.slug} ${sessionDefinition.name} contains duplicate ${expected.key} rows.`);
        continue;
      }
      const row = matches[0] || null;
      if (!row) continue;
      if (Number(row.expectedQty) !== 1 || row.locationHint !== expected.locationHint) {
        failures.push(`${definition.slug} ${sessionDefinition.name} ${expected.key} row has immutable quantity or location data that does not match the fixture.`);
      }
      const submissions = row.submissions || [];
      const hasInventoryRelationship = Boolean(row.inventoryItem?.id || row.suggestedInventoryItem?.id);
      if (expected.key === "linked") {
        if (
          row.status !== "unchecked"
          || submissions.length
          || !historicalSavedItemId
          || row.inventoryItem?.id !== historicalSavedItemId
          || row.suggestedInventoryItem
        ) {
          failures.push(`${definition.slug} ${sessionDefinition.name} linked row was materially changed and cannot be restored safely.`);
        }
      } else if (expected.key === "suggested") {
        if (
          row.status !== "unchecked"
          || submissions.length
          || !historicalSavedItemId
          || row.suggestedInventoryItem?.id !== historicalSavedItemId
          || row.inventoryItem
        ) {
          failures.push(`${definition.slug} ${sessionDefinition.name} suggested row was materially changed and cannot be restored safely.`);
        }
      } else if (["unclaimed", "assigned"].includes(expected.key)) {
        if (row.status !== "unchecked" || submissions.length || hasInventoryRelationship) {
          failures.push(`${definition.slug} ${sessionDefinition.name} ${expected.key} row was materially changed and cannot be restored safely.`);
        }
      } else if (hasInventoryRelationship) {
        failures.push(`${definition.slug} ${sessionDefinition.name} ${expected.key} proof row has an unexpected saved-item relationship repair cannot remove.`);
      }
    }
  }

  return { definition, tenant, membersResponse, members, sessions, sessionDetails, failures };
}

async function preflightDemoIdentities(snapshots) {
  const inspections = await Promise.all(demoMembers.map(async member => ({
    member,
    inspection: await appRequest("/api/platform/identity-check", {
      token,
      method: "POST",
      body: { email: member.email }
    })
  })));
  const failures = [];
  for (const { member, inspection } of inspections) {
    const candidates = inspection.candidates || [];
    if (inspection.status === "ambiguous" || Number(inspection.candidateCount) > 1) {
      failures.push(`${member.email} matches multiple provider identities; resolve that ambiguity before seeding.`);
      continue;
    }
    if (inspection.status === "new" && Number(inspection.candidateCount) === 0) continue;
    if (inspection.status !== "existing" || Number(inspection.candidateCount) !== 1 || candidates.length !== 1) {
      failures.push(`${member.email} returned an unexpected identity-check result.`);
      continue;
    }
    const candidate = candidates[0];
    if (candidate.eligible !== true) {
      failures.push(`${member.email} provider identity is ineligible: ${candidate.blockedReason || "eligibility check failed"}`);
    }
    if (candidate.displayName !== member.displayName) {
      failures.push(`${member.email} provider display name does not exactly match ${JSON.stringify(member.displayName)}.`);
    }
    const hasExactTargetOwnership = snapshots.some(snapshot => snapshot.members.some(actual => (
      String(actual.email || "").toLowerCase() === member.email
      && actual.displayName === member.displayName
      && actual.accountType !== "session_crew"
    )));
    if (!hasExactTargetOwnership) {
      failures.push(`${member.email} already exists at the provider but is not owned by an exact demo membership in a pre-existing target workspace.`);
    }
  }
  return { inspections, failures };
}

async function preflightApplyState(existingTenants) {
  const snapshots = [];
  for (const definition of tenantDefinitions) {
    const matches = existingTenants.filter(tenant => tenant.slug === definition.slug);
    if (matches.length > 1) {
      snapshots.push({ definition, members: [], failures: [`Duplicate workspace slug ${definition.slug}.`] });
      continue;
    }
    if (matches[0]) snapshots.push(await inspectPreExistingTenant(definition, matches[0]));
  }
  const identityPreflight = await preflightDemoIdentities(snapshots);
  const failures = [
    ...snapshots.flatMap(snapshot => snapshot.failures || []),
    ...identityPreflight.failures
  ];
  if (failures.length) {
    throw new Error(`Production demo read-only preflight failed before fixture mutation: ${failures.join(" | ")}`);
  }
  return { snapshots, identityPreflight };
}

async function ensureScenarioState(slug, session, row, item, { canRestore, assignmentTarget = null }) {
  const detail = await sessionDetail(slug, session.id);
  const current = detail.items.find(candidate => candidate.id === item.id);
  if (!current) throw new Error(`Demo row ${row.packetLine} disappeared from ${session.name}.`);
  const submissions = current?.submissions || [];
  if (["linked", "suggested", "unclaimed"].includes(row.key)) {
    const relationshipReady = row.key === "linked"
      ? current.inventoryItem?.id === row.inventoryItemId
      : row.key === "suggested"
        ? current.suggestedInventoryItem?.id === row.suggestedInventoryItemId && !current.inventoryItem
        : !current.inventoryItem && !current.suggestedInventoryItem;
    if (current.status !== "unchecked" || submissions.length || !relationshipReady) {
      throw new Error(
        `${row.key} demo row in ${session.name} was materially completed or changed and cannot be safely restored through the API; reset the demo workspace instead.`
      );
    }
    if (current.assignedTo || current.assignedToEmail) {
      if (!canRestore) {
        throw new Error(`Unclaimed demo row was claimed in ${session.name}; rerun with --apply --repair to restore it.`);
      }
      await tenantRequest(slug, `/api/session-items/${item.id}/assignment`, {
        method: "PATCH",
        body: { memberId: null }
      });
    }
    return;
  }
  if (row.key === "assigned") {
    if (current.status !== "unchecked" || submissions.length || current.inventoryItem || current.suggestedInventoryItem) {
      throw new Error(`Assigned demo row in ${session.name} was completed and cannot be safely restored through the API; reset the demo workspace instead.`);
    }
    const assignedToExpectedUser = assignmentTarget?.userId
      ? current.assignedTo === assignmentTarget.userId
      : Boolean(current.assignedTo || current.assignedToEmail);
    if (!assignedToExpectedUser) {
      if (!canRestore) {
        throw new Error(`Assigned demo row changed in ${session.name}; rerun with --apply --repair to restore it.`);
      }
      await tenantRequest(slug, `/api/session-items/${item.id}/assignment`, {
        method: "PATCH",
        body: { memberId: assignmentTarget?.id || "self" }
      });
    }
    return;
  }
  if (!["pending", "rejected", "approved"].includes(row.key)) return;
  const existingTarget = submissions.find(submission => submission.reviewState === row.key) || null;
  const targetReady = row.key === "pending"
    ? current.status === "needs_review" && (existingTarget?.photos || []).length >= 1
    : row.key === "rejected"
      ? current.status === "unchecked"
        && !current.assignedTo
        && existingTarget?.reviewReturnRoute === "unassigned"
        && Boolean(existingTarget?.reviewNote)
        && (existingTarget?.photos || []).length >= 1
      : current.status === "approved" && (existingTarget?.photos || []).length >= 1;
  if (targetReady) return;
  if (!canRestore) {
    throw new Error(`${row.key} demo proof changed in ${session.name}; rerun with --apply --repair to restore the fixture.`);
  }
  let pending = submissions.find(submission => (
    submission.reviewState === "pending" && (submission.photos || []).length >= 1
  ));
  if (!pending) {
    const scenarios = {
      pending: {
        asset: "dagr.jpg",
        caption: "DAGR with serial label visible",
        location: row.locationHint,
        serial: `DEMO-${slug.toUpperCase()}-DAGR`,
        note: "Submitted during the demo run and waiting for leader review."
      },
      rejected: {
        asset: "radiac.jpg",
        caption: "Radiac set photo that needs a wider location view",
        location: row.locationHint,
        serial: `DEMO-${slug.toUpperCase()}-RAD`,
        note: "Initial photo was sent without enough surrounding context."
      },
      approved: {
        asset: "tamper.jpg",
        caption: "Tamper located on the equipment line",
        location: row.locationHint,
        serial: "",
        note: "Found and approved during the in-progress demo inventory."
      }
    };
    pending = (await submitWithPhoto(slug, item.id, scenarios[row.key])).submission;
  }
  if (row.key === "rejected") {
    await tenantRequest(slug, `/api/submissions/${pending.id}/review`, {
      method: "PATCH",
      body: {
        decision: "rejected",
        note: "Retake a wider photo that shows the item and its storage location.",
        returnAssignment: "unassigned"
      }
    });
  } else if (row.key === "approved") {
    await tenantRequest(slug, `/api/submissions/${pending.id}/review`, {
      method: "PATCH",
      body: { decision: "approved", saveItem: false }
    });
  }
}

async function ensureActiveSession(slug, accent, savedItem, definition, assignmentTarget = null) {
  let session = await ensureSession(slug, definition.name, "active");
  const expectedRows = activeRows(slug, accent, savedItem.id, definition.variant);
  const expectedPacketLines = new Set(expectedRows.map(row => row.packetLine));
  const initialDetail = await sessionDetail(slug, session.id);
  const unexpectedRows = (initialDetail.items || []).filter(item => !expectedPacketLines.has(item.packetLine));
  if (unexpectedRows.length) {
    throw new Error(`${definition.name} contains non-fixture rows in ${slug} and cannot be repaired safely; reset the demo workspace instead.`);
  }
  for (const row of expectedRows) {
    const matches = (initialDetail.items || []).filter(item => item.packetLine === row.packetLine);
    if (matches.length > 1) throw new Error(`Duplicate demo row ${row.packetLine} in ${definition.name}.`);
    const current = matches[0] || null;
    if (!current || !["linked", "suggested", "unclaimed", "assigned"].includes(row.key)) continue;
    const submissions = current.submissions || [];
    const relationshipReady = row.key === "linked"
      ? current.inventoryItem?.id === row.inventoryItemId
      : row.key === "suggested"
        ? current.suggestedInventoryItem?.id === row.suggestedInventoryItemId && !current.inventoryItem
        : row.key === "unclaimed"
          ? !current.inventoryItem && !current.suggestedInventoryItem
          : !current.inventoryItem && !current.suggestedInventoryItem;
    if (current.status !== "unchecked" || submissions.length || !relationshipReady) {
      throw new Error(`${row.key} demo row in ${definition.name} cannot be restored safely; reset the demo workspace instead.`);
    }
  }
  if (session.status !== "active") {
    session = (await tenantRequest(slug, `/api/inventory/sessions/${session.id}`, {
      method: "PATCH",
      body: { status: "active" }
    })).session;
  }
  for (const row of expectedRows) {
    const ensured = await ensureRow(slug, session, row);
    await ensureScenarioState(slug, session, row, ensured.item, {
      canRestore: repair || ensured.created,
      assignmentTarget
    });
  }
  return session;
}

function expectedCrewJoinUrl(slug, inviteToken) {
  return `https://${slug}.876en.org/#/join?invite=${encodeURIComponent(inviteToken)}`;
}

function manifestInviteMatches(invite, slug, sessionId, displayName) {
  return invite?.slug === slug && invite?.sessionId === sessionId && invite?.displayName === displayName;
}

function hasRecoverableInviteCredentials(invite, slug) {
  return Boolean(
    /^\d{4}$/.test(String(invite?.code || ""))
    && String(invite?.inviteToken || "").length >= 16
    && invite?.joinUrl === expectedCrewJoinUrl(slug, invite.inviteToken)
  );
}

async function ensureCrewPass(slug, session, displayName, manifest) {
  const existing = await tenantRequest(slug, `/api/inventory/sessions/${session.id}/crew-access`);
  const sessionEntries = manifest.invites.filter(invite => (
    invite?.slug === slug && invite?.sessionId === session.id
  ));
  const livePasses = (existing.crew || []).filter(access => (
    ["pending", "consumed"].includes(access.status)
    && new Date(access.expiresAt || 0).getTime() > Date.now()
  ));

  if (sessionEntries.length === 1 && livePasses.length === 1) {
    const entry = sessionEntries[0];
    const access = livePasses[0];
    const accessMatches = !entry.accessId || entry.accessId === access.id;
    if (
      access.status === "pending"
      && access.displayName === displayName
      && manifestInviteMatches(entry, slug, session.id, displayName)
      && accessMatches
      && hasRecoverableInviteCredentials(entry, slug)
    ) {
      entry.accessId = access.id;
      entry.sessionName = session.name;
      entry.expiresAt = access.expiresAt || entry.expiresAt || null;
      await writeManifest(manifest);
      return entry;
    }
  }

  if ((sessionEntries.length || livePasses.length) && !repair) {
    throw new Error(`Crew pass state for ${displayName} in ${slug} is not safely recoverable; rerun with --apply --repair.`);
  }

  for (const access of livePasses) {
    await tenantRequest(slug, `/api/inventory/sessions/${session.id}/crew-access/${access.id}/revoke`, {
      method: "POST"
    });
  }
  if (sessionEntries.length) {
    manifest.invites = manifest.invites.filter(invite => (
      invite?.slug !== slug || invite?.sessionId !== session.id
    ));
    await writeManifest(manifest);
  }

  const created = await tenantRequest(slug, `/api/inventory/sessions/${session.id}/crew-access`, {
    method: "POST",
    body: { displayName }
  });
  if (
    created.access?.status !== "pending"
    || !created.access?.id
    || !/^\d{4}$/.test(String(created.code || ""))
    || !created.inviteToken
  ) {
    throw new Error(`Crew pass creation returned an incomplete response for ${displayName} in ${slug}.`);
  }
  const entry = {
    slug,
    sessionId: session.id,
    sessionName: session.name,
    displayName,
    accessId: created.access.id,
    code: created.code,
    inviteToken: created.inviteToken,
    joinUrl: expectedCrewJoinUrl(slug, created.inviteToken),
    expiresAt: created.access?.expiresAt || null
  };
  manifest.invites.push(entry);
  await writeManifest(manifest);
  return entry;
}

function addFailure(failures, condition, message) {
  if (!condition) failures.push(message);
  return Boolean(condition);
}

function submissionWithState(item, reviewState) {
  return (item?.submissions || []).find(submission => submission.reviewState === reviewState) || null;
}

function expectedCrewDisplayName(sessionName) {
  return `Demo Crew - ${sessionName.replace("[Demo] Active ", "")}`;
}

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

async function authenticatedMediaCookie(slug, sessionId) {
  const response = await fetch(`${apiOrigin}/api/inventory/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Origin: adminOrigin,
      "X-Tenant-Slug": slug
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000)
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`authenticated tenant media-session request failed (${response.status})`);
  const cookiePrefix = `inventory_media_${slug}=`;
  const pair = setCookieHeaders(response.headers)
    .map(value => String(value || "").split(";", 1)[0])
    .find(value => value.startsWith(cookiePrefix));
  if (!pair) throw new Error("authenticated tenant response omitted its scoped media cookie");
  return pair;
}

function bytesHaveImageSignature(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return true;
  const ascii = bytes.subarray(0, 12).toString("ascii");
  return ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a") || (ascii.startsWith("RIFF") && ascii.endsWith("WEBP"));
}

async function verifyRequiredMedia(slug, sessionId, requiredMedia) {
  const failures = [];
  const uniqueMedia = new Map();
  for (const requirement of requiredMedia) {
    const rawUrl = String(requirement.photo?.url || "").trim();
    if (!rawUrl) {
      failures.push(`${requirement.label} is missing its media URL.`);
      continue;
    }
    const existing = uniqueMedia.get(rawUrl) || [];
    existing.push(requirement.label);
    uniqueMedia.set(rawUrl, existing);
  }
  if (!uniqueMedia.size) return { checked: 0, failures };
  if (!sessionId) {
    failures.push("Required media could not be authenticated because the fixture has no session.");
    return { checked: 0, failures };
  }

  let cookie;
  try {
    cookie = await authenticatedMediaCookie(slug, sessionId);
  } catch (error) {
    failures.push(`Required media authentication failed: ${error.message}`);
    return { checked: 0, failures };
  }

  let checked = 0;
  for (const [rawUrl, labels] of uniqueMedia) {
    const label = labels.join(", ");
    try {
      const mediaUrl = new URL(rawUrl, apiOrigin);
      if (mediaUrl.origin !== apiOrigin || !mediaUrl.pathname.startsWith(`/media/tenants/${slug}/`)) {
        throw new Error("URL is not a same-origin tenant media path");
      }
      const response = await fetch(mediaUrl, {
        method: "GET",
        headers: { Accept: "image/*", Cookie: cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000)
      });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (!response.ok) throw new Error(`media request failed (${response.status})`);
      if (!contentType.startsWith("image/") || contentType.includes("json")) {
        throw new Error(`media response has non-image content type ${contentType || "missing"}`);
      }
      if (Number.isFinite(declaredLength) && declaredLength > 20 * 1024 * 1024) {
        throw new Error("media response exceeds the 20 MiB verification limit");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error("media response was empty");
      if (bytes.length > 20 * 1024 * 1024) throw new Error("media response exceeds the 20 MiB verification limit");
      if (!bytesHaveImageSignature(bytes)) throw new Error("media bytes do not have a recognized image signature");
      checked += 1;
    } catch (error) {
      failures.push(`${label} could not be verified as authenticated image bytes: ${error.message}`);
    }
  }
  return { checked, failures };
}

async function verifyTenant(definition, manifest) {
  const failures = [];
  const requiredMedia = [];
  const tenantMatches = (await loadPlatformTenants()).filter(candidate => candidate.slug === definition.slug);
  const tenant = tenantMatches[0] || null;
  addFailure(failures, tenantMatches.length === 1, `Expected exactly one ${definition.slug} workspace.`);
  addFailure(failures, tenant?.name === definition.name, `Workspace name must be ${definition.name}.`);
  if (!tenant || tenantMatches.length !== 1 || tenant.name !== definition.name) {
    return { slug: definition.slug, ready: false, failures };
  }

  const settingsResponse = await tenantRequest(definition.slug, "/api/tenant/settings");
  const settings = settingsResponse.settings || {};
  addFailure(failures, settings.defaultGuidance === defaultGuidance, "Demo guidance is missing or changed.");
  for (const [key, expectedValue] of Object.entries(notificationPreferences)) {
    addFailure(
      failures,
      settings.notificationPreferences?.[key] === expectedValue,
      `Notification preference ${key} must be ${expectedValue}.`
    );
  }

  const sessions = await loadSessions(definition.slug);
  const expectedSessionNames = new Set([
    historicalSessionName,
    ...activeSessionDefinitions.map(candidate => candidate.name)
  ]);
  const unexpectedDemoSessions = sessions.filter(session => (
    session.name?.startsWith("[Demo]") && !expectedSessionNames.has(session.name)
  ));
  addFailure(
    failures,
    sessions.length === expectedSessionNames.size,
    `Demo workspace must contain exactly ${expectedSessionNames.size} fixture sessions.`
  );
  addFailure(failures, unexpectedDemoSessions.length === 0, "Unexpected [Demo] sessions exist in this workspace.");

  const historicalMatches = sessions.filter(session => session.name === historicalSessionName);
  const historical = historicalMatches[0] || null;
  addFailure(failures, historicalMatches.length === 1, `Expected exactly one ${historicalSessionName} session.`);
  addFailure(failures, historical?.status === "closed", "Historical demo session must be closed.");

  let savedItem = null;
  let historicalSummary = null;
  if (historical && historicalMatches.length === 1) {
    const detail = await sessionDetail(definition.slug, historical.id);
    const expectedHistoricalRow = historicalRow(definition.slug, definition.accent);
    const rowMatches = (detail.items || []).filter(item => item.packetLine === expectedHistoricalRow.packetLine);
    const row = rowMatches[0] || null;
    const savedPhotos = row?.inventoryItem?.photos || [];
    const lastVerifiedSubmission = (row?.submissions || []).find(submission => (
      submission.id === row?.inventoryItem?.lastVerifiedSubmissionId
    ));
    savedPhotos.forEach((photo, index) => requiredMedia.push({
      label: `historical saved radio photo ${index + 1}`,
      photo
    }));
    (lastVerifiedSubmission?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `historical approved evidence photo ${index + 1}`,
      photo
    }));
    addFailure(failures, (detail.items || []).length === 1, "Historical demo session must contain exactly one row.");
    addFailure(failures, rowMatches.length === 1, "Historical radio row is missing or duplicated.");
    addFailure(
      failures,
      Number(row?.expectedQty) === 1 && row?.locationHint === expectedHistoricalRow.locationHint,
      "Historical radio row quantity and location must exactly match the fixture."
    );
    addFailure(failures, row?.status === "approved", "Historical radio row must be approved.");
    addFailure(failures, Boolean(row?.inventoryItem?.id), "Historical radio row must create a saved item record.");
    addFailure(failures, Boolean(row?.inventoryItem?.lastVerifiedAt), "Saved radio record must include a verification time.");
    addFailure(failures, savedPhotos.length >= 1, "Saved radio record must retain at least one reference photo.");
    addFailure(
      failures,
      lastVerifiedSubmission?.reviewState === "approved" && (lastVerifiedSubmission.photos || []).length >= 1,
      "Saved radio record must point to approved proof with a photo."
    );
    savedItem = row?.inventoryItem || null;
    historicalSummary = {
      id: historical.id,
      status: historical.status,
      itemCount: detail.items?.length || 0,
      savedItemId: savedItem?.id || null,
      savedPhotoCount: savedPhotos.length,
      lastVerifiedAt: savedItem?.lastVerifiedAt || null
    };
  }

  const membersResponse = await tenantRequest(definition.slug, "/api/tenant/members");
  const specialistEmail = demoMembers.find(member => member.role === "contributor")?.email || null;
  const specialistMember = specialistEmail
    ? (membersResponse.members || []).find(member => (
      String(member.email || "").toLowerCase() === specialistEmail
    )) || null
    : null;

  const activeSummaries = [];
  for (const sessionDefinition of activeSessionDefinitions) {
    const sessionMatches = sessions.filter(session => session.name === sessionDefinition.name);
    const session = sessionMatches[0] || null;
    addFailure(failures, sessionMatches.length === 1, `Expected exactly one ${sessionDefinition.name} session.`);
    addFailure(failures, session?.status === "active", `${sessionDefinition.name} must be active.`);
    if (!session || sessionMatches.length !== 1) continue;

    const detail = await sessionDetail(definition.slug, session.id);
    const expectedRows = activeRows(definition.slug, definition.accent, savedItem?.id || "missing", sessionDefinition.variant);
    const rowsByKey = new Map();
    for (const expectedRow of expectedRows) {
      const matches = (detail.items || []).filter(item => item.packetLine === expectedRow.packetLine);
      addFailure(failures, matches.length === 1, `${sessionDefinition.name} ${expectedRow.key} row is missing or duplicated.`);
      if (matches.length === 1) {
        rowsByKey.set(expectedRow.key, matches[0]);
        addFailure(
          failures,
          Number(matches[0].expectedQty) === 1 && matches[0].locationHint === expectedRow.locationHint,
          `${sessionDefinition.name} ${expectedRow.key} row quantity and location must exactly match the fixture.`
        );
      }
    }
    addFailure(failures, (detail.items || []).length === expectedRows.length, `${sessionDefinition.name} must contain exactly seven demo rows.`);

    const linked = rowsByKey.get("linked");
    (linked?.inventoryItem?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `${sessionDefinition.name} linked saved-item photo ${index + 1}`,
      photo
    }));
    addFailure(
      failures,
      Boolean(savedItem?.id && linked?.inventoryItem?.id === savedItem.id && linked.inventoryItem.photos?.length),
      `${sessionDefinition.name} linked row must show the saved radio and its photo.`
    );
    addFailure(failures, linked?.status === "unchecked" && !linked?.assignedTo, `${sessionDefinition.name} linked row must be unclaimed and unchecked.`);

    const suggested = rowsByKey.get("suggested");
    (suggested?.suggestedInventoryItem?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `${sessionDefinition.name} suggested saved-item photo ${index + 1}`,
      photo
    }));
    addFailure(
      failures,
      Boolean(savedItem?.id && suggested?.suggestedInventoryItem?.id === savedItem.id && suggested.suggestedInventoryItem.photos?.length),
      `${sessionDefinition.name} must show a possible previous radio record with its photo.`
    );
    addFailure(failures, suggested?.status === "unchecked" && !suggested?.assignedTo, `${sessionDefinition.name} suggested row must be unclaimed and unchecked.`);

    const unclaimed = rowsByKey.get("unclaimed");
    addFailure(
      failures,
      unclaimed?.status === "unchecked"
        && !unclaimed?.assignedTo
        && !unclaimed?.inventoryItem
        && !unclaimed?.suggestedInventoryItem
        && !(unclaimed?.submissions || []).length,
      `${sessionDefinition.name} unclaimed row must remain untouched.`
    );

    const assigned = rowsByKey.get("assigned");
    const assignedToExpectedMember = specialistMember?.userId
      ? assigned?.assignedTo === specialistMember.userId
      : skipMembers && Boolean(assigned?.assignedTo);
    addFailure(
      failures,
      assigned?.status === "unchecked"
        && !assigned?.inventoryItem
        && !assigned?.suggestedInventoryItem
        && assignedToExpectedMember,
      `${sessionDefinition.name} assigned row must be claimed by the demo inventory specialist and remain unchecked.`
    );

    const pending = rowsByKey.get("pending");
    const pendingSubmission = submissionWithState(pending, "pending");
    (pendingSubmission?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `${sessionDefinition.name} pending evidence photo ${index + 1}`,
      photo
    }));
    addFailure(
      failures,
      pending?.status === "needs_review"
        && !pending?.inventoryItem
        && !pending?.suggestedInventoryItem
        && (pendingSubmission?.photos || []).length >= 1,
      `${sessionDefinition.name} pending row must have photographed proof waiting for review.`
    );

    const rejected = rowsByKey.get("rejected");
    const rejectedSubmission = submissionWithState(rejected, "rejected");
    (rejectedSubmission?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `${sessionDefinition.name} rejected evidence photo ${index + 1}`,
      photo
    }));
    addFailure(
      failures,
      rejected?.status === "unchecked"
        && !rejected?.assignedTo
        && !rejected?.inventoryItem
        && !rejected?.suggestedInventoryItem
        && rejectedSubmission?.reviewReturnRoute === "unassigned"
        && Boolean(rejectedSubmission?.reviewNote)
        && (rejectedSubmission?.photos || []).length >= 1,
      `${sessionDefinition.name} rejected row must retain photographed rejection history and return to the queue.`
    );

    const approved = rowsByKey.get("approved");
    const approvedSubmission = submissionWithState(approved, "approved");
    (approvedSubmission?.photos || []).forEach((photo, index) => requiredMedia.push({
      label: `${sessionDefinition.name} approved evidence photo ${index + 1}`,
      photo
    }));
    addFailure(
      failures,
      approved?.status === "approved"
        && !approved?.inventoryItem
        && !approved?.suggestedInventoryItem
        && (approvedSubmission?.photos || []).length >= 1,
      `${sessionDefinition.name} approved row must retain photographed approved proof.`
    );

    const crewName = expectedCrewDisplayName(session.name);
    const crewResponse = await tenantRequest(definition.slug, `/api/inventory/sessions/${session.id}/crew-access`);
    const livePasses = (crewResponse.crew || []).filter(access => (
      ["pending", "consumed"].includes(access.status)
      && new Date(access.expiresAt || 0).getTime() > Date.now()
    ));
    const manifestEntries = manifest.invites.filter(invite => (
      invite?.slug === definition.slug && invite?.sessionId === session.id
    ));
    const manifestEntry = manifestEntries[0] || null;
    addFailure(
      failures,
      livePasses.length === 1
        && livePasses[0].status === "pending"
        && livePasses[0].displayName === crewName,
      `${sessionDefinition.name} must have exactly one unexpired live crew pass total, and it must be the expected unused grant.`
    );
    addFailure(failures, manifestEntries.length === 1, `${sessionDefinition.name} must have exactly one recoverable manifest entry.`);
    addFailure(
      failures,
      Boolean(
        manifestEntry
        && livePasses[0]
        && manifestInviteMatches(manifestEntry, definition.slug, session.id, crewName)
        && manifestEntry.accessId === livePasses[0].id
        && manifestEntry.sessionName === session.name
        && hasRecoverableInviteCredentials(manifestEntry, definition.slug)
        && new Date(manifestEntry.expiresAt || 0).getTime() > Date.now()
      ),
      `${sessionDefinition.name} crew pass manifest credentials are missing, stale, or mismatched.`
    );

    const photoCount = (detail.items || [])
      .flatMap(item => item.submissions || [])
      .flatMap(submission => submission.photos || []).length;
    activeSummaries.push({
      id: session.id,
      name: session.name,
      status: session.status,
      itemCount: detail.items?.length || 0,
      savedRecordCount: (detail.items || []).filter(item => item.inventoryItem).length,
      suggestedRecordCount: (detail.items || []).filter(item => item.suggestedInventoryItem).length,
      pendingProofCount: (detail.items || []).filter(item => submissionWithState(item, "pending")).length,
      rejectedHistoryCount: (detail.items || []).filter(item => submissionWithState(item, "rejected")).length,
      approvedProofCount: (detail.items || []).filter(item => submissionWithState(item, "approved")).length,
      photoCount,
      crewPassReady: livePasses.length === 1 && manifestEntries.length === 1,
      crewAccessId: livePasses.length === 1 ? livePasses[0].id : null
    });
  }

  const memberSummaries = [];
  addFailure(
    failures,
    (membersResponse.members || []).length === demoMembers.length,
    `Demo workspace must contain exactly ${demoMembers.length} permanent test memberships.`
  );
  for (const expected of demoMembers) {
    const matches = (membersResponse.members || []).filter(member => (
      String(member.email || "").toLowerCase() === expected.email
    ));
    const actual = matches[0] || null;
    addFailure(failures, matches.length === 1, `Expected exactly one ${expected.email} membership.`);
    addFailure(
      failures,
      actual?.displayName === expected.displayName
        && actual?.role === expected.role
        && actual?.status === "active"
        && actual?.accountType !== "session_crew"
        && actual?.provisioning?.status === "succeeded"
        && actual?.provisioning?.desiredRole === expected.role
        && actual?.provisioning?.desiredState === "active",
      `${expected.email} must be active, successfully provisioned, and have the requested name and role.`
    );
    memberSummaries.push({
      email: expected.email,
      displayName: actual?.displayName || null,
      role: actual?.role || null,
      status: actual?.status || null,
      provisioningStatus: actual?.provisioning?.status || null,
      provisioningDesiredRole: actual?.provisioning?.desiredRole || null,
      provisioningDesiredState: actual?.provisioning?.desiredState || null
    });
  }

  const mediaVerification = await verifyRequiredMedia(
    definition.slug,
    activeSummaries[0]?.id || historical?.id || null,
    requiredMedia
  );
  failures.push(...mediaVerification.failures);

  return {
    slug: definition.slug,
    ready: failures.length === 0,
    failures,
    settings: {
      emailProofSubmitted: settings.notificationPreferences?.email_proof_submitted,
      emailProofRequests: settings.notificationPreferences?.email_proof_requests
    },
    historicalSession: historicalSummary,
    activeSessions: activeSummaries,
    members: memberSummaries,
    media: {
      requiredReferenceCount: requiredMedia.length,
      uniqueImagesVerified: mediaVerification.checked
    }
  };
}

function manifestEntryBelongsToKnownFixture(entry, snapshots) {
  const snapshot = snapshots.find(candidate => candidate.definition?.slug === entry?.slug);
  if (!snapshot) return false;
  const session = (snapshot.sessions || []).find(candidate => candidate.id === entry?.sessionId);
  if (!session || !activeSessionDefinitions.some(candidate => candidate.name === session.name)) return false;
  return manifestInviteMatches(entry, entry.slug, session.id, expectedCrewDisplayName(session.name));
}

async function finalizeExactManifest(manifest) {
  const exactEntries = [];
  for (const definition of tenantDefinitions) {
    const sessions = await loadSessions(definition.slug);
    for (const sessionDefinition of activeSessionDefinitions) {
      const matches = sessions.filter(session => session.name === sessionDefinition.name);
      if (matches.length !== 1) throw new Error(`Cannot finalize manifest: expected exactly one ${sessionDefinition.name} in ${definition.slug}.`);
      const session = matches[0];
      const crewName = expectedCrewDisplayName(session.name);
      const crewResponse = await tenantRequest(definition.slug, `/api/inventory/sessions/${session.id}/crew-access`);
      const live = (crewResponse.crew || []).filter(access => (
        ["pending", "consumed"].includes(access.status)
        && new Date(access.expiresAt || 0).getTime() > Date.now()
      ));
      if (live.length !== 1 || live[0].status !== "pending" || live[0].displayName !== crewName) {
        throw new Error(`Cannot finalize manifest: ${session.name} in ${definition.slug} does not have exactly one expected unused crew pass.`);
      }
      const candidates = manifest.invites.filter(invite => (
        invite?.accessId === live[0].id
        && manifestInviteMatches(invite, definition.slug, session.id, crewName)
        && hasRecoverableInviteCredentials(invite, definition.slug)
      ));
      if (!candidates.length) {
        throw new Error(`Cannot finalize manifest: recoverable credentials are missing for ${session.name} in ${definition.slug}.`);
      }
      if (candidates.length > 1 && !repair) {
        throw new Error(`Cannot finalize manifest: duplicate credentials exist for ${session.name} in ${definition.slug}.`);
      }
      const entry = candidates[0];
      entry.sessionName = session.name;
      entry.expiresAt = live[0].expiresAt || entry.expiresAt || null;
      exactEntries.push(entry);
    }
  }

  const expectedAccessIds = new Set(exactEntries.map(entry => entry.accessId));
  if (exactEntries.length !== 6 || expectedAccessIds.size !== 6) {
    throw new Error("Cannot finalize manifest: expected six distinct fixture crew access IDs.");
  }
  const outsideEntries = manifest.invites.filter(entry => !expectedAccessIds.has(entry?.accessId));
  if (outsideEntries.length && !repair) {
    throw new Error("The demo manifest contains entries outside the six expected crew access IDs; use an empty manifest or explicit repair.");
  }
  manifest.invites = exactEntries;
  await writeManifest(manifest);
}

function verifyManifestExact(manifest, verification) {
  const failures = [];
  const expectedAccessIds = verification.flatMap(result => (
    result.activeSessions || []
  ).map(session => session.crewAccessId).filter(Boolean));
  const manifestAccessIds = (manifest.invites || []).map(entry => entry?.accessId).filter(Boolean);
  addFailure(failures, expectedAccessIds.length === 6 && new Set(expectedAccessIds).size === 6, "Expected six distinct live fixture crew access IDs.");
  addFailure(failures, (manifest.invites || []).length === 6, "Manifest must contain exactly six crew credential entries.");
  addFailure(failures, manifestAccessIds.length === 6 && new Set(manifestAccessIds).size === 6, "Manifest crew access IDs must be present and unique.");
  const expectedSet = new Set(expectedAccessIds);
  addFailure(
    failures,
    manifestAccessIds.length === expectedAccessIds.length && manifestAccessIds.every(id => expectedSet.has(id)),
    "Manifest must contain only the six currently live fixture crew access IDs."
  );
  addFailure(failures, manifest.apiOrigin === apiOrigin, `Manifest API origin must be ${apiOrigin}.`);
  addFailure(failures, manifest.authentikOrigin === authentikOrigin, `Manifest Authentik origin must be ${authentikOrigin}.`);
  addFailure(failures, manifest.adminOrigin === adminOrigin, `Manifest admin origin must be ${adminOrigin}.`);
  addFailure(failures, manifest.emailBase === (skipMembers ? null : emailBase), "Manifest member email configuration does not match this run.");
  addFailure(
    failures,
    JSON.stringify(manifest.memberEmails || []) === JSON.stringify(demoMembers.map(member => member.email)),
    "Manifest member aliases do not exactly match this run."
  );
  return failures;
}

const existingTenants = await loadPlatformTenants();
if (!apply && !verifyOnly) {
  console.log(JSON.stringify({
    ok: true,
    mode: "plan",
    confirmation: expectedConfirmation,
    repairConfirmation: `REPAIR ${tenantDefinitions.map(tenant => tenant.slug).join(",")} ${confirmationRecipient} VIA ${apiOrigin}`,
    origins: { api: apiOrigin, authentik: authentikOrigin, admin: adminOrigin },
    nonProductionOriginOverride: usesProductionOrigins ? null : nonProductionOriginOverride,
    manifestPath,
    maintenanceNote: "Validation GETs do not change fixture settings, members, sessions, or rows, but the server may perform normal stale-crew expiry maintenance.",
    members: demoMembers.map(member => ({ displayName: member.displayName, role: member.role, email: member.email })),
    tenants: tenantDefinitions.map(definition => ({
      ...definition,
      exists: existingTenants.some(tenant => tenant.slug === definition.slug)
    })),
    perTenant: { closedHistorySessions: 1, activeSessions: 2, rowsPerActiveSession: 7, temporaryCrewPasses: 2 }
  }, null, 2));
  process.exit(0);
}

let manifest = null;
let manifestLock = null;
console.error("NOTE: validation session and crew GETs do not change fixture content, but the server may perform normal stale-crew expiry maintenance.");
try {
  if (apply) {
    await preflightManifest();
    manifestLock = await acquireManifestLock();
    const applyExistingTenants = await loadPlatformTenants();
    const applyPreflight = await preflightApplyState(applyExistingTenants);
    manifest = await readManifest();
    const expectedManifestEmailBase = skipMembers ? null : emailBase;
    if (manifest.emailBase !== undefined && manifest.emailBase !== expectedManifestEmailBase) {
      throw new Error("The existing demo manifest belongs to a different member email configuration; use a separate manifest or the original settings.");
    }
    for (const [key, expectedValue] of [
      ["apiOrigin", apiOrigin],
      ["authentikOrigin", authentikOrigin],
      ["adminOrigin", adminOrigin]
    ]) {
      if (manifest[key] !== undefined && manifest[key] !== expectedValue) {
        throw new Error(`The existing demo manifest is bound to a different ${key}; use a separate manifest.`);
      }
    }
    if (manifest.invites.length && !manifest.apiOrigin && !repair) {
      throw new Error("An unbound legacy manifest with crew credentials requires the explicit REPAIR confirmation before reuse.");
    }
    const outsideKnownFixture = manifest.invites.filter(entry => (
      !manifestEntryBelongsToKnownFixture(entry, applyPreflight.snapshots)
    ));
    if (outsideKnownFixture.length && !repair) {
      throw new Error("The demo manifest contains credentials outside the pre-existing target fixture; use a separate empty manifest or explicit repair.");
    }

    manifest.version = 1;
    manifest.invites ||= [];
    manifest.apiOrigin = apiOrigin;
    manifest.authentikOrigin = authentikOrigin;
    manifest.adminOrigin = adminOrigin;
    manifest.emailBase = expectedManifestEmailBase;
    manifest.memberEmails = demoMembers.map(member => member.email);
    await writeManifest(manifest);

    if (demoMembers.length) {
      console.error(`WARNING: permanent account provisioning may send enrollment or recovery email to: ${demoMembers.map(member => member.email).join(", ")}`);
    }
    if (repair) {
      console.error("WARNING: repair mode may reopen demo sessions, restore claimed or reviewed fixture rows, revoke/recreate crew passes, and prune stale manifest credentials.");
    }

    const readyExistingSlugs = new Set();
    if (!repair) {
      for (const definition of tenantDefinitions) {
        if (!applyExistingTenants.some(tenant => tenant.slug === definition.slug)) continue;
        const existingVerification = await verifyTenant(definition, manifest);
        if (!existingVerification.ready) {
          throw new Error(
            `${definition.slug} already exists but is not an untouched, complete demo fixture. `
            + `No fixture settings, members, sessions, or rows were changed; normal stale-crew expiry maintenance may have run. Review: ${existingVerification.failures.join(" | ")}. `
            + "Use --apply --repair with the REPAIR confirmation only if restoring demo state is intentional."
          );
        }
        readyExistingSlugs.add(definition.slug);
      }
    }

    for (const definition of tenantDefinitions) {
      if (readyExistingSlugs.has(definition.slug)) continue;
      await ensureTenant(definition);
      await ensureSettings(definition.slug);
      const members = await ensureMembers(definition.slug);
      const specialistEmail = demoMembers.find(member => member.role === "contributor")?.email || null;
      const assignmentTarget = (members || []).find(member => (
        String(member.email || "").toLowerCase() === specialistEmail
      )) || null;
      const savedItem = await ensureHistoricalRecord(definition.slug, definition.accent);
      const activeSessions = [];
      for (const sessionDefinition of activeSessionDefinitions) {
        activeSessions.push(await ensureActiveSession(
          definition.slug,
          definition.accent,
          savedItem,
          sessionDefinition,
          assignmentTarget
        ));
      }
      for (const session of activeSessions) {
        await ensureCrewPass(definition.slug, session, expectedCrewDisplayName(session.name), manifest);
      }
      await writeManifest(manifest);
    }
    await finalizeExactManifest(manifest);
  } else {
    manifest = await readManifest();
  }

  const verification = [];
  for (const definition of tenantDefinitions) verification.push(await verifyTenant(definition, manifest));
  const manifestFailures = verifyManifestExact(manifest, verification);
  const ready = verification.every(result => result.ready) && manifestFailures.length === 0;
  console.log(JSON.stringify({
    ok: ready,
    mode: repair ? "repair" : apply ? "apply" : "verify",
    origins: { api: apiOrigin, authentik: authentikOrigin, admin: adminOrigin },
    manifestPath,
    manifestFailures,
    verification
  }, null, 2));
  if (!ready) process.exitCode = 1;
} finally {
  await releaseManifestLock(manifestLock);
}
