import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { appRequest, oidcAccessToken, requiredEnv } from "./production-auth-session.mjs";

const TENANT_SLUG = process.env.MVP_TENANT_SLUG || "ms";
const SESSION_ID = requiredEnv("MVP_BASELINE_SESSION_ID");
const BASELINE_NAME = requiredEnv("MVP_BASELINE_NAME");
const BUNDLE_DIR = requiredEnv("MVP_LEGACY_BUNDLE_DIR");
const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const CONFIRMATION = process.env.MVP_CONFIRM_PRODUCTION_BASELINE || "";

const outcomeOverrides = new Map([
  ["CO5036", "needs_review"],
  ["T05106", "needs_review"],
  ["T65342", "mismatch"],
  ["T88983", "mismatch"],
  ["T95992", "needs_review"]
]);

const mimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

function fieldValue(item, label) {
  const field = (item.fields || []).find(candidate => candidate.label === label);
  return field?.value ?? "";
}

function cleanText(value) {
  return String(value ?? "")
    .replaceAll("â€“", "-")
    .replaceAll("â€”", "-")
    .replaceAll("â€™", "'")
    .replaceAll("â€œ", '"')
    .replaceAll("â€", '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSerial(value) {
  return cleanText(value)
    .replace(/^\[|\]$/g, "")
    .replace(/,\s*/g, "; ");
}

function isLin(value) {
  return /^(?=[A-Z0-9]{6}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/.test(value);
}

function linFromTitle(title) {
  const token = cleanText(title).split(/\s+/, 1)[0]?.toUpperCase() || "";
  return isLin(token) ? token : "";
}

function itemKey(legacyItem) {
  return linFromTitle(legacyItem.title) || cleanText(fieldValue(legacyItem, "NSN"));
}

function sessionItemKey(sessionItem) {
  const packetLine = cleanText(sessionItem.packetLine).toUpperCase();
  if (packetLine.includes("6545015323674")) return "6545015323674";
  const lin = packetLine.split(/\s+/).find(isLin) || "";
  return lin;
}

function historicalNote(legacyItem) {
  const onHand = cleanText(fieldValue(legacyItem, "OH Qty"));
  const actual = cleanText(fieldValue(legacyItem, "Actual"));
  const description = cleanText(fieldValue(legacyItem, "Description"));
  const parts = [
    "Imported from the legacy MS inventory record as a historical baseline; this is not a new physical verification."
  ];
  if (onHand || actual) {
    parts.push(`Legacy quantity: on hand ${onHand || "not recorded"}; recorded actual ${actual || "not recorded"}.`);
  }
  if (description) parts.push(`Legacy note: ${description}`);
  return parts.join(" ");
}

function historicalLocation(legacyItem) {
  const location = cleanText(fieldValue(legacyItem, "Location"));
  const description = cleanText(fieldValue(legacyItem, "Description"));
  return `Legacy location: ${location || description || "not recorded"}`;
}

async function loadLegacyRows() {
  const snapshotPath = path.join(BUNDLE_DIR, "Legacy_Items_Snapshot.json");
  const imageDir = path.join(BUNDLE_DIR, "images");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const imageNames = await readdir(imageDir);
  return (snapshot.items || []).map((item, index) => {
    const row = index + 1;
    const prefix = `${String(row).padStart(2, "0")}_`;
    const images = imageNames
      .filter(name => name.startsWith(prefix))
      .sort()
      .map(name => path.join(imageDir, name));
    return {
      row,
      key: itemKey(item),
      lin: linFromTitle(item.title),
      title: cleanText(item.title),
      item,
      images
    };
  });
}

function summarizePlan(session, legacyByKey) {
  return (session.items || []).map(sessionItem => {
    const key = sessionItemKey(sessionItem);
    const legacy = legacyByKey.get(key);
    const actionable = (sessionItem.submissions || []).find(submission =>
      ["pending", "request_more_info"].includes(submission.reviewState)
    );
    return {
      sessionItemId: sessionItem.id,
      packetLine: sessionItem.packetLine,
      currentStatus: sessionItem.status,
      key,
      legacyRow: legacy?.row || null,
      imageCount: legacy?.images.length || 0,
      outcome: legacy ? (outcomeOverrides.get(legacy.lin) || "found") : null,
      action: sessionItem.status === "approved"
        ? "skip-approved"
        : actionable
          ? "approve-existing-submission"
          : legacy
            ? "submit-historical-baseline"
            : "unmapped"
    };
  });
}

function findProductionWording(detail) {
  const blocked = /\b(test|qa|smoke)\b/i;
  const findings = [];
  const inspect = (key, field, value) => {
    if (blocked.test(String(value || ""))) findings.push({ key, field });
  };
  inspect("session", "name", detail.session?.name);
  for (const item of detail.items || []) {
    const key = sessionItemKey(item) || item.id;
    inspect(key, "packetLine", item.packetLine);
    for (const submission of item.submissions || []) {
      inspect(key, "submission.locationText", submission.locationText);
      inspect(key, "submission.note", submission.note);
      inspect(key, "submission.serialNumber", submission.serialNumber);
      inspect(key, "submission.reviewNote", submission.reviewNote);
      for (const photo of submission.photos || []) {
        inspect(key, "photo.caption", photo.caption);
      }
    }
  }
  return findings;
}

async function uploadEvidence(token, legacy) {
  const uploads = [];
  for (const imagePath of legacy.images) {
    const extension = path.extname(imagePath).toLowerCase();
    const mimeType = mimeTypes.get(extension);
    if (!mimeType) throw new Error(`Unsupported image type for ${path.basename(imagePath)}`);
    const file = await readFile(imagePath);
    const uploaded = await appRequest("/api/uploads/photos", {
      token,
      tenantSlug: TENANT_SLUG,
      method: "POST",
      body: {
        fileName: path.basename(imagePath),
        mimeType,
        base64: file.toString("base64"),
        caption: `Legacy reference image - ${legacy.title}`,
        kind: "general",
        purpose: "evidence"
      }
    });
    if (!uploaded.photo?.uploadId) throw new Error(`Upload did not return an ID for ${path.basename(imagePath)}`);
    uploads.push({ uploadId: uploaded.photo.uploadId, kind: "general" });
  }
  return uploads;
}

async function main() {
  const username = requiredEnv("MVP_ADMIN_USERNAME");
  const password = requiredEnv("MVP_ADMIN_PASSWORD");
  if (APPLY && CONFIRMATION !== BASELINE_NAME) {
    throw new Error("MVP_CONFIRM_PRODUCTION_BASELINE must exactly match MVP_BASELINE_NAME when using --apply");
  }

  const token = await oidcAccessToken(username, password);
  const me = await appRequest("/api/me", { token, tenantSlug: TENANT_SLUG });
  if (!me.isPlatformAdmin && me.tenant?.role !== "tenant_admin" && me.membership?.role !== "tenant_admin") {
    throw new Error("The authenticated identity is not authorized to close the production baseline.");
  }

  const [detail, legacyRows] = await Promise.all([
    appRequest(`/api/inventory/sessions/${SESSION_ID}`, { token, tenantSlug: TENANT_SLUG }),
    loadLegacyRows()
  ]);
  if (VERIFY) {
    const approvedSubmissions = (detail.items || [])
      .map(item => (item.submissions || []).find(submission => submission.reviewState === "approved"))
      .filter(Boolean);
    const outcomes = approvedSubmissions.reduce((counts, submission) => {
      counts[submission.status] = (counts[submission.status] || 0) + 1;
      return counts;
    }, {});
    const actionableReviews = (detail.items || []).flatMap(item =>
      (item.submissions || []).filter(submission => ["pending", "request_more_info"].includes(submission.reviewState))
    );
    const verification = {
      mode: "verified",
      session: {
        id: detail.session?.id,
        name: detail.session?.name,
        status: detail.session?.status,
        itemCount: (detail.items || []).length
      },
      approvedItemCount: (detail.items || []).filter(item => item.status === "approved").length,
      approvedSubmissionCount: approvedSubmissions.length,
      approvedPhotoCount: approvedSubmissions.reduce((total, submission) => total + (submission.photos || []).length, 0),
      approvedNoteOnlyCount: approvedSubmissions.filter(submission => !(submission.photos || []).length).length,
      actionableReviewCount: actionableReviews.length,
      outcomes,
      productionWordingFindings: findProductionWording(detail)
    };
    if (verification.session.status !== "closed"
      || verification.approvedItemCount !== verification.session.itemCount
      || verification.approvedSubmissionCount !== verification.session.itemCount
      || verification.actionableReviewCount
      || verification.productionWordingFindings.length) {
      console.log(JSON.stringify(verification, null, 2));
      throw new Error("Production baseline verification failed.");
    }
    console.log(JSON.stringify(verification, null, 2));
    return;
  }
  if (!detail.session || detail.session.status === "closed") {
    throw new Error("The selected production session is missing or already closed.");
  }

  const legacyByKey = new Map(legacyRows.map(row => [row.key, row]));
  const plan = summarizePlan(detail, legacyByKey);
  const unmapped = plan.filter(row => row.action === "unmapped");
  if (unmapped.length) {
    throw new Error(`Refusing to continue with ${unmapped.length} unmapped row(s): ${unmapped.map(row => row.packetLine).join(" | ")}`);
  }

  if (!APPLY) {
    const actionCounts = plan.reduce((counts, row) => {
      counts[row.action] = (counts[row.action] || 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      mode: "dry-run",
      session: {
        id: detail.session.id,
        name: detail.session.name,
        status: detail.session.status,
        itemCount: (detail.items || []).length
      },
      targetName: BASELINE_NAME,
      actionCounts,
      productionWordingFindings: findProductionWording(detail),
      rows: plan.map(({ key, action, imageCount, outcome }) => ({ key, action, imageCount, outcome }))
    }, null, 2));
    return;
  }

  if (detail.session.name !== BASELINE_NAME) {
    await appRequest(`/api/inventory/sessions/${SESSION_ID}`, {
      token,
      tenantSlug: TENANT_SLUG,
      method: "PATCH",
      body: { name: BASELINE_NAME }
    });
  }

  const completed = [];
  for (const itemPlan of plan) {
    if (itemPlan.action === "skip-approved") {
      completed.push({ key: itemPlan.key, action: itemPlan.action });
      continue;
    }

    const currentDetail = await appRequest(`/api/inventory/sessions/${SESSION_ID}`, {
      token,
      tenantSlug: TENANT_SLUG
    });
    const sessionItem = (currentDetail.items || []).find(item => item.id === itemPlan.sessionItemId);
    if (!sessionItem) throw new Error(`Session item disappeared: ${itemPlan.sessionItemId}`);
    if (sessionItem.status === "approved") {
      completed.push({ key: itemPlan.key, action: "skip-approved-after-refresh" });
      continue;
    }

    let submission = (sessionItem.submissions || []).find(candidate =>
      ["pending", "request_more_info"].includes(candidate.reviewState)
    );
    let source = "existing-field-evidence";
    if (!submission) {
      const legacy = legacyByKey.get(itemPlan.key);
      await appRequest(`/api/session-items/${sessionItem.id}/assignment`, {
        token,
        tenantSlug: TENANT_SLUG,
        method: "PATCH",
        body: { memberId: "self" }
      });
      const photos = await uploadEvidence(token, legacy);
      const created = await appRequest(`/api/session-items/${sessionItem.id}/submissions`, {
        token,
        tenantSlug: TENANT_SLUG,
        method: "POST",
        body: {
          status: outcomeOverrides.get(legacy.lin) || "found",
          locationText: historicalLocation(legacy.item),
          serialNumber: normalizeSerial(fieldValue(legacy.item, "SN")) || undefined,
          note: historicalNote(legacy.item),
          photos
        }
      });
      submission = created.submission;
      source = "legacy-historical-baseline";
    }
    if (!submission?.id) throw new Error(`No actionable submission for ${itemPlan.packetLine}`);

    await appRequest(`/api/submissions/${submission.id}/review`, {
      token,
      tenantSlug: TENANT_SLUG,
      method: "PATCH",
      body: {
        decision: "approved",
        note: source === "existing-field-evidence"
          ? "Approved during MS inventory closeout based on the submitted field evidence."
          : "Accepted as historical baseline evidence. A current physical verification is still required during the next operational inventory.",
        saveItem: false
      }
    });
    completed.push({ key: itemPlan.key, action: source });
  }

  const beforeClose = await appRequest(`/api/inventory/sessions/${SESSION_ID}`, {
    token,
    tenantSlug: TENANT_SLUG
  });
  const unresolved = (beforeClose.items || []).filter(item => item.status !== "approved");
  if (unresolved.length) {
    throw new Error(`Refusing to close with ${unresolved.length} unresolved row(s): ${unresolved.map(item => item.packetLine).join(" | ")}`);
  }

  const queue = await appRequest("/api/inventory/review-queue", { token, tenantSlug: TENANT_SLUG });
  const pending = (queue.submissions || []).filter(submission => submission.session?.id === SESSION_ID);
  if (pending.length) throw new Error(`Refusing to close with ${pending.length} pending review(s).`);

  await appRequest(`/api/inventory/sessions/${SESSION_ID}`, {
    token,
    tenantSlug: TENANT_SLUG,
    method: "PATCH",
    body: { status: "closed" }
  });
  const finalDetail = await appRequest(`/api/inventory/sessions/${SESSION_ID}`, {
    token,
    tenantSlug: TENANT_SLUG
  });
  if (finalDetail.session?.status !== "closed") throw new Error("Production baseline did not close successfully.");

  const outcomes = new Map();
  for (const item of finalDetail.items || []) {
    const approved = (item.submissions || []).find(submission => submission.reviewState === "approved");
    const outcome = approved?.status || "unknown";
    outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);
  }
  console.log(JSON.stringify({
    mode: "applied",
    session: {
      id: finalDetail.session.id,
      name: finalDetail.session.name,
      status: finalDetail.session.status,
      itemCount: (finalDetail.items || []).length
    },
    outcomes: Object.fromEntries(outcomes),
    completed
  }, null, 2));
}

await main();
