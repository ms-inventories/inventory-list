import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Camera,
  CheckCircle2,
  Copy,
  ClipboardList,
  ClipboardPlus,
  Download,
  FileText,
  FileUp,
  ListChecks,
  LogIn,
  LogOut,
  MailPlus,
  MessageSquare,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  XCircle
} from "lucide-react";
import { appConfig, getTenantSlugFromHostname, isAdminHostname } from "../config.js";
import { apiRequest, clearQaIdentity, getApiErrorMessage, saveQaIdentity } from "../lib/api.js";
import {
  beginOidcLogin,
  clearAuthSession,
  completeOidcRedirect,
  getSessionAccessToken,
  readAuthSession,
  saveAuthSession
} from "../lib/auth.js";
import { readPacketFileText } from "../lib/ocr.js";

const roleLabels = {
  tenant_admin: "Platoon admin",
  contributor: "Contributor",
  viewer: "Viewer"
};

function formatRole(role) {
  return roleLabels[role] || role || "Member";
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function EmptyPanel({ title, body }) {
  return (
    <div className="admin-empty">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function AdminHeader({ me, tenantSlug, onRefresh, onLogout }) {
  const adminHost = isAdminHostname();
  const title = adminHost || !tenantSlug ? "Platform Admin" : "Platoon Admin";
  const subtitle = adminHost || !tenantSlug
    ? "Create platoon workspaces and assign the first platoon admin."
    : `${tenantSlug}.${appConfig.baseDomain}`;

  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">876 EN Inventory</p>
        <h1>{title}</h1>
        <p className="header-copy">{subtitle}</p>
      </div>
      <div className="header-actions">
        <a className="btn btn-secondary" href="/">
          <ClipboardList aria-hidden="true" />
          <span>Inventory</span>
        </a>
        <button className="btn btn-secondary" type="button" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          <span>Refresh</span>
        </button>
        {me ? (
          <button className="btn btn-secondary" type="button" onClick={onLogout}>
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

function AuthPanel({ status, manualToken, onManualTokenChange, onManualTokenSave, onSignIn, onUseQaIdentity }) {
  return (
    <section className="admin-card admin-auth-card">
      <div className="admin-card-heading">
        <span className="admin-icon">
          <ShieldCheck aria-hidden="true" />
        </span>
        <div>
          <p className="eyebrow">Access</p>
          <h2>Sign in</h2>
        </div>
      </div>

      <div className="admin-actions-row">
        <button className="btn btn-primary" type="button" onClick={onSignIn}>
          <LogIn aria-hidden="true" />
          <span>Continue with Authentik</span>
        </button>
      </div>

      {appConfig.enableQaAuth ? (
        <details className="disclosure">
          <summary className="btn btn-secondary">
            <span>QA users</span>
          </summary>
          <div className="disclosure-panel qa-persona-grid">
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("root")}>
              <span>Root admin</span>
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("lead")}>
              <span>Platoon admin</span>
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("nco")}>
              <span>NCO</span>
            </button>
          </div>
        </details>
      ) : null}

      <details className="disclosure">
        <summary className="btn btn-secondary">
          <span>Use access token</span>
        </summary>
        <div className="disclosure-panel form-stack">
          <textarea
            className="input admin-token-input"
            value={manualToken}
            placeholder="Paste bearer token..."
            onChange={e => onManualTokenChange(e.target.value)}
          />
          <button className="btn btn-secondary" type="button" onClick={onManualTokenSave}>
            <ShieldCheck aria-hidden="true" />
            <span>Use token</span>
          </button>
        </div>
      </details>

      <StatusLine status={status} />
    </section>
  );
}

function StatusLine({ status }) {
  if (!status?.text) return null;
  return <div className={`admin-status ${status.isError ? "error" : ""}`}>{status.text}</div>;
}

function normalizePacketImportLine(line) {
  return String(line || "")
    .replace(/[|]/g, " ")
    .replace(/\bMPO\s+Description\b/gi, "")
    .replace(/\bNSN\s+Description\b/gi, "")
    .replace(/\bSerNo\/RegNo\/LotNo\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPacketImportNoiseLine(line) {
  const value = normalizePacketImportLine(line).toLowerCase();
  if (!value || value.length < 4) return true;
  if (/^(from|to|fe|uic|date|time|page|sysno|nsn|ui|ciic|dla|buom|oh qty)\b/.test(value)) return true;
  if (/(sub hand receipt|responsible officer|national guard|department of the army)/.test(value)) return true;
  if (/^(mpo|serno|regno|lotno)\b/.test(value)) return true;
  if (/^\d+$/.test(value.replace(/\s+/g, ""))) return true;
  if (/^[a-z]{1,3}$/i.test(value)) return true;
  return false;
}

function scorePacketImportLine(line) {
  const value = normalizePacketImportLine(line);
  if (isPacketImportNoiseLine(value)) return -999;

  let score = 0;
  if (/^\d{6,10}\s+[a-z0-9]{5,8}\b/i.test(value)) score += 120;
  if (/^[a-z]\d{5}\b/i.test(value)) score += 110;
  if (/^[a-z0-9]{5,8}\s+.+/i.test(value) && /\d/.test(value.split(/\s+/)[0] || "")) score += 80;
  if (/\b[a-z]\d{5}\b/i.test(value)) score += 55;
  if (/\b(armament|antenna|battlefield|binocular|chemical|cutting|detector|device|group|kit|load|machine|navigation|radiac|radio|set|subsys|system|tamper|tool|trailer|training)\b/i.test(value)) score += 35;
  if (/:/.test(value)) score += 15;
  if (value.length >= 16) score += 10;
  if (/\b(ea|u|j|7|0)\s+\d{3,5}\s+ea\s+\d+\b/i.test(value)) score += 10;
  if (/^(nsn|na|ncm|sca|228-|01901|10tdc|1007|6665|3805|5985|6350|1240|3433|5825|5865|6660|6902)\b/i.test(value)) score -= 80;

  return score;
}

function confidenceFromPacketScore(score) {
  if (score >= 120) return "high";
  if (score >= 70) return "medium";
  return "low";
}

function parseDelimitedPacketLine(line) {
  const parts = String(line || "")
    .split(/\t|\s+\|\s+/)
    .map(part => normalizePacketImportLine(part))
    .filter(Boolean);

  if (parts.length < 2) return null;

  const maybeQty = Number(parts[1]);
  return {
    packetLine: parts[0],
    expectedQty: Number.isInteger(maybeQty) && maybeQty >= 0 ? maybeQty : undefined,
    locationHint: parts.length > 2 ? parts.slice(2).join(" ") : undefined,
    confidence: "high"
  };
}

function parsePacketRows(text) {
  const seen = new Set();

  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseDelimitedPacketLine(line) || {
      packetLine: normalizePacketImportLine(line),
      confidence: confidenceFromPacketScore(scorePacketImportLine(line))
    })
    .map(row => ({
      ...row,
      packetLine: normalizePacketImportLine(row.packetLine)
    }))
    .filter(row => {
      if (!row.packetLine || isPacketImportNoiseLine(row.packetLine)) return false;
      if (scorePacketImportLine(row.packetLine) < 55 && !row.expectedQty && !row.locationHint) return false;

      const key = row.packetLine.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 250);
}

function createPacketDraftRows(rows) {
  return rows.map((row, index) => ({
    id: globalThis.crypto?.randomUUID?.() || `packet-row-${Date.now()}-${index}`,
    packetLine: row.packetLine || "",
    expectedQty: row.expectedQty ?? "",
    locationHint: row.locationHint || "",
    confidence: row.confidence || "low"
  }));
}

function sanitizePacketDraftRows(rows) {
  return rows
    .map(row => {
      const expectedQty = Number(row.expectedQty);
      const item = {
        packetLine: String(row.packetLine || "").trim(),
        locationHint: String(row.locationHint || "").trim() || undefined
      };

      if (String(row.expectedQty ?? "").trim() && Number.isInteger(expectedQty) && expectedQty >= 0) {
        item.expectedQty = expectedQty;
      }

      return item;
    })
    .filter(row => row.packetLine.length >= 2);
}

function packetMimeTypeForFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  if (type) return type;
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".csv")) return "text/csv";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function normalizeMetadataValue(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeMetadataValue);
  if (value && typeof value === "object") {
    return normalizeMetadataValue(value.url || value.src || value.href || value.value);
  }
  return value ? [String(value)] : [];
}

function getInventoryItemImages(item) {
  const metadata = item?.metadata || {};
  const values = [
    metadata.image,
    metadata.images,
    metadata.imageUrl,
    metadata.imageUrls,
    metadata.photo,
    metadata.photos,
    metadata.thumbnail,
    metadata.thumbnailUrl
  ].flatMap(normalizeMetadataValue);

  if (Array.isArray(metadata.fields)) {
    metadata.fields.forEach(field => {
      const label = String(field?.label || "").toLowerCase();
      if (label.includes("image") || label.includes("photo")) {
        values.push(...normalizeMetadataValue(field.value));
      }
    });
  }

  return [...new Set(values)]
    .filter(value => /^(https?:\/\/|data:image\/|\/media\/|\/assets\/|images\/|assets\/)/i.test(value))
    .slice(0, 3);
}

function metadataSearchText(metadata) {
  try {
    return JSON.stringify(metadata || {});
  } catch {
    return "";
  }
}

function sessionProgress(session) {
  const total = Number(session?.itemCount || 0);
  const done = Number(session?.foundCount || 0);
  return total ? Math.round((done / total) * 100) : 0;
}

function sessionNeedsReview(session) {
  return Number(session?.needsReviewCount || 0) > 0;
}

function sessionCreatedValue(session) {
  const value = new Date(session?.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sortSessionsByAttention(sessions) {
  const statusRank = {
    active: 0,
    draft: 1,
    closed: 2
  };

  return [...sessions].sort((a, b) => {
    const reviewDelta = Number(b.needsReviewCount || 0) - Number(a.needsReviewCount || 0);
    if (reviewDelta) return reviewDelta;

    const statusDelta = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (statusDelta) return statusDelta;

    return sessionCreatedValue(b) - sessionCreatedValue(a);
  });
}

function sessionItemPriority(item) {
  if (itemNeedsMoreProof(item)) return 0;
  if (itemHasPendingProof(item)) return 1;

  const ranks = {
    needs_review: 2,
    unchecked: 3,
    mismatch: 4,
    not_found: 5,
    found: 6,
    approved: 7
  };

  return ranks[item?.status] ?? 9;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function latestSubmission(item) {
  return (item.submissions || [])[0] || null;
}

function itemNeedsMoreProof(item) {
  return latestSubmission(item)?.reviewState === "request_more_info";
}

function itemHasPendingProof(item) {
  return latestSubmission(item)?.reviewState === "pending";
}

function sessionItemNeedsAction(item) {
  const latest = latestSubmission(item);
  return !["approved", "found"].includes(item?.status) || ["pending", "request_more_info", "rejected"].includes(latest?.reviewState);
}

function sessionItemNeedsReview(item) {
  return item?.status === "needs_review" || latestSubmission(item)?.reviewState === "pending";
}

function sessionItemHasProblem(item) {
  const latest = latestSubmission(item);
  return ["not_found", "mismatch"].includes(item?.status) || latest?.reviewState === "rejected";
}

function sessionItemIsComplete(item) {
  return ["approved", "found"].includes(item?.status) && !["pending", "request_more_info", "rejected"].includes(latestSubmission(item)?.reviewState);
}

function sessionItemMatchesFilter(item, filter) {
  if (filter === "action") return sessionItemNeedsAction(item);
  if (filter === "review") return sessionItemNeedsReview(item);
  if (filter === "requests") return itemNeedsMoreProof(item);
  if (filter === "problems") return sessionItemHasProblem(item);
  if (filter === "complete") return sessionItemIsComplete(item);
  return true;
}

function getSessionItemSearchText(item) {
  const latest = latestSubmission(item);
  return [
    item?.packetLine,
    item?.locationHint,
    item?.status,
    item?.inventoryItem?.title,
    item?.inventoryItem?.commonName,
    item?.inventoryItem?.armyName,
    item?.inventoryItem?.lin,
    item?.inventoryItem?.nsn,
    item?.inventoryItem?.description,
    item?.inventoryItem?.currentLocation,
    metadataSearchText(item?.inventoryItem?.metadata),
    latest?.status,
    latest?.locationText,
    latest?.serialNumber,
    latest?.note,
    latest?.reviewNote,
    latest?.submittedByEmail,
    latest?.submittedByName
  ].filter(Boolean).join(" ").toLowerCase();
}

function sessionItemMatchesQuery(item, query) {
  const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

  const haystack = getSessionItemSearchText(item);
  return terms.every(term => haystack.includes(term));
}

function formatReviewState(value) {
  const labels = {
    pending: "Pending review",
    approved: "Approved",
    request_more_info: "More proof requested",
    rejected: "Rejected"
  };

  return labels[value] || value || "No proof";
}

function formatItemStatus(value) {
  const labels = {
    unchecked: "Unchecked",
    found: "Found",
    not_found: "Not found",
    mismatch: "Mismatch",
    needs_review: "Needs review",
    approved: "Approved",
    draft: "Draft",
    active: "Active",
    closed: "Closed"
  };

  return labels[value] || value || "Unknown";
}

function submissionPerson(submission) {
  return submission?.submittedByName || submission?.submittedByEmail || "Unknown";
}

function itemDisplayName(item) {
  return item?.inventoryItem?.commonName || item?.inventoryItem?.title || item?.packetLine || "Untitled row";
}

function buildSessionReport(session, items) {
  const rows = items || [];
  const counts = {
    total: rows.length,
    approved: 0,
    found: 0,
    notFound: 0,
    mismatch: 0,
    needsReview: 0,
    unchecked: 0,
    pendingProof: 0,
    requestedProof: 0,
    rejectedProof: 0
  };

  rows.forEach(item => {
    if (item.status === "approved") counts.approved += 1;
    else if (item.status === "found") counts.found += 1;
    else if (item.status === "not_found") counts.notFound += 1;
    else if (item.status === "mismatch") counts.mismatch += 1;
    else if (item.status === "needs_review") counts.needsReview += 1;
    else counts.unchecked += 1;

    const submission = latestSubmission(item);
    if (submission?.reviewState === "pending") counts.pendingProof += 1;
    if (submission?.reviewState === "request_more_info") counts.requestedProof += 1;
    if (submission?.reviewState === "rejected") counts.rejectedProof += 1;
  });

  const resolved = counts.approved + counts.found;
  const issueRows = rows.filter(item => {
    const latest = latestSubmission(item);
    return !["approved", "found"].includes(item.status) || ["pending", "request_more_info", "rejected"].includes(latest?.reviewState);
  });

  return {
    session,
    rows,
    counts,
    issueRows,
    resolved,
    completion: counts.total ? Math.round((resolved / counts.total) * 100) : 0
  };
}

function buildSessionReportText(report) {
  const session = report.session || {};
  const counts = report.counts;
  const lines = [
    `${session.name || "Inventory session"} close-out report`,
    `Status: ${formatItemStatus(session.status)}`,
    `Generated: ${formatDate(new Date())}`,
    "",
    `Rows: ${counts.total}`,
    `Resolved: ${report.resolved} (${report.completion}%)`,
    `Approved/found: ${counts.approved + counts.found}`,
    `Needs review: ${counts.needsReview}`,
    `Unchecked: ${counts.unchecked}`,
    `Not found: ${counts.notFound}`,
    `Mismatch: ${counts.mismatch}`,
    `Pending proof: ${counts.pendingProof}`,
    `More proof requested: ${counts.requestedProof}`,
    ""
  ];

  if (report.issueRows.length) {
    lines.push("Rows to reconcile:");
    report.issueRows.forEach(item => {
      const latest = latestSubmission(item);
      const parts = [
        itemDisplayName(item),
        formatItemStatus(item.status),
        latest?.reviewState ? formatReviewState(latest.reviewState) : "",
        latest?.reviewNote ? `Request: ${latest.reviewNote}` : "",
        latest?.serialNumber ? `SN: ${latest.serialNumber}` : "",
        latest?.locationText ? `Location: ${latest.locationText}` : ""
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    });
  } else {
    lines.push("Rows to reconcile: none");
  }

  return lines.join("\n");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildSessionReportCsv(report) {
  const headers = [
    "Session",
    "Item",
    "Packet Line",
    "Expected Qty",
    "Location Hint",
    "Item Status",
    "Latest Proof Review",
    "Latest Proof Status",
    "Latest Location",
    "Latest Serial",
    "Latest Note",
    "Latest Request",
    "Submitted By",
    "Submitted At"
  ];

  const rows = (report.rows || []).map(item => {
    const latest = latestSubmission(item);
    return [
      report.session?.name || "",
      itemDisplayName(item),
      item.packetLine || "",
      item.expectedQty ?? "",
      item.locationHint || "",
      formatItemStatus(item.status),
      latest?.reviewState ? formatReviewState(latest.reviewState) : "",
      latest?.status ? formatItemStatus(latest.status) : "",
      latest?.locationText || "",
      latest?.serialNumber || "",
      latest?.note || "",
      latest?.reviewNote || "",
      latest ? submissionPerson(latest) : "",
      latest?.createdAt ? formatDate(latest.createdAt) : ""
    ];
  });

  return [headers, ...rows]
    .map(row => row.map(csvCell).join(","))
    .join("\r\n");
}

function safeFileNamePart(value) {
  return String(value || "inventory-session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "inventory-session";
}

function downloadTextFile(fileName, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const proofRequestOptions = [
  { value: "serial_photo", label: "Serial photo" },
  { value: "wide_photo", label: "Wide photo" },
  { value: "location", label: "Location" },
  { value: "damage", label: "Damage" }
];

function buildProofRequestMessage(fields) {
  const labels = fields
    .map(field => proofRequestOptions.find(option => option.value === field)?.label)
    .filter(Boolean);

  if (!labels.length) return "Send another clear photo or more detail when you can.";
  return `Send ${labels.join(", ").toLowerCase()} when you can.`;
}

function ProofForm({ item, token, tenantSlug, requestNote = "", onCancel, onSaved, onStatus }) {
  const [form, setForm] = useState({
    status: "found",
    locationText: "",
    serialNumber: "",
    note: "",
    photoFile: null
  });
  const [isSaving, setIsSaving] = useState(false);

  async function submitProof(e) {
    e.preventDefault();

    if (form.status === "found" && !form.photoFile) {
      onStatus({ text: "Add a photo for found items.", isError: true });
      return;
    }

    try {
      setIsSaving(true);
      onStatus({ text: "Submitting proof...", isError: false });
      const photos = [];

      if (form.photoFile) {
        const dataUrl = await fileToDataUrl(form.photoFile);
        const uploaded = await apiRequest("/uploads/photos", {
          method: "POST",
          token,
          tenantSlug,
          body: {
            fileName: form.photoFile.name,
            mimeType: form.photoFile.type || "image/jpeg",
            dataUrl,
            kind: form.serialNumber ? "serial" : "general"
          }
        });
        photos.push(uploaded.photo);
      }

      await apiRequest(`/session-items/${item.id}/submissions`, {
        method: "POST",
        token,
        tenantSlug,
        body: {
          status: form.status,
          locationText: form.locationText.trim() || undefined,
          note: form.note.trim() || undefined,
          serialNumber: form.serialNumber.trim() || undefined,
          photos
        }
      });

      onStatus({ text: "Proof submitted.", isError: false });
      onSaved();
    } catch (error) {
      onStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="proof-form" onSubmit={submitProof}>
      {requestNote ? (
        <div className="proof-request-context">
          <strong>Platoon admin request</strong>
          <span>{requestNote}</span>
        </div>
      ) : null}

      <div className="segmented-control">
        {[
          ["found", "Found"],
          ["not_found", "Not found"],
          ["mismatch", "Mismatch"]
        ].map(([value, label]) => (
          <button
            className={form.status === value ? "active" : ""}
            type="button"
            key={value}
            onClick={() => setForm(current => ({ ...current, status: value }))}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        className="input"
        value={form.locationText}
        placeholder="Location"
        onChange={e => setForm(current => ({ ...current, locationText: e.target.value }))}
      />
      <input
        className="input"
        value={form.serialNumber}
        placeholder="Serial number"
        onChange={e => setForm(current => ({ ...current, serialNumber: e.target.value }))}
      />
      <textarea
        className="input proof-note"
        value={form.note}
        placeholder={requestNote ? "What this response shows" : "Note"}
        onChange={e => setForm(current => ({ ...current, note: e.target.value }))}
      />
      <label className="photo-picker">
        <Camera aria-hidden="true" />
        <span>{form.photoFile ? form.photoFile.name : "Add photo"}</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={e => setForm(current => ({ ...current, photoFile: e.target.files?.[0] || null }))}
        />
      </label>

      <div className="button-row">
        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          <Send aria-hidden="true" />
          <span>{isSaving ? "Submitting..." : requestNote ? "Send response" : "Submit"}</span>
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel}>
          <span>Cancel</span>
        </button>
      </div>
    </form>
  );
}

function SessionCloseoutReport({ report, onCopy, onExportCsv, onPrint, isPrintTarget = false }) {
  if (!report?.counts?.total) return null;

  const counts = report.counts;
  const issueRows = isPrintTarget ? report.issueRows : report.issueRows.slice(0, 8);
  const hiddenIssueCount = isPrintTarget ? 0 : report.issueRows.length - issueRows.length;

  return (
    <details className={`closeout-report ${isPrintTarget ? "print-target" : ""}`} open={report.session?.status === "closed" || isPrintTarget}>
      <summary>
        <span>
          <strong>Close-out report</strong>
          <small>{report.completion}% resolved</small>
        </span>
        <span className={`status-pill ${report.session?.status}`}>{report.session?.status}</span>
      </summary>

      <div className="closeout-report-body">
        <div className="closeout-print-header">
          <strong>{report.session?.name || "Inventory session"}</strong>
          <span>Close-out report - {formatItemStatus(report.session?.status)} - {formatDate(new Date().toISOString())}</span>
          <span>{counts.total} rows - {report.completion}% resolved</span>
        </div>

        <div className="closeout-metrics">
          <div>
            <strong>{counts.total}</strong>
            <span>Rows</span>
          </div>
          <div>
            <strong>{report.resolved}</strong>
            <span>Resolved</span>
          </div>
          <div>
            <strong>{counts.pendingProof + counts.requestedProof}</strong>
            <span>Proof work</span>
          </div>
          <div>
            <strong>{counts.notFound + counts.mismatch + counts.unchecked}</strong>
            <span>Problems</span>
          </div>
        </div>

        <div className="closeout-breakdown">
          <span>{counts.approved + counts.found} found/approved</span>
          <span>{counts.needsReview} needs review</span>
          <span>{counts.notFound} not found</span>
          <span>{counts.mismatch} mismatch</span>
          <span>{counts.unchecked} unchecked</span>
        </div>

        <div className="closeout-report-heading">
          <strong>Rows to reconcile</strong>
          <div className="closeout-report-actions">
            <button className="btn btn-secondary btn-small" type="button" onClick={() => onPrint(report)}>
              <Printer aria-hidden="true" />
              <span>Print</span>
            </button>
            <button className="btn btn-secondary btn-small" type="button" onClick={() => onCopy(report)}>
              <Copy aria-hidden="true" />
              <span>Copy</span>
            </button>
            <button className="btn btn-secondary btn-small" type="button" onClick={() => onExportCsv(report)}>
              <Download aria-hidden="true" />
              <span>CSV</span>
            </button>
          </div>
        </div>

        {issueRows.length ? (
          <div className="closeout-issues">
            {issueRows.map(item => {
              const latest = latestSubmission(item);
              return (
                <div className="closeout-issue" key={item.id}>
                  <strong>{itemDisplayName(item)}</strong>
                  <span>{item.packetLine || "No packet text"}</span>
                  <div>
                    <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                    {latest?.reviewState ? <span>{formatReviewState(latest.reviewState)}</span> : null}
                  </div>
                  {latest?.reviewNote ? <small>Request: {latest.reviewNote}</small> : null}
                </div>
              );
            })}
            {hiddenIssueCount > 0 ? <small className="closeout-overflow">+{hiddenIssueCount} more rows in copied report</small> : null}
          </div>
        ) : (
          <div className="closeout-empty">No unresolved rows.</div>
        )}
      </div>
    </details>
  );
}

function SessionPanel({ token, tenantSlug, canManage, canSubmit }) {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [packetRows, setPacketRows] = useState("");
  const [packetDraftRows, setPacketDraftRows] = useState([]);
  const [packetSourceName, setPacketSourceName] = useState("");
  const [packetSourceFile, setPacketSourceFile] = useState(null);
  const [sessionItemQuery, setSessionItemQuery] = useState("");
  const [sessionItemFilter, setSessionItemFilter] = useState("all");
  const [proofItemId, setProofItemId] = useState("");
  const [status, setStatus] = useState({ text: "Loading inventory sessions...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const [isReadingPacket, setIsReadingPacket] = useState(false);
  const [printReportId, setPrintReportId] = useState("");

  async function loadSessions(nextSelectedId = selectedSessionId) {
    try {
      setStatus({ text: "Loading inventory sessions...", isError: false });
      const data = await apiRequest("/inventory/sessions", { token, tenantSlug });
      const loaded = sortSessionsByAttention(data.sessions || []);
      setSessions(loaded);
      const selected = nextSelectedId && loaded.some(session => session.id === nextSelectedId)
        ? nextSelectedId
        : loaded[0]?.id || "";
      setSelectedSessionId(selected);
      if (selected) {
        await loadSessionDetail(selected, false);
      } else {
        setDetail(null);
      }
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  async function loadSessionDetail(sessionId = selectedSessionId, showStatus = true) {
    if (!sessionId) return;
    try {
      if (showStatus) setStatus({ text: "Loading session...", isError: false });
      const data = await apiRequest(`/inventory/sessions/${sessionId}`, { token, tenantSlug });
      setDetail(data);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadSessions();
  }, [tenantSlug, token]);

  useEffect(() => {
    setSessionItemQuery("");
    setSessionItemFilter("all");
    setProofItemId("");
  }, [selectedSessionId]);

  async function createSession(e) {
    e.preventDefault();
    const name = newSessionName.trim();
    if (!name) return;

    try {
      setIsSaving(true);
      const data = await apiRequest("/inventory/sessions", {
        method: "POST",
        token,
        tenantSlug,
        body: { name, status: "active" }
      });
      setNewSessionName("");
      setStatus({ text: `Started ${data.session.name}`, isError: false });
      await loadSessions(data.session.id);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  function reviewPacketRows(sourceText = packetRows, sourceName = packetSourceName) {
    if (!selectedSessionId) {
      setStatus({ text: "Create or select a session first.", isError: true });
      return [];
    }

    const rows = createPacketDraftRows(parsePacketRows(sourceText));
    setPacketDraftRows(rows);
    setPacketSourceName(sourceName || "");

    if (!rows.length) {
      setStatus({ text: "No packet rows found. Try pasting one item per line.", isError: true });
      return [];
    }

    setStatus({ text: `Found ${rows.length} packet rows. Review them before importing.`, isError: false });
    return rows;
  }

  async function readPacketUpload(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setStatus({ text: "Packet source files must be 10MB or smaller.", isError: true });
      return;
    }

    try {
      setIsReadingPacket(true);
      setStatus({ text: "Reading packet file...", isError: false });
      const [text, dataUrl] = await Promise.all([
        readPacketFileText(file, message => setStatus({ text: message, isError: false })),
        fileToDataUrl(file)
      ]);
      setPacketRows(text);
      setPacketSourceFile({
        fileName: file.name,
        mimeType: packetMimeTypeForFile(file),
        dataUrl,
        size: file.size
      });
      reviewPacketRows(text, file.name);
    } catch (error) {
      setStatus({ text: error.message || "Could not read packet file.", isError: true });
    } finally {
      setIsReadingPacket(false);
    }
  }

  function updatePacketDraftRow(rowId, field, value) {
    setPacketDraftRows(rows => rows.map(row => row.id === rowId ? { ...row, [field]: value } : row));
  }

  function removePacketDraftRow(rowId) {
    setPacketDraftRows(rows => rows.filter(row => row.id !== rowId));
  }

  function clearPacketImport() {
    setPacketRows("");
    setPacketDraftRows([]);
    setPacketSourceName("");
    setPacketSourceFile(null);
  }

  function retryImportBatch(batch) {
    if (!batch?.extractedText) {
      setStatus({ text: "That import does not have saved text to retry.", isError: true });
      return;
    }

    setPacketRows(batch.extractedText);
    setPacketSourceFile(null);
    reviewPacketRows(batch.extractedText, batch.sourceName || "Saved import");
  }

  async function addPacketRows(e) {
    e.preventDefault();
    if (!selectedSessionId) {
      setStatus({ text: "Create or select a session first.", isError: true });
      return;
    }

    const reviewedRows = packetDraftRows.length ? packetDraftRows : reviewPacketRows();
    const items = sanitizePacketDraftRows(reviewedRows);
    if (!items.length) {
      setStatus({ text: "Review at least one valid packet row first.", isError: true });
      return;
    }

    const importBatch = {
      sourceName: packetSourceName || packetSourceFile?.fileName || "Pasted packet text",
      sourceMimeType: packetSourceFile?.mimeType || "text/plain",
      extractedText: packetRows.slice(0, 1_000_000)
    };
    if (packetSourceFile) {
      importBatch.sourceFile = {
        fileName: packetSourceFile.fileName,
        mimeType: packetSourceFile.mimeType,
        dataUrl: packetSourceFile.dataUrl
      };
    }

    try {
      setIsSaving(true);
      await apiRequest(`/inventory/sessions/${selectedSessionId}/items/bulk`, {
        method: "POST",
        token,
        tenantSlug,
        body: { items, importBatch }
      });
      setPacketRows("");
      setPacketDraftRows([]);
      setPacketSourceName("");
      setPacketSourceFile(null);
      setStatus({ text: `Added ${items.length} packet rows.`, isError: false });
      await loadSessions(selectedSessionId);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function updateDirectCheck(sessionItemId, nextStatus) {
    try {
      await apiRequest(`/session-items/${sessionItemId}/direct-check`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { status: nextStatus }
      });
      setStatus({ text: "Session item updated.", isError: false });
      await loadSessions(selectedSessionId);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  async function updateSessionStatus(nextStatus) {
    if (!selectedSessionId) return;
    try {
      await apiRequest(`/inventory/sessions/${selectedSessionId}`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { status: nextStatus }
      });
      setStatus({ text: `Session marked ${nextStatus}.`, isError: false });
      await loadSessions(selectedSessionId);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  async function copyCloseoutReport(report) {
    try {
      await navigator.clipboard.writeText(buildSessionReportText(report));
      setStatus({ text: "Close-out report copied.", isError: false });
    } catch {
      setStatus({ text: "Could not copy report from this browser.", isError: true });
    }
  }

  function exportCloseoutCsv(report) {
    try {
      const fileName = `${safeFileNamePart(report.session?.name)}-closeout.csv`;
      downloadTextFile(fileName, buildSessionReportCsv(report), "text/csv;charset=utf-8");
      setStatus({ text: "Close-out CSV exported.", isError: false });
    } catch {
      setStatus({ text: "Could not export CSV from this browser.", isError: true });
    }
  }

  function printCloseoutReport(report) {
    const reportId = report.session?.id || selectedSessionId;
    if (!reportId) return;

    setPrintReportId(reportId);
    setStatus({ text: "Preparing report for print...", isError: false });
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => {
        setPrintReportId(current => current === reportId ? "" : current);
        setStatus(current => current.text === "Preparing report for print..." ? { text: "", isError: false } : current);
      }, 500);
    }, 0);
  }

  const selectedSession = sessions.find(session => session.id === selectedSessionId) || detail?.session;
  const detailItems = useMemo(
    () => [...(detail?.items || [])].sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b)),
    [detail?.items]
  );
  const sessionItemFilterCounts = useMemo(() => ({
    all: detailItems.length,
    action: detailItems.filter(sessionItemNeedsAction).length,
    review: detailItems.filter(sessionItemNeedsReview).length,
    requests: detailItems.filter(itemNeedsMoreProof).length,
    problems: detailItems.filter(sessionItemHasProblem).length,
    complete: detailItems.filter(sessionItemIsComplete).length
  }), [detailItems]);
  const visibleDetailItems = useMemo(
    () => detailItems.filter(item => sessionItemMatchesFilter(item, sessionItemFilter) && sessionItemMatchesQuery(item, sessionItemQuery)),
    [detailItems, sessionItemFilter, sessionItemQuery]
  );
  const sessionItemFilterOptions = [
    ["all", "All"],
    ["action", "Action"],
    ["review", "Review"],
    ["requests", "Requests"],
    ["problems", "Problems"],
    ["complete", "Complete"]
  ];
  const sessionReport = useMemo(
    () => selectedSession ? buildSessionReport(selectedSession, detail?.items || []) : null,
    [selectedSession, detail?.items]
  );
  const importBatches = detail?.importBatches || [];
  const openSessions = useMemo(
    () => sessions.filter(session => session.status !== "closed"),
    [sessions]
  );
  const reviewSessions = useMemo(
    () => openSessions.filter(session => sessionNeedsReview(session)),
    [openSessions]
  );
  const activeSessions = useMemo(
    () => openSessions.filter(session => session.status === "active" && !sessionNeedsReview(session)),
    [openSessions]
  );
  const draftSessions = useMemo(
    () => openSessions.filter(session => session.status === "draft" && !sessionNeedsReview(session)),
    [openSessions]
  );
  const closedSessions = useMemo(
    () => sessions.filter(session => session.status === "closed"),
    [sessions]
  );
  const openCount = openSessions.length;
  const reviewRowCount = openSessions.reduce((total, session) => total + Number(session.needsReviewCount || 0), 0);
  const totalRows = openSessions.reduce((total, session) => total + Number(session.itemCount || 0), 0);
  const foundRows = openSessions.reduce((total, session) => total + Number(session.foundCount || 0), 0);
  const overallProgress = totalRows ? Math.round((foundRows / totalRows) * 100) : 0;

  function renderSessionButton(session) {
    const progress = sessionProgress(session);
    return (
      <button
        className={`session-row ${session.id === selectedSessionId ? "active" : ""}`}
        type="button"
        key={session.id}
        onClick={() => {
          setSelectedSessionId(session.id);
          loadSessionDetail(session.id);
        }}
      >
        <span className="session-row-copy">
          <strong>{session.name}</strong>
          <small>{session.itemCount || 0} rows - {progress}% done</small>
          <span className="session-progress-track" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </span>
        </span>
        <span className="session-row-meta">
          {sessionNeedsReview(session) ? (
            <span className="session-alert">{session.needsReviewCount} review</span>
          ) : null}
          <span className={`status-pill ${session.status}`}>{session.status}</span>
        </span>
      </button>
    );
  }

  function renderSessionGroup(label, items) {
    if (!items.length) return null;

    return (
      <div className="session-group">
        <div className="session-group-title">
          <span>{label}</span>
          <strong>{items.length}</strong>
        </div>
        {items.map(renderSessionButton)}
      </div>
    );
  }

  return (
    <section className="admin-card session-panel">
      <div className="admin-card-heading">
        <span className="admin-icon">
          <ListChecks aria-hidden="true" />
        </span>
        <div>
          <p className="eyebrow">Inventory tasking</p>
          <h2>Sessions</h2>
        </div>
      </div>

      <div className="session-layout">
        <div className="session-sidebar">
          <div className="session-work-summary">
            <div>
              <strong>{openCount}</strong>
              <span>Open</span>
            </div>
            <div>
              <strong>{reviewRowCount}</strong>
              <span>Review</span>
            </div>
            <div>
              <strong>{overallProgress}%</strong>
              <span>Done</span>
            </div>
          </div>

          {canManage ? (
            <details className="session-create" open={!sessions.length}>
              <summary className="btn btn-secondary">
                <Plus aria-hidden="true" />
                <span>New session</span>
              </summary>
              <form className="disclosure-panel admin-form session-create-form" onSubmit={createSession}>
                <label className="field-label" htmlFor="sessionName">Session name</label>
                <div className="inline-control">
                  <input
                    id="sessionName"
                    className="input"
                    value={newSessionName}
                    placeholder="July sensitive items"
                    onChange={e => setNewSessionName(e.target.value)}
                  />
                  <button className="btn btn-primary" type="submit" disabled={isSaving}>
                    <Plus aria-hidden="true" />
                    <span>Start</span>
                  </button>
                </div>
              </form>
            </details>
          ) : null}

          <div className="session-list">
            {sessions.length ? (
              <>
                {renderSessionGroup("Needs review", reviewSessions)}
                {renderSessionGroup("Active", activeSessions)}
                {renderSessionGroup("Drafts", draftSessions)}
                {closedSessions.length ? (
                  <details className="session-archive">
                    <summary>Closed <span>{closedSessions.length}</span></summary>
                    <div className="session-group">
                      {closedSessions.map(renderSessionButton)}
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <EmptyPanel title="No sessions yet" body="Start one from the packet your team receives." />
            )}
          </div>
        </div>

        <div className="session-main">
          {selectedSession ? (
            <>
              <div className="session-summary">
                <div>
                  <strong>{selectedSession.name}</strong>
                  <span>{selectedSession.itemCount || 0} packet rows</span>
                  <span className="session-progress-track session-summary-progress" aria-hidden="true">
                    <span style={{ width: `${sessionProgress(selectedSession)}%` }} />
                  </span>
                </div>
                <div className="admin-row-meta">
                  <span className="badge">{selectedSession.foundCount || 0} found</span>
                  <span className="badge">{selectedSession.needsReviewCount || 0} needs review</span>
                  {canManage ? (
                    selectedSession.status !== "closed" ? (
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => updateSessionStatus("closed")}>
                        <span>Close</span>
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => updateSessionStatus("active")}>
                        <span>Reopen</span>
                      </button>
                    )
                  ) : null}
                </div>
              </div>

              {canManage ? (
                <SessionCloseoutReport
                  report={sessionReport}
                  isPrintTarget={printReportId === sessionReport?.session?.id}
                  onCopy={copyCloseoutReport}
                  onExportCsv={exportCloseoutCsv}
                  onPrint={printCloseoutReport}
                />
              ) : null}

              {canManage && importBatches.length ? (
                <div className="packet-import-history">
                  <div className="packet-import-history-heading">
                    <strong>Import history</strong>
                    <span>{importBatches.length}</span>
                  </div>
                  <div className="packet-import-history-list">
                    {importBatches.slice(0, 4).map(batch => (
                      <div className="packet-import-history-row" key={batch.id}>
                        <div>
                          <strong>{batch.sourceName || "Packet import"}</strong>
                          <span>
                            {batch.rowCount || 0} rows - {formatDate(batch.createdAt)}
                            {batch.sourceMimeType ? ` - ${batch.sourceMimeType}` : ""}
                          </span>
                        </div>
                        <div className="packet-import-history-actions">
                          {batch.sourceUrl ? (
                            <a className="btn btn-secondary btn-small" href={batch.sourceUrl} target="_blank" rel="noreferrer">
                              <FileText aria-hidden="true" />
                              <span>Source</span>
                            </a>
                          ) : null}
                          <button className="btn btn-secondary btn-small" type="button" onClick={() => retryImportBatch(batch)}>
                            <ClipboardPlus aria-hidden="true" />
                            <span>Retry</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {canManage ? (
                <details className="packet-import">
                  <summary className="btn btn-secondary">
                    <ClipboardPlus aria-hidden="true" />
                    <span>Import packet</span>
                  </summary>
                  <form className="disclosure-panel packet-import-form" onSubmit={addPacketRows}>
                    <div className="packet-import-actions">
                      <label className="btn btn-secondary btn-small packet-file-button">
                        <FileUp aria-hidden="true" />
                        <span>{isReadingPacket ? "Reading..." : "Upload PDF/text/photo"}</span>
                        <input
                          type="file"
                          accept="application/pdf,text/plain,text/csv,image/*,.pdf,.txt,.csv"
                          disabled={isReadingPacket || isSaving}
                          onChange={e => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            readPacketUpload(file);
                          }}
                        />
                      </label>
                      <button
                        className="btn btn-secondary btn-small"
                        type="button"
                        disabled={!packetRows.trim() || isReadingPacket || isSaving}
                        onClick={() => reviewPacketRows()}
                      >
                        <ClipboardList aria-hidden="true" />
                        <span>Review rows</span>
                      </button>
                      {packetRows || packetDraftRows.length ? (
                        <button className="btn btn-secondary btn-small" type="button" onClick={clearPacketImport}>
                          <Trash2 aria-hidden="true" />
                          <span>Clear</span>
                        </button>
                      ) : null}
                    </div>
                    {packetSourceName ? <span className="packet-import-note">Source: {packetSourceName}</span> : null}
                    {packetSourceFile?.size ? <span className="packet-import-note">Stored with import: {formatFileSize(packetSourceFile.size)}</span> : null}
                    <textarea
                      className="input packet-textarea"
                      value={packetRows}
                      placeholder="Paste hand-receipt text or one item per line. Example:&#10;000009148 R20684 RADIAC SET: AN/VDR-2&#10;B67839 BINOCULAR: M24"
                      onChange={e => {
                        setPacketRows(e.target.value);
                        setPacketDraftRows([]);
                        setPacketSourceName("");
                        setPacketSourceFile(null);
                      }}
                    />
                    {packetDraftRows.length ? (
                      <div className="packet-review">
                        <div className="packet-review-heading">
                          <strong>Review before saving</strong>
                          <span>{packetDraftRows.length} rows</span>
                        </div>
                        <div className="packet-review-list">
                          {packetDraftRows.map((row, index) => (
                            <div className="packet-review-row" key={row.id}>
                              <div className="packet-review-row-top">
                                <span className="packet-row-number">{index + 1}</span>
                                <span className={`packet-confidence ${row.confidence}`}>{row.confidence}</span>
                                <button
                                  className="icon-button"
                                  type="button"
                                  aria-label="Remove row"
                                  onClick={() => removePacketDraftRow(row.id)}
                                >
                                  <Trash2 aria-hidden="true" />
                                </button>
                              </div>
                              <label className="field-label" htmlFor={`packetLine-${row.id}`}>Packet row</label>
                              <textarea
                                id={`packetLine-${row.id}`}
                                className="input packet-review-line"
                                value={row.packetLine}
                                onChange={e => updatePacketDraftRow(row.id, "packetLine", e.target.value)}
                              />
                              <div className="packet-review-fields">
                                <label>
                                  <span className="field-label">Qty</span>
                                  <input
                                    className="input"
                                    inputMode="numeric"
                                    value={row.expectedQty}
                                    onChange={e => updatePacketDraftRow(row.id, "expectedQty", e.target.value)}
                                  />
                                </label>
                                <label>
                                  <span className="field-label">Location hint</span>
                                  <input
                                    className="input"
                                    value={row.locationHint}
                                    placeholder="Optional"
                                    onChange={e => updatePacketDraftRow(row.id, "locationHint", e.target.value)}
                                  />
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="button-row">
                          <button className="btn btn-primary" type="submit" disabled={isSaving || isReadingPacket}>
                            <ClipboardPlus aria-hidden="true" />
                            <span>{isSaving ? "Importing..." : `Import ${sanitizePacketDraftRows(packetDraftRows).length} rows`}</span>
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </form>
                </details>
              ) : null}

              {detailItems.length ? (
                <div className="session-item-toolbar">
                  <label className="session-item-search">
                    <Search aria-hidden="true" />
                    <input
                      value={sessionItemQuery}
                      placeholder="Search rows, serial, location..."
                      onChange={e => setSessionItemQuery(e.target.value)}
                    />
                  </label>
                  <div className="session-filter-strip" aria-label="Session row filters">
                    {sessionItemFilterOptions.map(([value, label]) => (
                      <button
                        className={sessionItemFilter === value ? "active" : ""}
                        type="button"
                        key={value}
                        onClick={() => setSessionItemFilter(value)}
                      >
                        <span>{label}</span>
                        <strong>{sessionItemFilterCounts[value] || 0}</strong>
                      </button>
                    ))}
                  </div>
                  <div className="session-filter-meta">
                    <span>{visibleDetailItems.length} of {detailItems.length} shown</span>
                    {(sessionItemQuery.trim() || sessionItemFilter !== "all") ? (
                      <button
                        className="btn btn-secondary btn-small"
                        type="button"
                        onClick={() => {
                          setSessionItemQuery("");
                          setSessionItemFilter("all");
                        }}
                      >
                        <RefreshCw aria-hidden="true" />
                        <span>Reset</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="session-items">
                {visibleDetailItems.length ? visibleDetailItems.map(item => {
                  const submission = latestSubmission(item);
                  const needsMoreProof = submission?.reviewState === "request_more_info";
                  const pendingProof = submission?.reviewState === "pending";
                  const knownLocation = item.inventoryItem?.currentLocation || "";
                  const knownDescription = item.inventoryItem?.description || "";
                  const imageUrls = getInventoryItemImages(item.inventoryItem);
                  return (
                    <article className={`session-item ${needsMoreProof ? "needs-response" : ""}`} key={item.id}>
                      <div className="session-item-main">
                        <FileText aria-hidden="true" />
                        <div>
                          <strong>{item.inventoryItem?.commonName || item.inventoryItem?.title || item.packetLine || "Untitled row"}</strong>
                          {item.inventoryItem ? (
                            <small className="session-known-item">
                              Matched known item
                              {item.inventoryItem.lin ? ` - LIN ${item.inventoryItem.lin}` : ""}
                              {item.inventoryItem.nsn ? ` - NSN ${item.inventoryItem.nsn}` : ""}
                            </small>
                          ) : null}
                          <span>{item.packetLine || "No packet text"}</span>
                          {item.locationHint ? <small>Hint: {item.locationHint}</small> : null}
                          {knownLocation && knownLocation !== item.locationHint ? <small>Known location: {knownLocation}</small> : null}
                          {knownDescription ? <small>Description: {knownDescription}</small> : null}
                          {imageUrls.length ? (
                            <div className="session-item-thumbs">
                              {imageUrls.map(url => (
                                <a href={url} target="_blank" rel="noreferrer" key={url}>
                                  <img src={url} alt={item.inventoryItem?.commonName || item.inventoryItem?.title || "Matched item"} loading="lazy" />
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {submission ? (
                            <small className={`session-proof-state ${needsMoreProof ? "requested" : ""}`}>
                              {formatReviewState(submission.reviewState)}
                            </small>
                          ) : null}
                          {needsMoreProof && submission.reviewNote ? (
                            <small className="session-proof-request">Requested: {submission.reviewNote}</small>
                          ) : null}
                        </div>
                      </div>
                      <div className="session-item-actions">
                        <span className={`status-pill ${item.status}`}>{item.status}</span>
                        {canManage ? (
                          <>
                            <button className="btn btn-secondary btn-small" type="button" onClick={() => updateDirectCheck(item.id, "approved")}>
                              <CheckCircle2 aria-hidden="true" />
                              <span>Found</span>
                            </button>
                            <button className="btn btn-secondary btn-small" type="button" onClick={() => updateDirectCheck(item.id, "not_found")}>
                              <span>Not found</span>
                            </button>
                          </>
                        ) : null}
                        {canSubmit && selectedSession.status !== "closed" ? (
                          <button className="btn btn-primary btn-small" type="button" onClick={() => setProofItemId(item.id)}>
                            <Camera aria-hidden="true" />
                            <span>{needsMoreProof ? "Respond" : pendingProof ? "Add proof" : "Proof"}</span>
                          </button>
                        ) : null}
                      </div>
                      {proofItemId === item.id ? (
                        <ProofForm
                          item={item}
                          token={token}
                          tenantSlug={tenantSlug}
                          requestNote={needsMoreProof ? submission.reviewNote : ""}
                          onCancel={() => setProofItemId("")}
                          onSaved={() => {
                            setProofItemId("");
                            loadSessions(selectedSessionId);
                          }}
                          onStatus={setStatus}
                        />
                      ) : null}
                    </article>
                  );
                }) : detailItems.length ? (
                  <EmptyPanel title="No matching rows" body="Clear the search or choose another filter." />
                ) : (
                  <EmptyPanel title="No packet rows yet" body="Paste rows from the hand receipt to build the checklist." />
                )}
              </div>
            </>
          ) : (
            <EmptyPanel title="Select a session" body="Session details and packet rows will appear here." />
          )}
        </div>
      </div>

      <StatusLine status={status} />
    </section>
  );
}

function ReviewPanel({ token, tenantSlug }) {
  const [submissions, setSubmissions] = useState([]);
  const [status, setStatus] = useState({ text: "Loading review queue...", isError: false });
  const [requestingSubmissionId, setRequestingSubmissionId] = useState("");
  const [proofRequestMessage, setProofRequestMessage] = useState("");
  const [proofRequestFields, setProofRequestFields] = useState(["serial_photo", "wide_photo"]);
  const [isRequestingProof, setIsRequestingProof] = useState(false);

  async function loadQueue() {
    try {
      setStatus({ text: "Loading review queue...", isError: false });
      const data = await apiRequest("/inventory/review-queue", { token, tenantSlug });
      setSubmissions(data.submissions || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadQueue();
  }, [tenantSlug, token]);

  async function review(submissionId, decision, note = "") {
    try {
      setStatus({ text: "Updating review...", isError: false });
      await apiRequest(`/submissions/${submissionId}/review`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { decision, note }
      });
      await loadQueue();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  function openProofRequest(submission) {
    const defaultFields = submission.serialNumber ? ["wide_photo", "location"] : ["serial_photo", "wide_photo"];
    setRequestingSubmissionId(submission.id);
    setProofRequestFields(defaultFields);
    setProofRequestMessage(buildProofRequestMessage(defaultFields));
  }

  function toggleProofRequestField(field) {
    const next = proofRequestFields.includes(field)
      ? proofRequestFields.filter(value => value !== field)
      : [...proofRequestFields, field];
    setProofRequestFields(next);
    setProofRequestMessage(buildProofRequestMessage(next));
  }

  async function sendProofRequest(e) {
    e.preventDefault();
    const message = proofRequestMessage.trim();
    if (!requestingSubmissionId || !message) {
      setStatus({ text: "Add what proof you need first.", isError: true });
      return;
    }

    try {
      setIsRequestingProof(true);
      setStatus({ text: "Sending proof request...", isError: false });
      await apiRequest(`/submissions/${requestingSubmissionId}/evidence-requests`, {
        method: "POST",
        token,
        tenantSlug,
        body: { message, requestedFields: proofRequestFields }
      });
      setRequestingSubmissionId("");
      setProofRequestMessage("");
      setProofRequestFields(["serial_photo", "wide_photo"]);
      await loadQueue();
      setStatus({ text: "Proof request sent.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsRequestingProof(false);
    }
  }

  return (
    <section className="admin-card review-panel">
      <div className="admin-card-heading">
        <span className="admin-icon">
          <MessageSquare aria-hidden="true" />
        </span>
        <div>
          <p className="eyebrow">Platoon admin review</p>
          <h2>Proof Queue</h2>
        </div>
      </div>

      <div className="review-list">
        {submissions.length ? submissions.map(submission => (
          <article className="review-card" key={submission.id}>
            <div className="review-card-main">
              <strong>{submission.sessionItem?.packetLine || "Packet row"}</strong>
              <span>{submission.session?.name} - {submission.submittedByName || submission.submittedByEmail}</span>
              {submission.locationText ? <small>Location: {submission.locationText}</small> : null}
              {submission.serialNumber ? <small>Serial: {submission.serialNumber}</small> : null}
              {submission.note ? <small>{submission.note}</small> : null}
              {submission.reviewState === "request_more_info" && submission.reviewNote ? (
                <small className="review-request-note">Requested: {submission.reviewNote}</small>
              ) : null}
            </div>

            {submission.photos?.length ? (
              <div className="review-photo-grid">
                {submission.photos.map(photo => (
                  <a href={photo.url} target="_blank" rel="noreferrer" key={photo.id || photo.storageKey}>
                    <img src={photo.url} alt={photo.caption || photo.kind || "Proof"} loading="lazy" />
                  </a>
                ))}
              </div>
            ) : null}

            {(submission.history || []).length > 1 ? (
              <div className="proof-timeline">
                <div className="proof-timeline-heading">
                  <strong>Proof history</strong>
                  <span>{submission.history.length} submissions</span>
                </div>
                <div className="proof-timeline-list">
                  {submission.history.map(historyItem => (
                    <div className={`proof-timeline-entry ${historyItem.id === submission.id ? "current" : ""}`} key={historyItem.id}>
                      <div className="proof-timeline-dot" aria-hidden="true" />
                      <div className="proof-timeline-body">
                        <div className="proof-timeline-top">
                          <strong>{formatReviewState(historyItem.reviewState)}</strong>
                          <span>{formatDate(historyItem.createdAt)}</span>
                        </div>
                        <small>{submissionPerson(historyItem)}</small>
                        <div className="proof-timeline-facts">
                          <span>{historyItem.status}</span>
                          {historyItem.locationText ? <span>{historyItem.locationText}</span> : null}
                          {historyItem.serialNumber ? <span>SN {historyItem.serialNumber}</span> : null}
                        </div>
                        {historyItem.note ? <small className="proof-timeline-note">{historyItem.note}</small> : null}
                        {historyItem.reviewState === "request_more_info" && historyItem.reviewNote ? (
                          <small className="proof-timeline-request">Requested: {historyItem.reviewNote}</small>
                        ) : null}
                        {historyItem.photos?.length ? (
                          <div className="proof-timeline-photos">
                            {historyItem.photos.map(photo => (
                              <a href={photo.url} target="_blank" rel="noreferrer" key={photo.id || photo.storageKey}>
                                <img src={photo.url} alt={photo.caption || photo.kind || "Proof"} loading="lazy" />
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="review-actions">
              <button className="btn btn-primary btn-small" type="button" onClick={() => review(submission.id, "approved")}>
                <CheckCircle2 aria-hidden="true" />
                <span>Approve</span>
              </button>
              <button
                className="btn btn-secondary btn-small"
                type="button"
                onClick={() => openProofRequest(submission)}
              >
                <Camera aria-hidden="true" />
                <span>More proof</span>
              </button>
              <button className="btn btn-danger-soft btn-small" type="button" onClick={() => review(submission.id, "rejected")}>
                <XCircle aria-hidden="true" />
                <span>Reject</span>
              </button>
            </div>

            {requestingSubmissionId === submission.id ? (
              <form className="proof-request-form" onSubmit={sendProofRequest}>
                <div className="proof-request-chips" aria-label="Requested proof">
                  {proofRequestOptions.map(option => (
                    <button
                      className={proofRequestFields.includes(option.value) ? "active" : ""}
                      type="button"
                      key={option.value}
                      onClick={() => toggleProofRequestField(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <label className="field-label" htmlFor={`proofRequest-${submission.id}`}>Request note</label>
                <textarea
                  id={`proofRequest-${submission.id}`}
                  className="input proof-request-note"
                  value={proofRequestMessage}
                  onChange={e => setProofRequestMessage(e.target.value)}
                />
                <div className="button-row">
                  <button className="btn btn-primary btn-small" type="submit" disabled={isRequestingProof}>
                    <Send aria-hidden="true" />
                    <span>{isRequestingProof ? "Sending..." : "Send request"}</span>
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    type="button"
                    onClick={() => {
                      setRequestingSubmissionId("");
                      setProofRequestMessage("");
                    }}
                  >
                    <span>Cancel</span>
                  </button>
                </div>
              </form>
            ) : null}
          </article>
        )) : (
          <EmptyPanel title="Nothing to review" body="Submitted proof will appear here." />
        )}
      </div>

      <StatusLine status={status} />
    </section>
  );
}

function PlatformPanel({ token }) {
  const [tenants, setTenants] = useState([]);
  const [form, setForm] = useState({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
  const [status, setStatus] = useState({ text: "Loading platoons...", isError: false });
  const [isSaving, setIsSaving] = useState(false);

  async function loadTenants() {
    try {
      setStatus({ text: "Loading platoons...", isError: false });
      const data = await apiRequest("/platform/tenants", { token });
      setTenants(data.tenants || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadTenants();
  }, [token]);

  function updateForm(key, value) {
    setForm(current => {
      const next = { ...current, [key]: value };
      if (key === "name" && !current.slug) {
        next.slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      }
      return next;
    });
  }

  async function createTenant(e) {
    e.preventDefault();
    setIsSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        adminEmail: form.adminEmail.trim() || undefined,
        adminDisplayName: form.adminDisplayName.trim() || undefined
      };
      const data = await apiRequest("/platform/tenants", { method: "POST", token, body });
      setForm({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
      setStatus({ text: `Created ${data.tenant.slug}.${appConfig.baseDomain}`, isError: false });
      await loadTenants();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="admin-grid">
      <section className="admin-card">
        <div className="admin-card-heading">
          <span className="admin-icon">
            <Building2 aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">Root</p>
            <h2>Create platoon</h2>
          </div>
        </div>

        <form className="admin-form" onSubmit={createTenant}>
          <label className="field-label" htmlFor="tenantName">Platoon name</label>
          <input
            id="tenantName"
            className="input"
            required
            value={form.name}
            placeholder="1st Platoon"
            onChange={e => updateForm("name", e.target.value)}
          />

          <label className="field-label" htmlFor="tenantSlug">Subdomain</label>
          <div className="input-suffix-row">
            <input
              id="tenantSlug"
              className="input"
              required
              pattern="[a-z0-9-]+"
              value={form.slug}
              placeholder="1st"
              onChange={e => updateForm("slug", e.target.value.toLowerCase())}
            />
            <span>.{appConfig.baseDomain}</span>
          </div>

          <label className="field-label" htmlFor="tenantAdminEmail">Platoon admin email</label>
          <input
            id="tenantAdminEmail"
            className="input"
            type="email"
            value={form.adminEmail}
            placeholder="admin@example.com"
            onChange={e => updateForm("adminEmail", e.target.value)}
          />

          <label className="field-label" htmlFor="tenantAdminName">Platoon admin name</label>
          <input
            id="tenantAdminName"
            className="input"
            value={form.adminDisplayName}
            placeholder="PSG Smith"
            onChange={e => updateForm("adminDisplayName", e.target.value)}
          />

          <button className="btn btn-primary btn-full" type="submit" disabled={isSaving}>
            <Plus aria-hidden="true" />
            <span>{isSaving ? "Creating..." : "Create platoon"}</span>
          </button>
        </form>

        <StatusLine status={status} />
      </section>

      <section className="admin-card admin-card-wide">
        <div className="admin-card-heading">
          <span className="admin-icon">
            <Users aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">Workspaces</p>
            <h2>Platoons</h2>
          </div>
        </div>

        {tenants.length ? (
          <div className="admin-list">
            {tenants.map(tenant => (
              <article className="admin-list-row" key={tenant.id}>
                <div>
                  <strong>{tenant.name}</strong>
                  <span>{tenant.slug}.{appConfig.baseDomain}</span>
                </div>
                <div className="admin-row-meta">
                  <span className="badge">{tenant.memberCount} members</span>
                  <span className="badge">{tenant.adminCount} admins</span>
                  <a className="btn btn-secondary btn-small" href={`https://${tenant.slug}.${appConfig.baseDomain}/#/admin`}>
                    <span>Open</span>
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyPanel title="No platoons yet" body="Create the first workspace to start assigning inventory." />
        )}
      </section>
    </div>
  );
}

function TenantPanel({ token, tenantSlug, me }) {
  const isTenantAdmin = Boolean(me?.isPlatformAdmin || me?.membership?.role === "tenant_admin");
  const canSubmitProof = Boolean(isTenantAdmin || me?.membership?.role === "contributor");
  const tabs = isTenantAdmin
    ? [
        ["tasks", "Tasks"],
        ["review", "Review"],
        ["people", "People"]
      ]
    : [["tasks", "Tasks"]];
  const [activeTab, setActiveTab] = useState("tasks");
  const [tenant, setTenant] = useState(null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [inviteForm, setInviteForm] = useState({ email: "", displayName: "", role: "contributor" });
  const [status, setStatus] = useState({ text: "Loading tenant...", isError: false });
  const [lastInviteUrl, setLastInviteUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function loadTenant() {
    try {
      setStatus({ text: "Loading tenant...", isError: false });
      const tenantData = await apiRequest("/tenant", { token, tenantSlug });
      setTenant(tenantData.tenant);

      if (isTenantAdmin) {
        const [memberData, inviteData] = await Promise.all([
          apiRequest("/tenant/members", { token, tenantSlug }),
          apiRequest("/tenant/invitations", { token, tenantSlug })
        ]);
        setMembers(memberData.members || []);
        setInvitations(inviteData.invitations || []);
      } else {
        setMembers([]);
        setInvitations([]);
      }

      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    if (tenantSlug) loadTenant();
  }, [tenantSlug, token, isTenantAdmin]);

  async function createInvite(e) {
    e.preventDefault();
    setIsSaving(true);
    setLastInviteUrl("");
    try {
      const data = await apiRequest("/tenant/invitations", {
        method: "POST",
        token,
        tenantSlug,
        body: {
          email: inviteForm.email.trim(),
          displayName: inviteForm.displayName.trim() || undefined,
          role: inviteForm.role
        }
      });
      setInviteForm({ email: "", displayName: "", role: "contributor" });
      setLastInviteUrl(data.invitation?.inviteUrl || "");
      setStatus({ text: "Invite created", isError: false });
      await loadTenant();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function revokeInvitation(invitationId) {
    try {
      await apiRequest(`/tenant/invitations/${invitationId}/revoke`, { method: "POST", token, tenantSlug });
      setStatus({ text: "Invite revoked", isError: false });
      await loadTenant();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  if (!tenantSlug) {
    return <EmptyPanel title="No platoon selected" body="Open a platoon subdomain to manage members." />;
  }

  return (
    <>
      <nav className="workspace-tabs" aria-label="Workspace views">
        {tabs.map(([id, label]) => (
          <button
            className={activeTab === id ? "active" : ""}
            type="button"
            key={id}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {activeTab === "tasks" ? (
        <SessionPanel
          token={token}
          tenantSlug={tenantSlug}
          canManage={isTenantAdmin}
          canSubmit={canSubmitProof}
        />
      ) : null}

      {activeTab === "review" && isTenantAdmin ? (
        <ReviewPanel token={token} tenantSlug={tenantSlug} />
      ) : null}

      {activeTab === "people" && isTenantAdmin ? (
        <div className="admin-grid people-grid">
        <section className="admin-card">
          <div className="admin-card-heading">
            <span className="admin-icon">
              <MailPlus aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">{tenant?.name || `${tenantSlug} platoon`}</p>
              <h2>Invite helper</h2>
            </div>
          </div>

          <form className="admin-form" onSubmit={createInvite}>
            <label className="field-label" htmlFor="inviteEmail">Email</label>
            <input
              id="inviteEmail"
              className="input"
              type="email"
              required
              value={inviteForm.email}
              placeholder="nco@example.com"
              onChange={e => setInviteForm(current => ({ ...current, email: e.target.value }))}
            />

            <label className="field-label" htmlFor="inviteName">Name</label>
            <input
              id="inviteName"
              className="input"
              value={inviteForm.displayName}
              placeholder="SSG Jones"
              onChange={e => setInviteForm(current => ({ ...current, displayName: e.target.value }))}
            />

            <label className="field-label" htmlFor="inviteRole">Role</label>
            <select
              id="inviteRole"
              className="select"
              value={inviteForm.role}
              onChange={e => setInviteForm(current => ({ ...current, role: e.target.value }))}
            >
              <option value="contributor">Contributor</option>
              <option value="viewer">Viewer</option>
              <option value="tenant_admin">Platoon admin</option>
            </select>

            <button className="btn btn-primary btn-full" type="submit" disabled={isSaving}>
              <Send aria-hidden="true" />
              <span>{isSaving ? "Sending..." : "Send invite"}</span>
            </button>
          </form>

          {lastInviteUrl ? (
            <div className="admin-copy-box">
              <span>Invite link</span>
              <a href={lastInviteUrl}>{lastInviteUrl}</a>
            </div>
          ) : null}

          <StatusLine status={status} />
        </section>

        <section className="admin-card admin-card-wide">
          <div className="admin-card-heading">
            <span className="admin-icon">
              <UserPlus aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">People</p>
              <h2>Members</h2>
            </div>
          </div>

          {members.length ? (
            <div className="admin-list">
              {members.map(member => (
                <article className="admin-list-row" key={member.id}>
                  <div>
                    <strong>{member.displayName || member.email}</strong>
                    <span>{member.email}</span>
                  </div>
                  <div className="admin-row-meta">
                    <span className="badge">{formatRole(member.role)}</span>
                    <span className="badge">{member.status}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyPanel title="No members loaded" body="Invite helpers once the platoon admin account is active." />
          )}

          <div className="admin-subsection">
            <h3>Pending invites</h3>
            {invitations.length ? (
              <div className="admin-list compact">
                {invitations.map(invite => (
                  <article className="admin-list-row" key={invite.id}>
                    <div>
                      <strong>{invite.email}</strong>
                      <span>{formatRole(invite.role)} - expires {formatDate(invite.expiresAt)}</span>
                    </div>
                    <div className="admin-row-meta">
                      <span className="badge">{invite.status}</span>
                      {invite.status === "pending" ? (
                        <button className="btn btn-secondary btn-small" type="button" onClick={() => revokeInvitation(invite.id)}>
                          <span>Revoke</span>
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyPanel title="No pending invites" body="New invitations will appear here." />
            )}
          </div>
        </section>
      </div>
      ) : null}
    </>
  );
}

export default function AdminConsole() {
  const tenantSlug = useMemo(() => getTenantSlugFromHostname(), []);
  const [session, setSession] = useState(() => readAuthSession());
  const [me, setMe] = useState(null);
  const [manualToken, setManualToken] = useState("");
  const [status, setStatus] = useState({ text: "Checking access...", isError: false });
  const token = getSessionAccessToken(session);

  async function loadMe(activeToken = token) {
    if (!activeToken) {
      setMe(null);
      setStatus({ text: "", isError: false });
      return;
    }

    try {
      setStatus({ text: "Checking access...", isError: false });
      const data = await apiRequest("/me", { token: activeToken, tenantSlug });
      setMe(data);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setMe(null);
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    let ignore = false;

    async function handleRedirect() {
      try {
        const redirectedSession = await completeOidcRedirect();
        if (redirectedSession && !ignore) {
          setSession(redirectedSession);
          await loadMe(redirectedSession.accessToken);
          return;
        }
      } catch (error) {
        if (!ignore) setStatus({ text: error.message || "Login failed", isError: true });
      }

      if (!ignore) await loadMe(token);
    }

    handleRedirect();
    return () => {
      ignore = true;
    };
  }, []);

  function logout() {
    clearAuthSession();
    clearQaIdentity();
    setSession(null);
    setMe(null);
    setStatus({ text: "", isError: false });
  }

  function saveManualToken() {
    const accessToken = manualToken.trim();
    if (!accessToken) return;
    const nextSession = {
      accessToken,
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now(),
      manual: true
    };
    saveAuthSession(nextSession);
    setSession(nextSession);
    setManualToken("");
    loadMe(accessToken);
  }

  function useQaIdentity(kind) {
    const identities = {
      root: {
        sub: "qa-root",
        email: "qa-root@876en.test",
        name: "QA Root Admin",
        groups: ["876en-admins"]
      },
      lead: {
        sub: "qa-lead",
        email: "qa-lead@876en.test",
        name: "QA Platoon Admin",
        groups: ["876en-ms", "876en-platoon-admin"]
      },
      nco: {
        sub: "qa-nco",
        email: "qa-nco@876en.test",
        name: "QA NCO",
        groups: ["876en-ms"]
      }
    };
    const identity = identities[kind] || identities.root;
    saveQaIdentity(identity);
    const nextSession = {
      accessToken: "qa-dev",
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      createdAt: Date.now(),
      qa: true
    };
    saveAuthSession(nextSession);
    setSession(nextSession);
    setStatus({ text: `Using ${identity.name}`, isError: false });
    loadMe(nextSession.accessToken);
  }

  async function signIn() {
    try {
      setStatus({ text: "Redirecting to Authentik...", isError: false });
      await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
    } catch (error) {
      setStatus({ text: error.message || "Could not start login", isError: true });
    }
  }

  const isPlatformPage = isAdminHostname() || !tenantSlug;
  const canUsePlatform = Boolean(me?.isPlatformAdmin);
  const canUseTenant = Boolean(
    tenantSlug && (me?.isPlatformAdmin || ["tenant_admin", "contributor", "viewer"].includes(me?.membership?.role))
  );

  return (
    <div className="app-frame admin-frame">
      <AdminHeader me={me} tenantSlug={tenantSlug} onRefresh={() => loadMe()} onLogout={logout} />

      {!token || !me ? (
        <AuthPanel
          status={status}
          manualToken={manualToken}
          onManualTokenChange={setManualToken}
          onManualTokenSave={saveManualToken}
          onSignIn={signIn}
          onUseQaIdentity={useQaIdentity}
        />
      ) : (
        <>
          <section className="admin-profile-strip">
            <span className="badge strong">{me.user?.display_name || me.user?.email}</span>
            {me.isPlatformAdmin ? <span className="badge">Platform admin</span> : null}
            {me.isFrgAdmin && !me.isPlatformAdmin ? <span className="badge">FRG admin</span> : null}
            {me.membership?.role ? <span className="badge">{formatRole(me.membership.role)}</span> : null}
          </section>

          {isPlatformPage ? (
            canUsePlatform
              ? <PlatformPanel token={token} />
              : <EmptyPanel title="Platform access required" body="This account can sign in, but it is not a root admin." />
          ) : canUseTenant ? (
            <TenantPanel token={token} tenantSlug={tenantSlug} me={me} />
          ) : (
            <EmptyPanel title="Platoon admin access required" body="This account is not assigned as a platoon admin here." />
          )}
        </>
      )}
    </div>
  );
}
