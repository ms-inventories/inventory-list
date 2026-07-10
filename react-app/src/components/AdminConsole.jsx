import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  Building2,
  Camera,
  CheckCircle2,
  Copy,
  ClipboardList,
  ClipboardPlus,
  CalendarDays,
  ChevronDown,
  Download,
  FileText,
  FileUp,
  Home,
  ListChecks,
  LogIn,
  LogOut,
  MailPlus,
  Megaphone,
  Menu,
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
import {
  createPacketDraftRows,
  packetMimeTypeForFile,
  parsePacketRows,
  sanitizePacketDraftRows
} from "../lib/packetParser.js";

const roleLabels = {
  tenant_admin: "Platoon admin",
  contributor: "Contributor",
  viewer: "Viewer"
};

const tenantRoleOptions = [
  { value: "tenant_admin", label: "Platoon admin" },
  { value: "contributor", label: "Contributor" },
  { value: "viewer", label: "Viewer" }
];

function formatRole(role) {
  return roleLabels[role] || role || "Member";
}

function formatMemberStatus(status) {
  return {
    active: "Active",
    invited: "Invited",
    disabled: "Disabled"
  }[status] || status || "Unknown";
}

function formatAccessSource(source) {
  return {
    database: "App database",
    authentik: "Authentik group",
    platform_admin: "Platform admin override"
  }[source] || "No tenant access";
}

function formatAccessMembership(membership) {
  if (!membership) return "Not assigned";
  return `${formatRole(membership.role)} - ${formatMemberStatus(membership.status)}`;
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatShortDate(value) {
  if (!value) return "Not recorded";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatRelativeTime(value) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const units = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1]
  ];
  const [unit, secondsPerUnit] = units.find(([, seconds]) => absSeconds >= seconds) || ["second", 1];
  const amount = Math.round(diffSeconds / secondsPerUnit);

  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
  } catch {
    return formatDate(value);
  }
}

function notificationIconFor(type) {
  return {
    proof_submitted: ClipboardList,
    proof_request: MessageSquare,
    assignment: ListChecks,
    packet_import: FileUp,
    session_closed: CheckCircle2
  }[type] || Bell;
}

function notificationSummaryText(count, isLoading) {
  if (isLoading) return "Checking...";
  if (!count) return "No unread items";
  return `${count} unread`;
}

function formatInviteStatus(status) {
  const labels = {
    pending: "Pending",
    accepted: "Accepted",
    revoked: "Revoked",
    expired: "Expired"
  };
  return labels[status] || status || "Unknown";
}

function inviteCanBeRefreshed(invite) {
  return ["pending", "expired"].includes(invite?.status);
}

function inviteCanBeRevoked(invite) {
  return ["pending", "expired"].includes(invite?.status);
}

function inviteTimeline(invite) {
  if (!invite) return "";
  if (invite.status === "accepted") return `Accepted ${formatDate(invite.acceptedAt)}`;
  if (invite.status === "revoked") return `Revoked ${formatDate(invite.revokedAt)}`;
  if (invite.status === "expired") return `Expired ${formatDate(invite.expiresAt)}`;
  return `Expires ${formatDate(invite.expiresAt)}`;
}

async function copyText(value) {
  const text = String(value || "");
  try {
    if (globalThis.navigator?.clipboard && globalThis.window?.isSecureContext) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea copy path.
  }

  if (!globalThis.document) return false;
  const textarea = globalThis.document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  globalThis.document.body.appendChild(textarea);
  textarea.select();

  try {
    return globalThis.document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function EmptyPanel({ title, body, action = null }) {
  return (
    <div className="admin-empty">
      <strong>{title}</strong>
      <span>{body}</span>
      {action ? <div className="admin-empty-action">{action}</div> : null}
    </div>
  );
}

function AdminHeader({ me, tenantSlug, mode = "", onRefresh, onLogout }) {
  const adminHost = isAdminHostname();
  const isNewsletterMode = mode === "newsletter";
  const title = isNewsletterMode ? "Newsletter Admin" : adminHost || !tenantSlug ? "Platform Admin" : "Platoon Admin";
  const subtitle = isNewsletterMode
    ? "Publish public FRG updates and manage newsletter subscribers."
    : adminHost || !tenantSlug
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
  const showQaUsers = appConfig.enableQaAuth;
  const showManualToken = appConfig.enableManualTokenAuth;

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

      {showQaUsers ? (
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
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("frg")}>
              <span>Newsletter admin</span>
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("nco")}>
              <span>NCO</span>
            </button>
          </div>
        </details>
      ) : null}

      {showManualToken ? (
        <details className="disclosure">
          <summary className="btn btn-secondary">
            <span>Developer access token</span>
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
      ) : null}

      <StatusLine status={status} />
    </section>
  );
}

function StatusLine({ status }) {
  if (!status?.text) return null;
  return <div className={`admin-status ${status.isError ? "error" : ""}`}>{status.text}</div>;
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

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

function tenantHost(tenant) {
  return `${tenant.slug}.${appConfig.baseDomain}`;
}

function tenantDisplayName(tenant) {
  const rawName = String(tenant.name || "").trim();
  const host = tenantHost(tenant).toLowerCase();
  const slug = String(tenant.slug || "").toLowerCase();
  const domain = String(appConfig.baseDomain || "").toLowerCase();

  if (!rawName) return `${String(tenant.slug || "Platoon").toUpperCase()} Platoon`;

  const normalized = rawName.toLowerCase();
  if (normalized === slug || normalized === host || normalized.endsWith(`.${domain}`)) {
    return `${String(tenant.slug || "Platoon").toUpperCase()} Platoon`;
  }

  return rawName;
}

function tenantInitials(tenant) {
  const displayName = tenantDisplayName(tenant).replace(/\bplatoon\b/gi, "").trim() || tenant.slug || "P";
  const parts = displayName.split(/[\s.-]+/).filter(Boolean);
  if (parts.length < 2) return String(parts[0] || "P").slice(0, 2).toUpperCase();
  return parts.slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

const newsletterDraftTemplate = {
  title: "Black Shadow Company Newsletter",
  editionLabel: "First issue",
  summary: "Family updates, event reminders, and resources for the 876 EN community.",
  body: [
    "Welcome to the Black Shadow Company newsletter.",
    "",
    "This issue is ready for the FRG team to update with current family readiness notes, event reminders, and useful resources.",
    "",
    "Upcoming focus",
    "- Family readiness announcements",
    "- Drill weekend reminders",
    "- Support resources and contact notes",
    "",
    "For questions, contact the company FRG team."
  ].join("\n")
};

const contentBlockTypes = [
  { value: "announcement", label: "Announcement" },
  { value: "event", label: "Event" },
  { value: "resource", label: "Resource" }
];

const contentBlockStatuses = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "hidden", label: "Hidden" }
];

const frgContentTemplate = {
  blockType: "announcement",
  title: "",
  summary: "",
  body: "",
  href: "",
  linkLabel: "",
  eventAt: "",
  sortOrder: 100,
  status: "draft"
};

function contentTypeLabel(value) {
  return contentBlockTypes.find(type => type.value === value)?.label || value || "Content";
}

function dateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function newsletterIssueForm(issue = newsletterDraftTemplate) {
  return {
    title: issue.title || "",
    editionLabel: issue.editionLabel || "",
    summary: issue.summary || "",
    body: issue.body || ""
  };
}

function frgContentForm(block = frgContentTemplate) {
  return {
    blockType: block.blockType || "announcement",
    title: block.title || "",
    summary: block.summary || "",
    body: block.body || "",
    href: block.href || "",
    linkLabel: block.linkLabel || "",
    eventAt: dateTimeLocalValue(block.eventAt),
    sortOrder: Number(block.sortOrder ?? 100),
    status: block.status || "draft"
  };
}

function frgContentPayload(form) {
  return {
    blockType: form.blockType,
    title: form.title.trim(),
    summary: form.summary.trim() || undefined,
    body: form.body.trim() || undefined,
    href: form.href.trim() || undefined,
    linkLabel: form.linkLabel.trim() || undefined,
    eventAt: form.eventAt ? new Date(form.eventAt).toISOString() : undefined,
    sortOrder: Number(form.sortOrder || 100),
    status: form.status
  };
}

function newsletterPayload(form) {
  return {
    title: form.title.trim(),
    editionLabel: form.editionLabel.trim() || undefined,
    summary: form.summary.trim() || undefined,
    body: form.body.trim()
  };
}

function newsletterBodyParagraphs(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

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

function SessionPanel({ token, tenantSlug, canManage, canSubmit, uploadIntent, onUploadIntentHandled, onOpenGuidance }) {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [packetRows, setPacketRows] = useState("");
  const [packetDraftRows, setPacketDraftRows] = useState([]);
  const [packetSourceName, setPacketSourceName] = useState("");
  const [packetSourceFile, setPacketSourceFile] = useState(null);
  const [isPacketImportOpen, setIsPacketImportOpen] = useState(false);
  const [packetWizardOpen, setPacketWizardOpen] = useState(false);
  const [packetWizardStep, setPacketWizardStep] = useState(1);
  const [packetWizardMode, setPacketWizardMode] = useState("existing");
  const [packetWizardSessionId, setPacketWizardSessionId] = useState("");
  const [packetWizardSessionName, setPacketWizardSessionName] = useState("");
  const [packetWizardSummary, setPacketWizardSummary] = useState(null);
  const [sessionItemQuery, setSessionItemQuery] = useState("");
  const [sessionItemFilter, setSessionItemFilter] = useState("all");
  const [proofItemId, setProofItemId] = useState("");
  const [status, setStatus] = useState({ text: "Loading inventory sessions...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const [isReadingPacket, setIsReadingPacket] = useState(false);
  const [printReportId, setPrintReportId] = useState("");
  const packetFileInputRef = useRef(null);
  const packetTextareaRef = useRef(null);
  const sessionListRequestRef = useRef(0);
  const sessionDetailRequestRef = useRef(0);
  const isPacketUploadIntent = uploadIntent === "packet" || isPacketImportOpen;

  async function loadSessions(nextSelectedId = selectedSessionId) {
    const requestId = sessionListRequestRef.current + 1;
    sessionListRequestRef.current = requestId;

    try {
      setStatus({ text: "Loading inventory sessions...", isError: false });
      const data = await apiRequest("/inventory/sessions", { token, tenantSlug });
      if (requestId !== sessionListRequestRef.current) return;

      const loaded = sortSessionsByAttention(data.sessions || []);
      setSessions(loaded);
      const selected = nextSelectedId && loaded.some(session => session.id === nextSelectedId && session.status !== "closed")
        ? nextSelectedId
        : loaded.find(session => session.status !== "closed")?.id || "";
      setSelectedSessionId(selected);
      let detailLoaded = true;
      if (selected) {
        detailLoaded = await loadSessionDetail(selected, false, requestId);
      } else {
        sessionDetailRequestRef.current += 1;
        setDetail(null);
        setPacketWizardSessionId("");
        setIsPacketImportOpen(false);
        clearPacketImport();
      }

      if (detailLoaded && requestId === sessionListRequestRef.current) {
        setStatus({ text: "", isError: false });
      }
    } catch (error) {
      if (requestId === sessionListRequestRef.current) {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
    }
  }

  async function loadSessionDetail(sessionId = selectedSessionId, showStatus = true, sessionListRequestId = null) {
    if (!sessionId) {
      setDetail(null);
      return true;
    }

    const requestId = sessionDetailRequestRef.current + 1;
    sessionDetailRequestRef.current = requestId;

    try {
      if (showStatus) setStatus({ text: "Loading session...", isError: false });
      const data = await apiRequest(`/inventory/sessions/${sessionId}`, { token, tenantSlug });
      if (requestId !== sessionDetailRequestRef.current) return false;
      if (sessionListRequestId && sessionListRequestId !== sessionListRequestRef.current) return false;

      setDetail(data);
      setStatus({ text: "", isError: false });
      return true;
    } catch (error) {
      if (requestId === sessionDetailRequestRef.current && (!sessionListRequestId || sessionListRequestId === sessionListRequestRef.current)) {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
    }
  }

  useEffect(() => {
    loadSessions();
  }, [tenantSlug, token]);

  useEffect(() => {
    if (uploadIntent !== "packet") return;
    openPacketWizard();
    setStatus({ text: "", isError: false });
    onUploadIntentHandled?.();
  }, [uploadIntent, onUploadIntentHandled]);

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

  function openPacketWizard(sessionId = selectedSessionId) {
    const fallbackSessionId = sessionId || selectedSessionId || openSessions[0]?.id || "";
    clearPacketImport();
    setPacketWizardOpen(true);
    setPacketWizardStep(1);
    setPacketWizardSummary(null);
    setPacketWizardMode(fallbackSessionId ? "existing" : "new");
    setPacketWizardSessionId(fallbackSessionId);
    setPacketWizardSessionName("");
    setIsPacketImportOpen(false);
    setStatus({ text: "", isError: false });
  }

  function closePacketWizard() {
    clearPacketImport();
    setPacketWizardOpen(false);
    setPacketWizardStep(1);
    setPacketWizardMode("existing");
    setPacketWizardSessionId("");
    setPacketWizardSessionName("");
    setPacketWizardSummary(null);
    setIsPacketImportOpen(false);
    setStatus({ text: "", isError: false });
  }

  async function preparePacketWizardSession() {
    if (packetWizardMode === "existing") {
      const sessionId = packetWizardSessionId || selectedSessionId;
      if (!sessionId) {
        setStatus({ text: "Choose a session or create a new one first.", isError: true });
        return "";
      }

      setSelectedSessionId(sessionId);
      await loadSessionDetail(sessionId, false);
      setPacketWizardSessionId(sessionId);
      setPacketWizardStep(2);
      setStatus({ text: "", isError: false });
      return sessionId;
    }

    const name = packetWizardSessionName.trim();
    if (!name) {
      setStatus({ text: "Name the inventory session first.", isError: true });
      return "";
    }

    try {
      setIsSaving(true);
      const data = await apiRequest("/inventory/sessions", {
        method: "POST",
        token,
        tenantSlug,
        body: { name, status: "active" }
      });
      setNewSessionName("");
      setPacketWizardSessionName("");
      setPacketWizardMode("existing");
      setPacketWizardSessionId(data.session.id);
      setSelectedSessionId(data.session.id);
      await loadSessions(data.session.id);
      setPacketWizardStep(2);
      setStatus({ text: `Started ${data.session.name}`, isError: false });
      return data.session.id;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return "";
    } finally {
      setIsSaving(false);
    }
  }

  function reviewPacketRows(sourceText = packetRows, sourceName = packetSourceName, sessionId = selectedSessionId) {
    if (!sessionId) {
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
      const rows = reviewPacketRows(text, file.name, packetWizardSessionId || selectedSessionId);
      if (rows.length) setPacketWizardStep(3);
    } catch (error) {
      setStatus({ text: error.message || "Could not read packet file.", isError: true });
    } finally {
      setIsReadingPacket(false);
    }
  }

  function openPacketFilePicker(sessionId = selectedSessionId) {
    if (!sessionId) {
      setIsPacketImportOpen(true);
      setStatus({ text: "Start or select an inventory session before uploading the packet.", isError: true });
      return;
    }
    packetFileInputRef.current?.click();
  }

  function updatePacketDraftRow(rowId, field, value) {
    setPacketDraftRows(rows => rows.map(row => row.id === rowId ? { ...row, [field]: value } : row));
  }

  function removePacketDraftRow(rowId) {
    setPacketDraftRows(rows => rows.filter(row => row.id !== rowId));
  }

  function clearPacketImport(options = {}) {
    setPacketRows("");
    setPacketDraftRows([]);
    setPacketSourceName("");
    setPacketSourceFile(null);
    if (options.clearStatus) setStatus({ text: "", isError: false });
  }

  function reviewWizardPacketRows() {
    const rows = reviewPacketRows(packetRows, packetSourceName, packetWizardSessionId || selectedSessionId);
    if (rows.length) setPacketWizardStep(3);
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

  async function importPacketRowsToSession(targetSessionId = selectedSessionId) {
    if (!targetSessionId) {
      setStatus({ text: "Create or select a session first.", isError: true });
      return null;
    }

    const reviewedRows = packetDraftRows.length ? packetDraftRows : reviewPacketRows();
    const items = sanitizePacketDraftRows(reviewedRows);
    if (!items.length) {
      setStatus({ text: "Review at least one valid packet row first.", isError: true });
      return null;
    }

    const sourceName = packetSourceName || packetSourceFile?.fileName || "Pasted packet text";
    const importBatch = {
      sourceName,
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
      await apiRequest(`/inventory/sessions/${targetSessionId}/items/bulk`, {
        method: "POST",
        token,
        tenantSlug,
        body: { items, importBatch }
      });
      clearPacketImport();
      setStatus({ text: `Added ${items.length} packet rows.`, isError: false });
      await loadSessions(targetSessionId);
      return { count: items.length, sourceName, sessionId: targetSessionId };
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function addPacketRows(e) {
    e.preventDefault();
    await importPacketRowsToSession();
  }

  async function finishPacketWizardImport() {
    const summary = await importPacketRowsToSession(packetWizardSessionId || selectedSessionId);
    if (!summary) return;
    setPacketWizardSummary(summary);
    setPacketWizardStep(4);
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
    const sessionId = selectedSessionId;

    try {
      await apiRequest(`/inventory/sessions/${sessionId}`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { status: nextStatus }
      });
      setStatus({ text: `Session marked ${nextStatus}.`, isError: false });
      await loadSessions(nextStatus === "closed" ? "" : sessionId);
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

  useEffect(() => {
    if (!packetWizardOpen || packetWizardStep !== 1 || packetWizardSessionId || packetWizardSessionName.trim()) return;
    const fallbackSessionId = openSessions[0]?.id || "";
    if (!fallbackSessionId) return;
    setPacketWizardMode("existing");
    setPacketWizardSessionId(fallbackSessionId);
  }, [packetWizardOpen, packetWizardStep, packetWizardSessionId, packetWizardSessionName, openSessions]);

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
        {onOpenGuidance ? (
          <button className="btn btn-secondary btn-small admin-card-heading-action" type="button" onClick={onOpenGuidance}>
            <BookOpen aria-hidden="true" />
            <span>Guidance</span>
          </button>
        ) : null}
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
                {isPacketUploadIntent && !selectedSession ? (
                  <div className="session-intent-note">
                    <FileUp aria-hidden="true" />
                    <span>Start a session first. The packet importer will open after the session is selected.</span>
                  </div>
                ) : null}
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
              <EmptyPanel
                title="No sessions yet"
                body="Start with the packet upload flow. It will create the session and keep the imported rows attached to it."
                action={canManage ? (
                  <button className="btn btn-primary btn-small" type="button" onClick={() => openPacketWizard()}>
                    <FileUp aria-hidden="true" />
                    <span>Upload packet</span>
                  </button>
                ) : null}
              />
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
                <div className="packet-wizard-entry">
                  <div>
                    <strong>Packet import</strong>
                    <span>Upload a PDF, CSV, photo, or paste rows from the packet.</span>
                  </div>
                  <button className="btn btn-primary btn-small" type="button" onClick={() => openPacketWizard(selectedSession.id)}>
                    <FileUp aria-hidden="true" />
                    <span>Upload packet</span>
                  </button>
                  <input
                    ref={packetFileInputRef}
                    className="packet-hidden-file"
                    type="file"
                    accept="application/pdf,text/plain,text/csv,image/*,.pdf,.txt,.csv"
                    disabled={isReadingPacket || isSaving}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      readPacketUpload(file);
                    }}
                  />
                </div>
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
                  <EmptyPanel
                    title="No packet rows yet"
                    body="Upload a packet or paste rows from the hand receipt to start tasking the inventory."
                    action={canManage ? (
                      <button className="btn btn-primary btn-small" type="button" onClick={() => openPacketWizard(selectedSession.id)}>
                        <FileUp aria-hidden="true" />
                        <span>Upload packet</span>
                      </button>
                    ) : null}
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyPanel
              title={isPacketUploadIntent ? "Start or select a session" : "Select a session"}
              body={isPacketUploadIntent
                ? "Packet upload lives inside a session so the imported rows stay attached to the right inventory."
                : "Session details and packet rows will appear here."}
              action={canManage ? (
                <button className="btn btn-primary btn-small" type="button" onClick={() => openPacketWizard()}>
                  <FileUp aria-hidden="true" />
                  <span>{isPacketUploadIntent ? "Start upload" : "Upload packet"}</span>
                </button>
              ) : null}
            />
          )}
        </div>
      </div>

      {packetWizardOpen ? (
        <div className="modal-backdrop packet-wizard-backdrop" role="presentation">
          <div className="modal-panel packet-wizard-panel" role="dialog" aria-modal="true" aria-labelledby="packetWizardTitle">
            <div className="modal-stack packet-wizard">
              <div className="packet-wizard-heading">
                <div className="modal-heading">
                  <span className="modal-icon">
                    <FileUp aria-hidden="true" />
                  </span>
                  <div>
                    <p className="eyebrow">Packet import</p>
                    <h2 id="packetWizardTitle" className="modal-title">Upload packet</h2>
                    <p className="modal-copy">Pick the inventory session, add the packet source, review the rows, then save them.</p>
                  </div>
                </div>
                <button className="icon-button" type="button" aria-label="Close packet wizard" onClick={closePacketWizard}>
                  <XCircle aria-hidden="true" />
                </button>
              </div>

              <div className="packet-wizard-steps" aria-label="Packet import progress">
                {[
                  [1, "Session"],
                  [2, "Source"],
                  [3, "Review"],
                  [4, "Done"]
                ].map(([step, label]) => (
                  <span className={packetWizardStep === step ? "active" : packetWizardStep > step ? "complete" : ""} key={step}>
                    <strong>{step}</strong>
                    <small>{label}</small>
                  </span>
                ))}
              </div>

              {packetWizardStep === 1 ? (
                <div className="packet-wizard-section">
                  <div>
                    <h3>Choose where these rows belong</h3>
                    <p>Packet rows are saved inside one inventory session so the work stays tied to the right task.</p>
                  </div>

                  {openSessions.length ? (
                    <label className={`packet-choice ${packetWizardMode === "existing" ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="packetSessionMode"
                        checked={packetWizardMode === "existing"}
                        onChange={() => setPacketWizardMode("existing")}
                      />
                      <span>
                        <strong>Use an open session</strong>
                        <small>Best when you already started the inventory.</small>
                      </span>
                      <select
                        className="input"
                        value={packetWizardSessionId}
                        disabled={packetWizardMode !== "existing"}
                        onChange={e => setPacketWizardSessionId(e.target.value)}
                      >
                        {openSessions.map(session => (
                          <option value={session.id} key={session.id}>
                            {session.name} ({session.itemCount || 0} rows)
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  <label className={`packet-choice ${packetWizardMode === "new" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="packetSessionMode"
                      checked={packetWizardMode === "new"}
                      onChange={() => setPacketWizardMode("new")}
                    />
                    <span>
                      <strong>Start a new session</strong>
                      <small>Use this when the packet begins a new inventory task.</small>
                    </span>
                    <input
                      className="input"
                      value={packetWizardSessionName}
                      disabled={packetWizardMode !== "new"}
                      placeholder="July sensitive items"
                      onChange={e => setPacketWizardSessionName(e.target.value)}
                    />
                  </label>

                  <div className="packet-wizard-actions">
                    <button className="btn btn-secondary" type="button" onClick={closePacketWizard}>
                      <span>Cancel</span>
                    </button>
                    <button className="btn btn-primary" type="button" disabled={isSaving} onClick={preparePacketWizardSession}>
                      <span>{isSaving ? "Starting..." : "Continue"}</span>
                    </button>
                  </div>
                </div>
              ) : null}

              {packetWizardStep === 2 ? (
                <div className="packet-wizard-section">
                  <div>
                    <h3>Add the packet source</h3>
                    <p>Use a clean PDF or CSV when you have it. If the packet is messy, paste one item per line.</p>
                  </div>

                  <div className="packet-source-grid">
                    <button
                      className="packet-source-card"
                      type="button"
                      disabled={isReadingPacket || isSaving}
                      onClick={() => openPacketFilePicker(packetWizardSessionId || selectedSessionId)}
                    >
                      <FileUp aria-hidden="true" />
                      <span>
                        <strong>{isReadingPacket ? "Reading packet..." : "Choose file"}</strong>
                        <small>PDF, CSV, text, or image up to 10MB</small>
                      </span>
                    </button>
                    <button
                      className="packet-source-card"
                      type="button"
                      onClick={() => packetTextareaRef.current?.focus()}
                    >
                      <ClipboardList aria-hidden="true" />
                      <span>
                        <strong>Paste from paper</strong>
                        <small>Jump to the paste box below.</small>
                      </span>
                    </button>
                  </div>

                  {packetSourceName ? <span className="packet-import-note">Source: {packetSourceName}</span> : null}
                  {packetSourceFile?.size ? <span className="packet-import-note">Stored with import: {formatFileSize(packetSourceFile.size)}</span> : null}

                  <textarea
                    ref={packetTextareaRef}
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

                  <div className="packet-wizard-actions">
                    <button className="btn btn-secondary" type="button" onClick={() => setPacketWizardStep(1)}>
                      <span>Back</span>
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={!packetRows.trim() || isReadingPacket || isSaving}
                      onClick={reviewWizardPacketRows}
                    >
                      <ClipboardList aria-hidden="true" />
                      <span>Review rows</span>
                    </button>
                  </div>
                </div>
              ) : null}

              {packetWizardStep === 3 ? (
                <div className="packet-wizard-section packet-wizard-section-review">
                  <div>
                    <h3>Review before saving</h3>
                    <p>Clean up anything the parser guessed wrong. Low confidence rows can still be saved if the text is useful.</p>
                  </div>

                  {packetDraftRows.length ? (
                    <div className="packet-review">
                      <div className="packet-review-heading">
                        <strong>{sanitizePacketDraftRows(packetDraftRows).length} ready to import</strong>
                        <span>{packetDraftRows.length} rows found</span>
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
                    </div>
                  ) : (
                    <EmptyPanel title="No rows ready" body="Go back and choose a file or paste packet text first." />
                  )}

                  <div className="packet-wizard-actions">
                    <button className="btn btn-secondary" type="button" onClick={() => setPacketWizardStep(2)}>
                      <span>Back</span>
                    </button>
                    <button className="btn btn-secondary" type="button" onClick={() => clearPacketImport({ clearStatus: true })}>
                      <Trash2 aria-hidden="true" />
                      <span>Clear</span>
                    </button>
                    <button className="btn btn-primary" type="button" disabled={isSaving || isReadingPacket} onClick={finishPacketWizardImport}>
                      <ClipboardPlus aria-hidden="true" />
                      <span>{isSaving ? "Importing..." : `Import ${sanitizePacketDraftRows(packetDraftRows).length} rows`}</span>
                    </button>
                  </div>
                </div>
              ) : null}

              {packetWizardStep === 4 ? (
                <div className="packet-wizard-section packet-wizard-success">
                  <CheckCircle2 aria-hidden="true" />
                  <div>
                    <h3>Packet imported</h3>
                    <p>{packetWizardSummary?.count || 0} rows were added from {packetWizardSummary?.sourceName || "the packet"}.</p>
                  </div>
                  <div className="packet-wizard-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => {
                        clearPacketImport();
                        setPacketWizardSummary(null);
                        setPacketWizardStep(2);
                        setStatus({ text: "", isError: false });
                      }}
                    >
                      <FileUp aria-hidden="true" />
                      <span>Import another</span>
                    </button>
                    <button className="btn btn-primary" type="button" onClick={closePacketWizard}>
                      <ListChecks aria-hidden="true" />
                      <span>Open session</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

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

function NewsletterPanel({ token, me, onRefresh, onLogout }) {
  const [issues, setIssues] = useState([]);
  const [contentBlocks, setContentBlocks] = useState([]);
  const [subscribers, setSubscribers] = useState([]);
  const [subscriberStats, setSubscriberStats] = useState({ pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 });
  const [deliverySettings, setDeliverySettings] = useState({ emailConfigured: false });
  const [activeSection, setActiveSection] = useState("content");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedContentBlockId, setSelectedContentBlockId] = useState("");
  const [form, setForm] = useState(() => newsletterIssueForm());
  const [contentForm, setContentForm] = useState(() => frgContentForm());
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [contentTypeFilter, setContentTypeFilter] = useState("all");
  const [subscriberQuery, setSubscriberQuery] = useState("");
  const [subscriberStatusFilter, setSubscriberStatusFilter] = useState("all");
  const [reviewNotes, setReviewNotes] = useState({});
  const [status, setStatus] = useState({ text: "Loading newsletter...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [isDeletingContent, setIsDeletingContent] = useState(false);
  const [reviewingSubscriberId, setReviewingSubscriberId] = useState("");
  const [reviewingSubscriberDecision, setReviewingSubscriberDecision] = useState("");
  const roleLabel = me?.isPlatformAdmin ? "Super administrator" : "Newsletter admin";
  const selectedIssue = issues.find(issue => issue.id === selectedIssueId) || null;
  const selectedContentBlock = contentBlocks.find(block => block.id === selectedContentBlockId) || null;
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedContentQuery = contentQuery.trim().toLowerCase();
  const normalizedSubscriberQuery = subscriberQuery.trim().toLowerCase();
  const filteredContentBlocks = contentBlocks.filter(block => {
    const matchesType = contentTypeFilter === "all" || block.blockType === contentTypeFilter;
    const matchesQuery = !normalizedContentQuery || [
      block.title,
      block.summary,
      block.body,
      block.status,
      contentTypeLabel(block.blockType)
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedContentQuery);
    return matchesType && matchesQuery;
  });
  const filteredIssues = issues.filter(issue => {
    if (!normalizedQuery) return true;
    return [
      issue.title,
      issue.editionLabel,
      issue.summary,
      issue.status
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
  });
  const filteredSubscribers = subscribers.filter(subscriber => {
    const matchesStatus = subscriberStatusFilter === "all" || subscriber.status === subscriberStatusFilter;
    const matchesQuery = !normalizedSubscriberQuery || [
      subscriber.displayName,
      subscriber.email,
      subscriber.platoon,
      subscriber.supervisorName,
      subscriber.status,
      subscriber.reviewNote
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedSubscriberQuery);
    return matchesStatus && matchesQuery;
  });
  const previewLines = newsletterBodyParagraphs(form.body);

  async function loadNewsletter() {
    try {
      setStatus({ text: "Loading newsletter...", isError: false });
      const data = await apiRequest("/newsletter/admin", { token });
      const nextIssues = data.issues || [];
      const nextContentBlocks = data.contentBlocks || [];
      const nextSubscribers = data.subscribers || [];
      setIssues(nextIssues);
      setContentBlocks(nextContentBlocks);
      setSubscribers(nextSubscribers);
      setSubscriberStats(data.subscriberStats || { pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 });
      setDeliverySettings(data.deliverySettings || { emailConfigured: false });

      const hasSelectedContentBlock = selectedContentBlockId && nextContentBlocks.some(block => block.id === selectedContentBlockId);
      if (!hasSelectedContentBlock) {
        const firstBlock = nextContentBlocks[0] || null;
        setSelectedContentBlockId(firstBlock?.id || "");
        setContentForm(frgContentForm(firstBlock || frgContentTemplate));
      }

      const hasSelectedIssue = selectedIssueId && nextIssues.some(issue => issue.id === selectedIssueId);
      if (!hasSelectedIssue) {
        const firstIssue = nextIssues[0] || null;
        setSelectedIssueId(firstIssue?.id || "");
        setForm(newsletterIssueForm(firstIssue || newsletterDraftTemplate));
      }

      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadNewsletter();
  }, [token]);

  function updateForm(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function updateContentForm(key, value) {
    setContentForm(current => ({ ...current, [key]: value }));
  }

  function selectContentBlock(block) {
    setSelectedContentBlockId(block.id);
    setContentForm(frgContentForm(block));
    setStatus({ text: "", isError: false });
  }

  function startNewContentBlock() {
    setSelectedContentBlockId("");
    setContentForm(frgContentForm());
    setActiveSection("content");
    setStatus({ text: "New public content block ready", isError: false });
  }

  function selectIssue(issue) {
    setSelectedIssueId(issue.id);
    setForm(newsletterIssueForm(issue));
    setStatus({ text: "", isError: false });
  }

  function startNewDraft() {
    setSelectedIssueId("");
    setForm(newsletterIssueForm());
    setStatus({ text: "New draft ready", isError: false });
  }

  async function saveContentBlock(event) {
    event.preventDefault();
    setIsSavingContent(true);
    try {
      const payload = frgContentPayload(contentForm);
      const data = await apiRequest(
        selectedContentBlockId ? `/newsletter/admin/content-blocks/${selectedContentBlockId}` : "/newsletter/admin/content-blocks",
        {
          method: selectedContentBlockId ? "PATCH" : "POST",
          token,
          body: payload
        }
      );
      const savedBlock = data.contentBlock;
      setContentBlocks(current => {
        const exists = current.some(block => block.id === savedBlock.id);
        return exists
          ? current.map(block => block.id === savedBlock.id ? savedBlock : block)
          : [savedBlock, ...current];
      });
      setSelectedContentBlockId(savedBlock.id);
      setContentForm(frgContentForm(savedBlock));
      setStatus({ text: savedBlock.status === "published" ? "Public content published" : "Public content saved", isError: false });
      await loadNewsletter();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSavingContent(false);
    }
  }

  async function deleteContentBlock() {
    if (!selectedContentBlockId) return;
    setIsDeletingContent(true);
    try {
      await apiRequest(`/newsletter/admin/content-blocks/${selectedContentBlockId}`, {
        method: "DELETE",
        token
      });
      setContentBlocks(current => current.filter(block => block.id !== selectedContentBlockId));
      setSelectedContentBlockId("");
      setContentForm(frgContentForm());
      setStatus({ text: "Public content removed", isError: false });
      await loadNewsletter();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsDeletingContent(false);
    }
  }

  function updateReviewNote(subscriberId, value) {
    setReviewNotes(current => ({ ...current, [subscriberId]: value }));
  }

  function notificationStatusText(notification) {
    if (!notification) return "";
    if (notification.sent) return " Notification email sent.";
    if (notification.reason === "smtp_not_configured") return " Email is not configured, so no notification email was sent.";
    return " Notification email was not sent.";
  }

  async function saveIssue(event) {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = newsletterPayload(form);
      const data = await apiRequest(
        selectedIssueId ? `/newsletter/admin/issues/${selectedIssueId}` : "/newsletter/admin/issues",
        {
          method: selectedIssueId ? "PATCH" : "POST",
          token,
          body: payload
        }
      );
      const savedIssue = data.issue;
      setIssues(current => {
        const exists = current.some(issue => issue.id === savedIssue.id);
        return exists
          ? current.map(issue => issue.id === savedIssue.id ? savedIssue : issue)
          : [savedIssue, ...current];
      });
      setSelectedIssueId(savedIssue.id);
      setForm(newsletterIssueForm(savedIssue));
      setStatus({ text: selectedIssueId ? "Newsletter issue saved" : "Draft created", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function publishIssue() {
    if (!selectedIssueId) {
      setStatus({ text: "Save the draft before publishing.", isError: true });
      return;
    }

    setIsPublishing(true);
    try {
      const data = await apiRequest(`/newsletter/admin/issues/${selectedIssueId}/publish`, {
        method: "POST",
        token
      });
      const publishedIssue = data.issue;
      const delivery = data.delivery || {};
      setIssues(current => current.map(issue => issue.id === publishedIssue.id ? publishedIssue : issue));
      setForm(newsletterIssueForm(publishedIssue));
      setStatus({
        text: `Published. Delivered ${delivery.sent || 0}, skipped ${delivery.skipped || 0}, failed ${delivery.failed || 0}.`,
        isError: false
      });
      await loadNewsletter();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsPublishing(false);
    }
  }

  function exportSubscribers() {
    const rows = [
      ["Email", "Name", "Platoon", "Immediate Supervisor", "Status", "Approved/Requested", "Updated"],
      ...subscribers.map(subscriber => [
        subscriber.email,
        subscriber.displayName || "",
        subscriber.platoon || "",
        subscriber.supervisorName || "",
        subscriber.status,
        formatShortDate(subscriber.lastSubscribedAt || subscriber.createdAt),
        formatDate(subscriber.updatedAt)
      ])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    downloadTextFile(`newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  }

  async function reviewSubscriber(subscriberId, decision) {
    setReviewingSubscriberId(subscriberId);
    setReviewingSubscriberDecision(decision);
    try {
      const note = String(reviewNotes[subscriberId] || "").trim();
      const data = await apiRequest(`/newsletter/admin/subscribers/${subscriberId}/review`, {
        method: "PATCH",
        token,
        body: { decision, note }
      });
      setSubscribers(current => current.map(subscriber => (
        subscriber.id === data.subscriber.id ? data.subscriber : subscriber
      )));
      setReviewNotes(current => {
        const next = { ...current };
        delete next[subscriberId];
        return next;
      });
      setStatus({
        text: `${decision === "approved" ? "Subscriber approved for newsletter delivery." : "Subscriber request rejected."}${notificationStatusText(data.notification)}`,
        isError: false
      });
      await loadNewsletter();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setReviewingSubscriberId("");
      setReviewingSubscriberDecision("");
    }
  }

  async function refreshNewsletter() {
    await loadNewsletter();
    onRefresh?.();
  }

  const sectionMeta = {
    content: {
      title: "Public content",
      copy: "Manage public announcements, events, and resources for the homepage."
    },
    issues: {
      title: "Newsletter issues",
      copy: "Write, publish, and track Black Shadow Company newsletter updates."
    },
    subscribers: {
      title: "Subscribers",
      copy: "Review public signup requests and export newsletter contacts."
    }
  };
  const activeMeta = sectionMeta[activeSection] || sectionMeta.content;
  const publishedContentCount = contentBlocks.filter(block => block.status === "published").length;

  return (
    <div className="platform-shell newsletter-shell">
      <aside className="platform-sidebar newsletter-sidebar">
        <div className="platform-brand">
          <MailPlus aria-hidden="true" />
          <strong>FRG Newsletter</strong>
        </div>

        <nav className="platform-nav" aria-label="Newsletter admin">
          <button className={activeSection === "content" ? "active" : ""} type="button" onClick={() => setActiveSection("content")}>
            <Megaphone aria-hidden="true" />
            <span>Public content</span>
          </button>
          <button className={activeSection === "issues" ? "active" : ""} type="button" onClick={() => setActiveSection("issues")}>
            <FileText aria-hidden="true" />
            <span>Issues</span>
          </button>
          <button className={activeSection === "subscribers" ? "active" : ""} type="button" onClick={() => setActiveSection("subscribers")}>
            <Users aria-hidden="true" />
            <span>Subscribers</span>
          </button>
          {me?.isPlatformAdmin ? (
            <button type="button" onClick={() => window.location.assign("/#/admin")}>
              <ShieldCheck aria-hidden="true" />
              <span>Platform</span>
            </button>
          ) : null}
          <button type="button" onClick={() => window.location.assign(`https://${appConfig.baseDomain}/`)}>
            <Home aria-hidden="true" />
            <span>Public site</span>
          </button>
        </nav>

        <div className="platform-sidebar-foot">
          <button type="button" onClick={refreshNewsletter}>
            <RefreshCw aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
      </aside>

      <main className="platform-main">
        <header className="platform-topbar">
          <div />
          <div className="leader-user-actions">
            <button className="icon-button" type="button" onClick={refreshNewsletter} aria-label="Refresh newsletter">
              <RefreshCw aria-hidden="true" />
            </button>
            <div className="leader-user-card">
              <span className="leader-avatar">{String(me?.user?.display_name || me?.user?.email || "N").slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{me?.user?.display_name || me?.user?.email || "Newsletter user"}</strong>
                <span>{roleLabel}</span>
              </div>
              <ChevronDown aria-hidden="true" />
            </div>
            <button className="btn btn-secondary btn-small" type="button" onClick={onLogout}>
              <LogOut aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </header>

        <div className="platform-content newsletter-content">
          <div className="platform-page-heading">
            <div>
              <h1>{activeMeta.title}</h1>
              <p>{activeMeta.copy}</p>
            </div>
            <div className="newsletter-heading-actions">
              <a className="btn btn-secondary" href={`https://${appConfig.baseDomain}/`} target="_blank" rel="noreferrer">
                <Home aria-hidden="true" />
                <span>View public site</span>
              </a>
              {activeSection === "content" ? (
                <button className="btn btn-primary" type="button" onClick={startNewContentBlock}>
                  <Plus aria-hidden="true" />
                  <span>New block</span>
                </button>
              ) : null}
              {activeSection === "issues" ? (
                <button className="btn btn-primary" type="button" onClick={startNewDraft}>
                  <Plus aria-hidden="true" />
                  <span>New issue</span>
                </button>
              ) : null}
            </div>
          </div>

          <StatusLine status={status} />

          {activeSection !== "content" && !deliverySettings.emailConfigured ? (
            <div className="newsletter-delivery-note" role="note">
              <MailPlus aria-hidden="true" />
              <span>Email delivery is not configured in this environment. Reviews still update subscriber status, but notification emails will be skipped.</span>
            </div>
          ) : null}

          <section className="platform-stat-grid newsletter-stat-grid" aria-label="Newsletter totals">
            {activeSection === "content" ? (
              <>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon blue">
                    <Megaphone aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{contentBlocks.length}</strong>
                    <span>Total blocks</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon green">
                    <CheckCircle2 aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{publishedContentCount}</strong>
                    <span>Published</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon amber">
                    <CalendarDays aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{contentBlocks.filter(block => block.blockType === "event").length}</strong>
                    <span>Events</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon purple">
                    <ShieldCheck aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{contentBlocks.filter(block => block.blockType === "resource").length}</strong>
                    <span>Resources</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon blue">
                    <ShieldCheck aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{subscriberStats.pending || 0}</strong>
                    <span>Pending requests</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon green">
                    <Users aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{subscriberStats.active || 0}</strong>
                    <span>Approved subscribers</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon amber">
                    <Send aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{issues.reduce((sum, issue) => sum + Number(issue.sentCount || 0), 0)}</strong>
                    <span>Emails sent</span>
                  </div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon purple">
                    <CheckCircle2 aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{issues.filter(issue => issue.status === "published").length}</strong>
                    <span>Published issues</span>
                  </div>
                </div>
              </>
            )}
          </section>

          {activeSection === "content" ? (
            <div className="newsletter-admin-grid frg-content-admin-grid">
              <section className="platform-table-card newsletter-issue-list-card">
                <div className="platform-table-toolbar">
                  <label className="platform-search">
                    <Search aria-hidden="true" />
                    <input
                      value={contentQuery}
                      placeholder="Search public content..."
                      onChange={event => setContentQuery(event.target.value)}
                    />
                  </label>
                  <select
                    className="select newsletter-status-filter"
                    value={contentTypeFilter}
                    onChange={event => setContentTypeFilter(event.target.value)}
                    aria-label="Filter public content"
                  >
                    <option value="all">All types</option>
                    {contentBlockTypes.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>

                <div className="newsletter-issue-list frg-content-list">
                  {filteredContentBlocks.length ? filteredContentBlocks.map(block => (
                    <button
                      className={block.id === selectedContentBlockId ? "newsletter-issue-button active" : "newsletter-issue-button"}
                      type="button"
                      key={block.id}
                      onClick={() => selectContentBlock(block)}
                    >
                      <span>
                        <strong>{block.title}</strong>
                        <small>{contentTypeLabel(block.blockType)} · {formatShortDate(block.updatedAt)}</small>
                      </span>
                      <span className={`status-pill ${block.status}`}>{block.status}</span>
                    </button>
                  )) : (
                    <EmptyPanel title="No public content" body="Create announcements, events, or resources for the public homepage." />
                  )}
                </div>
              </section>

              <section className="platform-table-card newsletter-editor-card">
                <div className="newsletter-editor-layout">
                  <form className="newsletter-editor-form" onSubmit={saveContentBlock}>
                    <div className="newsletter-editor-heading">
                      <div>
                        <p className="eyebrow">{selectedContentBlock ? contentTypeLabel(selectedContentBlock.blockType) : "Public content"}</p>
                        <h2>{selectedContentBlockId ? "Edit block" : "New block"}</h2>
                      </div>
                      {selectedContentBlock ? <span className={`status-pill ${selectedContentBlock.status}`}>{selectedContentBlock.status}</span> : null}
                    </div>

                    <div className="newsletter-form-row">
                      <div>
                        <label className="field-label" htmlFor="frgContentType">Type</label>
                        <select
                          id="frgContentType"
                          className="select"
                          value={contentForm.blockType}
                          onChange={event => updateContentForm("blockType", event.target.value)}
                        >
                          {contentBlockTypes.map(type => (
                            <option key={type.value} value={type.value}>{type.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="frgContentStatus">Status</label>
                        <select
                          id="frgContentStatus"
                          className="select"
                          value={contentForm.status}
                          onChange={event => updateContentForm("status", event.target.value)}
                        >
                          {contentBlockStatuses.map(type => (
                            <option key={type.value} value={type.value}>{type.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <label className="field-label" htmlFor="frgContentTitle">Title</label>
                    <input
                      id="frgContentTitle"
                      className="input"
                      value={contentForm.title}
                      placeholder="Family readiness update"
                      onChange={event => updateContentForm("title", event.target.value)}
                      required
                    />

                    <label className="field-label" htmlFor="frgContentSummary">Summary</label>
                    <input
                      id="frgContentSummary"
                      className="input"
                      value={contentForm.summary}
                      placeholder="Short public-safe summary"
                      onChange={event => updateContentForm("summary", event.target.value)}
                    />

                    <label className="field-label" htmlFor="frgContentBody">Details</label>
                    <textarea
                      id="frgContentBody"
                      className="input newsletter-body-input frg-content-body-input"
                      value={contentForm.body}
                      placeholder="Optional public details..."
                      onChange={event => updateContentForm("body", event.target.value)}
                    />

                    <div className="newsletter-form-row">
                      <div>
                        <label className="field-label" htmlFor="frgContentEventAt">Event date</label>
                        <input
                          id="frgContentEventAt"
                          className="input"
                          type="datetime-local"
                          value={contentForm.eventAt}
                          onChange={event => updateContentForm("eventAt", event.target.value)}
                        />
                      </div>
                      <div>
                        <label className="field-label" htmlFor="frgContentSortOrder">Sort order</label>
                        <input
                          id="frgContentSortOrder"
                          className="input"
                          type="number"
                          min="0"
                          max="999"
                          value={contentForm.sortOrder}
                          onChange={event => updateContentForm("sortOrder", event.target.value)}
                        />
                      </div>
                    </div>

                    <div className="newsletter-form-row">
                      <div>
                        <label className="field-label" htmlFor="frgContentHref">Link</label>
                        <input
                          id="frgContentHref"
                          className="input"
                          value={contentForm.href}
                          placeholder="https://..."
                          onChange={event => updateContentForm("href", event.target.value)}
                        />
                      </div>
                      <div>
                        <label className="field-label" htmlFor="frgContentLinkLabel">Link label</label>
                        <input
                          id="frgContentLinkLabel"
                          className="input"
                          value={contentForm.linkLabel}
                          placeholder="Open resource"
                          onChange={event => updateContentForm("linkLabel", event.target.value)}
                        />
                      </div>
                    </div>

                    <div className="button-row">
                      <button className="btn btn-primary" type="submit" disabled={isSavingContent}>
                        <FileText aria-hidden="true" />
                        <span>{isSavingContent ? "Saving..." : selectedContentBlockId ? "Save block" : "Create block"}</span>
                      </button>
                      {selectedContentBlockId ? (
                        <button className="btn btn-danger-soft" type="button" onClick={deleteContentBlock} disabled={isDeletingContent}>
                          <Trash2 aria-hidden="true" />
                          <span>{isDeletingContent ? "Removing..." : "Remove"}</span>
                        </button>
                      ) : null}
                    </div>
                  </form>

                  <aside className="newsletter-preview frg-content-preview" aria-label="Public content preview">
                    <p className="eyebrow">{contentTypeLabel(contentForm.blockType)}</p>
                    <h2>{contentForm.title || "Public content title"}</h2>
                    <div className="public-newsletter-meta">
                      <span>{contentBlockStatuses.find(type => type.value === contentForm.status)?.label || "Draft"}</span>
                      {contentForm.eventAt ? <span>{formatShortDate(contentForm.eventAt)}</span> : null}
                    </div>
                    {contentForm.summary ? <p className="newsletter-preview-summary">{contentForm.summary}</p> : null}
                    <div className="newsletter-preview-body">
                      {newsletterBodyParagraphs(contentForm.body).length ? newsletterBodyParagraphs(contentForm.body).map((line, index) => (
                        <p key={`${line}-${index}`}>{line}</p>
                      )) : <p className="muted-copy">Preview appears as public-safe content is entered.</p>}
                    </div>
                    {contentForm.href ? <span className="frg-content-preview-link">{contentForm.linkLabel || "Open link"}</span> : null}
                  </aside>
                </div>
              </section>
            </div>
          ) : null}

          {activeSection === "issues" ? (
          <div className="newsletter-admin-grid">
            <section className="platform-table-card newsletter-issue-list-card">
              <div className="platform-table-toolbar">
                <label className="platform-search">
                  <Search aria-hidden="true" />
                  <input
                    value={query}
                    placeholder="Search issues..."
                    onChange={event => setQuery(event.target.value)}
                  />
                </label>
              </div>

              <div className="newsletter-issue-list">
                {filteredIssues.length ? filteredIssues.map(issue => (
                  <button
                    className={issue.id === selectedIssueId ? "newsletter-issue-button active" : "newsletter-issue-button"}
                    type="button"
                    key={issue.id}
                    onClick={() => selectIssue(issue)}
                  >
                    <span>
                      <strong>{issue.title}</strong>
                      <small>{issue.editionLabel || formatShortDate(issue.createdAt)}</small>
                    </span>
                    <span className={`status-pill ${issue.status}`}>{issue.status}</span>
                  </button>
                )) : (
                  <EmptyPanel title="No issues yet" body="Create the first newsletter issue to publish an update." />
                )}
              </div>
            </section>

            <section className="platform-table-card newsletter-editor-card">
              <div className="newsletter-editor-layout">
                <form className="newsletter-editor-form" onSubmit={saveIssue}>
                  <div className="newsletter-editor-heading">
                    <div>
                      <p className="eyebrow">{selectedIssue?.status || "Draft"}</p>
                      <h2>{selectedIssueId ? "Edit issue" : "New issue"}</h2>
                    </div>
                    {selectedIssue ? <span className={`status-pill ${selectedIssue.status}`}>{selectedIssue.status}</span> : null}
                  </div>

                  <label className="field-label" htmlFor="newsletterTitle">Title</label>
                  <input
                    id="newsletterTitle"
                    className="input"
                    value={form.title}
                    placeholder="Company newsletter title"
                    onChange={event => updateForm("title", event.target.value)}
                    required
                  />

                  <div className="newsletter-form-row">
                    <div>
                      <label className="field-label" htmlFor="newsletterEdition">Edition</label>
                      <input
                        id="newsletterEdition"
                        className="input"
                        value={form.editionLabel}
                        placeholder="July family update"
                        onChange={event => updateForm("editionLabel", event.target.value)}
                      />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="newsletterSummary">Summary</label>
                      <input
                        id="newsletterSummary"
                        className="input"
                        value={form.summary}
                        placeholder="One-line overview"
                        onChange={event => updateForm("summary", event.target.value)}
                      />
                    </div>
                  </div>

                  <label className="field-label" htmlFor="newsletterBody">Newsletter body</label>
                  <textarea
                    id="newsletterBody"
                    className="input newsletter-body-input"
                    value={form.body}
                    placeholder="Write the newsletter update..."
                    onChange={event => updateForm("body", event.target.value)}
                    required
                  />

                  <div className="button-row">
                    <button className="btn btn-secondary" type="submit" disabled={isSaving}>
                      <FileText aria-hidden="true" />
                      <span>{isSaving ? "Saving..." : selectedIssueId ? "Save issue" : "Create draft"}</span>
                    </button>
                    <button className="btn btn-primary" type="button" onClick={publishIssue} disabled={!selectedIssueId || isPublishing}>
                      <Send aria-hidden="true" />
                      <span>{isPublishing ? "Publishing..." : "Publish"}</span>
                    </button>
                  </div>
                </form>

                <aside className="newsletter-preview" aria-label="Newsletter preview">
                  <p className="eyebrow">Preview</p>
                  <h2>{form.title || "Newsletter title"}</h2>
                  <div className="public-newsletter-meta">
                    {form.editionLabel ? <span>{form.editionLabel}</span> : null}
                    {selectedIssue?.publishedAt ? <span>{formatShortDate(selectedIssue.publishedAt)}</span> : null}
                  </div>
                  {form.summary ? <p className="newsletter-preview-summary">{form.summary}</p> : null}
                  <div className="newsletter-preview-body">
                    {previewLines.length ? previewLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>) : (
                      <p className="muted-copy">The issue preview appears as you write.</p>
                    )}
                  </div>
                </aside>
              </div>
            </section>
          </div>
          ) : null}

          {activeSection === "subscribers" ? (
          <section className="platform-table-card newsletter-subscriber-card">
            <div className="newsletter-subscriber-heading">
              <div>
                <h2>Subscribers</h2>
                <p>
                  {countLabel(subscriberStats.pending || 0, "pending request")}, {countLabel(subscriberStats.active || 0, "approved subscriber")}, and {countLabel(subscriberStats.rejected || 0, "rejected request")}.
                </p>
              </div>
              <button className="btn btn-secondary btn-small" type="button" onClick={exportSubscribers} disabled={!subscribers.length}>
                <Download aria-hidden="true" />
                <span>Export CSV</span>
              </button>
            </div>

            <div className="newsletter-subscriber-toolbar">
              <label className="platform-search">
                <Search aria-hidden="true" />
                <input
                  value={subscriberQuery}
                  placeholder="Search subscribers..."
                  onChange={event => setSubscriberQuery(event.target.value)}
                />
              </label>
              <select
                className="select newsletter-status-filter"
                value={subscriberStatusFilter}
                onChange={event => setSubscriberStatusFilter(event.target.value)}
                aria-label="Filter subscribers by status"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="active">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="unsubscribed">Unsubscribed</option>
              </select>
            </div>

            {filteredSubscribers.length ? (
              <div className="newsletter-subscriber-list">
                {filteredSubscribers.map(subscriber => {
                  const canApprove = subscriber.status === "pending" || subscriber.status === "rejected";
                  const canReject = subscriber.status === "pending";
                  const isReviewing = reviewingSubscriberId === subscriber.id;
                  const noteValue = reviewNotes[subscriber.id] ?? "";

                  return (
                  <article className="admin-list-row" key={subscriber.id}>
                    <div className="newsletter-subscriber-main">
                      <strong>{subscriber.displayName || subscriber.email}</strong>
                      <span>{subscriber.email}</span>
                      <span>{subscriber.platoon || "No platoon provided"}</span>
                      <span>Supervisor: {subscriber.supervisorName || "Not provided"}</span>
                      {subscriber.reviewNote ? <span>Review note: {subscriber.reviewNote}</span> : null}
                      {subscriber.reviewedAt ? <span>Reviewed {formatDate(subscriber.reviewedAt)}</span> : null}
                      {canApprove || canReject ? (
                        <label className="newsletter-review-note">
                          <span>Optional review note</span>
                          <textarea
                            className="input"
                            value={noteValue}
                            placeholder="Private note for this request..."
                            maxLength={600}
                            onChange={event => updateReviewNote(subscriber.id, event.target.value)}
                          />
                        </label>
                      ) : null}
                    </div>
                    <div className="admin-row-meta">
                      <span className={`status-pill ${subscriber.status}`}>{subscriber.status}</span>
                      <span className="badge">{formatShortDate(subscriber.lastSubscribedAt || subscriber.createdAt)}</span>
                      {canApprove ? (
                        <button
                          className="btn btn-primary btn-small"
                          type="button"
                          disabled={isReviewing}
                          onClick={() => reviewSubscriber(subscriber.id, "approved")}
                        >
                          <CheckCircle2 aria-hidden="true" />
                          <span>{isReviewing && reviewingSubscriberDecision === "approved" ? "Approving..." : "Approve"}</span>
                        </button>
                      ) : null}
                      {canReject ? (
                        <button
                          className="btn btn-danger-soft btn-small"
                          type="button"
                          disabled={isReviewing}
                          onClick={() => reviewSubscriber(subscriber.id, "rejected")}
                        >
                          <XCircle aria-hidden="true" />
                          <span>{isReviewing && reviewingSubscriberDecision === "rejected" ? "Rejecting..." : "Reject"}</span>
                        </button>
                      ) : null}
                    </div>
                  </article>
                  );
                })}
              </div>
            ) : (
              <EmptyPanel
                title={subscribers.length ? "No matching subscribers" : "No subscribers yet"}
                body={subscribers.length ? "Adjust the search or status filter." : "Public newsletter signups will appear here."}
              />
            )}
          </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PlatformPanel({ token, me, onRefresh, onLogout }) {
  const [tenants, setTenants] = useState([]);
  const [form, setForm] = useState({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeView, setActiveView] = useState("dashboard");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [status, setStatus] = useState({ text: "Loading platoons...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const totalMembers = tenants.reduce((sum, tenant) => sum + Number(tenant.memberCount || 0), 0);
  const totalAdmins = tenants.reduce((sum, tenant) => sum + Number(tenant.adminCount || 0), 0);
  const activeTenants = tenants.filter(tenant => tenant.status === "active");
  const recentlyCreatedTenants = [...tenants]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 4);
  const normalizedQuery = query.trim().toLowerCase();
  const searchMatchedTenants = tenants.filter(tenant => {
    const matchesQuery = !normalizedQuery || [
      tenant.name,
      tenant.slug,
      tenant.status
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
    return matchesQuery;
  });
  const visibleTenants = searchMatchedTenants.filter(tenant => {
    const matchesStatus = statusFilter === "all" || tenant.status === statusFilter;
    return matchesStatus;
  });
  const healthUrl = (() => {
    try {
      const apiUrl = new URL(appConfig.apiBaseUrl, window.location.origin);
      return `${apiUrl.origin}/health`;
    } catch {
      return "/health";
    }
  })();
  const appLauncherUrl = "/#/launch";
  const diagnostics = [
    ["Current URL", window.location.href],
    ["Base domain", appConfig.baseDomain],
    ["API base URL", appConfig.apiBaseUrl],
    ["API health", healthUrl],
    ["App launcher", appLauncherUrl],
    ["QA auth", appConfig.enableQaAuth ? "enabled" : "disabled"],
    ["Auth diagnostics", appConfig.enableAuthDiagnostics ? "enabled" : "disabled"],
    ["Demo fallback", appConfig.enableDemoFallback ? "enabled" : "disabled"],
    ["Signed in as", me?.user?.email || me?.identity?.email || "unknown"]
  ];
  const pageMeta = {
    dashboard: {
      title: "Dashboard",
      copy: "Monitor platform setup, active workspaces, and admin access."
    },
    platoons: {
      title: "Platoons",
      copy: "Create, manage, and organize platoon workspaces."
    },
    users: {
      title: "Users",
      copy: "Review account coverage across active workspaces."
    },
    roles: {
      title: "Roles",
      copy: "Confirm which groups unlock platform, platoon, and public-site access."
    },
    organizations: {
      title: "Organizations",
      copy: "Review the organization container and workspace totals."
    },
    support: {
      title: "Support",
      copy: "Check safe deploy details before troubleshooting."
    }
  }[activeView] || {
    title: "Dashboard",
    copy: "Monitor platform setup, active workspaces, and admin access."
  };
  const platformNavItems = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "platoons", label: "Platoons", icon: Users },
    { id: "users", label: "Users", icon: UserPlus },
    { id: "roles", label: "Roles", icon: ShieldCheck },
    { id: "organizations", label: "Organizations", icon: Building2 },
    { id: "support", label: "Support", icon: RefreshCw }
  ];
  const roleCards = [
    {
      label: "Platform admin",
      group: "876en-admins",
      detail: "Full platform access and tenant support override."
    },
    {
      label: "FRG admin",
      group: "876en-frg-admins",
      detail: "Public content and newsletter administration."
    },
    {
      label: "Platoon admin",
      group: "876en-platoon-admin",
      detail: "Workspace administration when paired with a platoon group."
    },
    {
      label: "Platoon member",
      group: "876en-{platoon}",
      detail: "Inventory access for the matching platoon workspace."
    }
  ];

  function tenantWorkspaceHref(tenant) {
    const host = tenantHost(tenant);
    const isLocal = appConfig.baseDomain === "localhost" || window.location.hostname.endsWith(".localhost") || window.location.hostname === "localhost";
    if (isLocal) {
      const port = window.location.port ? `:${window.location.port}` : "";
      return `${window.location.protocol}//${host}${port}/`;
    }
    return `https://${host}/`;
  }

  async function copyTenantLink(tenant) {
    const host = tenantHost(tenant);
    const copied = await copyText(tenantWorkspaceHref(tenant));
    setStatus({
      text: copied ? `Copied workspace link for ${host}` : "Could not copy the workspace link from this browser.",
      isError: !copied
    });
  }

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

  async function refreshPlatform() {
    await loadTenants();
    onRefresh?.();
  }

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
      setIsCreateOpen(false);
      setStatus({ text: `Created ${data.tenant.slug}.${appConfig.baseDomain}`, isError: false });
      await loadTenants();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function copyDiagnostics() {
    const text = diagnostics.map(([label, value]) => `${label}: ${value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ text: "Diagnostics copied", isError: false });
    } catch {
      setStatus({ text: "Could not copy diagnostics", isError: true });
    }
  }

  function openNewsletter() {
    window.location.assign("/#/newsletter");
  }

  function renderStats() {
    return (
      <section className="platform-stat-grid" aria-label="Platform totals">
        <div className="platform-stat-card">
          <span className="platform-stat-icon blue">
            <Users aria-hidden="true" />
          </span>
          <div>
            <strong>{tenants.length}</strong>
            <span>Total platoons</span>
          </div>
        </div>
        <div className="platform-stat-card">
          <span className="platform-stat-icon green">
            <CheckCircle2 aria-hidden="true" />
          </span>
          <div>
            <strong>{activeTenants.length}</strong>
            <span>Active platoons</span>
          </div>
        </div>
        <div className="platform-stat-card">
          <span className="platform-stat-icon purple">
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <strong>{totalMembers}</strong>
            <span>Total users</span>
          </div>
        </div>
        <div className="platform-stat-card">
          <span className="platform-stat-icon amber">
            <Building2 aria-hidden="true" />
          </span>
          <div>
            <strong>{totalAdmins}</strong>
            <span>Admins assigned</span>
          </div>
        </div>
      </section>
    );
  }

  function renderTenantTable(rows, { compact = false } = {}) {
    if (!rows.length) {
      return <EmptyPanel title="No platoons found" body="Adjust the search or create a new platoon workspace." />;
    }

    return (
      <div className={`platform-table ${compact ? "platform-table-compact" : ""}`} role="table" aria-label="Platoon workspaces">
        <div className="platform-table-head" role="row">
          <span>Platoon name</span>
          <span>Subdomain</span>
          <span>Admins</span>
          <span>Members</span>
          <span>Status</span>
          <span>Created</span>
          <span>Actions</span>
        </div>
        {rows.map(tenant => {
          const host = tenantHost(tenant);
          return (
            <article className="platform-table-row" role="row" key={tenant.id}>
              <div className="platform-row-main">
                <span className="tenant-avatar" aria-hidden="true">{tenantInitials(tenant)}</span>
                <div>
                  <strong>{tenantDisplayName(tenant)}</strong>
                  <span>{host}</span>
                </div>
              </div>
              <span className="platform-domain">{host}</span>
              <span className="platform-table-number">{tenant.adminCount || 0}</span>
              <span className="platform-table-number">{tenant.memberCount || 0}</span>
              <span className={`status-pill ${tenant.status}`}>{tenant.status}</span>
              <span className="platform-table-date">{formatShortDate(tenant.createdAt)}</span>
              <div className="platform-actions">
                <a className="btn btn-secondary btn-small platform-open-link" href={tenantWorkspaceHref(tenant)} aria-label={`Open ${host} workspace`}>
                  <span>Open workspace</span>
                </a>
                <button className="btn btn-secondary btn-small platform-copy-link" type="button" onClick={() => copyTenantLink(tenant)}>
                  <Copy aria-hidden="true" />
                  <span>Copy link</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <div className="platform-shell">
      <aside className="platform-sidebar">
        <div className="platform-brand">
          <ShieldCheck aria-hidden="true" />
          <strong>876 Inventory</strong>
        </div>

        <nav className="platform-nav" aria-label="Platform admin">
          {platformNavItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                className={activeView === item.id ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => setActiveView(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
          <button type="button" onClick={openNewsletter}>
            <MailPlus aria-hidden="true" />
            <span>Newsletter</span>
          </button>
        </nav>

        <div className="platform-sidebar-foot">
          <button type="button" onClick={onLogout}>
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="platform-main">
        <header className="platform-topbar">
          <div />
          <div className="leader-user-actions">
            <button className="icon-button" type="button" onClick={refreshPlatform} aria-label="Refresh">
              <RefreshCw aria-hidden="true" />
            </button>
            <div className="leader-user-card">
              <span className="leader-avatar">{String(me?.user?.display_name || me?.user?.email || "A").slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{me?.user?.display_name || me?.user?.email || "Admin user"}</strong>
                <span>Super administrator</span>
              </div>
              <ChevronDown aria-hidden="true" />
            </div>
            <button className="btn btn-secondary btn-small" type="button" onClick={onLogout}>
              <LogOut aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </header>

        <div className="platform-content">
          <div className="platform-page-heading">
            <div>
              <h1>{pageMeta.title}</h1>
              <p>{pageMeta.copy}</p>
            </div>
            <div className="platform-heading-actions">
              {activeView === "dashboard" ? (
                <button className="btn btn-secondary" type="button" onClick={openNewsletter}>
                  <MailPlus aria-hidden="true" />
                  <span>Newsletter</span>
                </button>
              ) : null}
              {["dashboard", "platoons", "organizations"].includes(activeView) ? (
                <button className="btn btn-primary" type="button" onClick={() => setIsCreateOpen(true)}>
                  <Plus aria-hidden="true" />
                  <span>Create platoon</span>
                </button>
              ) : null}
            </div>
          </div>

          <StatusLine status={status} />

          {activeView === "dashboard" ? (
            <>
              {renderStats()}
              <div className="platform-dashboard-grid">
                <section className="platform-table-card platform-dashboard-card">
                  <div className="platform-card-header">
                    <div>
                      <h2>Recent platoons</h2>
                      <p>{tenants.length ? `${countLabel(tenants.length, "workspace")} configured.` : "No workspaces configured."}</p>
                    </div>
                    <button className="btn btn-secondary btn-small" type="button" onClick={() => setActiveView("platoons")}>
                      <span>View all</span>
                    </button>
                  </div>
                  {renderTenantTable(recentlyCreatedTenants, { compact: true })}
                </section>

                <section className="platform-table-card platform-dashboard-card">
                  <div className="platform-card-header">
                    <div>
                      <h2>Admin actions</h2>
                      <p>Common platform tasks.</p>
                    </div>
                  </div>
                  <div className="platform-action-list">
                    <button type="button" onClick={() => setIsCreateOpen(true)}>
                      <Plus aria-hidden="true" />
                      <span>Create platoon</span>
                    </button>
                    <button type="button" onClick={() => setActiveView("users")}>
                      <UserPlus aria-hidden="true" />
                      <span>Review users</span>
                    </button>
                    <button type="button" onClick={() => setActiveView("roles")}>
                      <ShieldCheck aria-hidden="true" />
                      <span>Check roles</span>
                    </button>
                    <button type="button" onClick={() => setActiveView("support")}>
                      <RefreshCw aria-hidden="true" />
                      <span>Support details</span>
                    </button>
                  </div>
                </section>
              </div>
            </>
          ) : null}

          {activeView === "platoons" ? (
            <>
              {renderStats()}
              <section className="platform-table-card">
                <div className="platform-table-toolbar">
                  <label className="platform-search">
                    <Search aria-hidden="true" />
                    <input
                      value={query}
                      placeholder="Search platoons by name or subdomain..."
                      onChange={event => setQuery(event.target.value)}
                    />
                  </label>
                  <select className="select platform-filter" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
                {renderTenantTable(visibleTenants)}
              </section>
            </>
          ) : null}

          {activeView === "users" ? (
            <section className="platform-table-card">
              <div className="platform-table-toolbar">
                <label className="platform-search">
                  <Search aria-hidden="true" />
                  <input
                    value={query}
                    placeholder="Search access by platoon or subdomain..."
                    onChange={event => setQuery(event.target.value)}
                  />
                </label>
              </div>
              <div className="platform-table platform-user-table" role="table" aria-label="Workspace access">
                <div className="platform-table-head" role="row">
                  <span>Workspace</span>
                  <span>Admin group</span>
                  <span>Members</span>
                  <span>Admins</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {searchMatchedTenants.map(tenant => (
                  <article className="platform-table-row" role="row" key={tenant.id}>
                    <div className="platform-row-main">
                      <span className="tenant-avatar" aria-hidden="true">{tenantInitials(tenant)}</span>
                      <div>
                        <strong>{tenantDisplayName(tenant)}</strong>
                        <span>{tenantHost(tenant)}</span>
                      </div>
                    </div>
                    <span className="platform-domain">876en-platoon-admin</span>
                    <span className="platform-table-number">{tenant.memberCount || 0}</span>
                    <span className="platform-table-number">{tenant.adminCount || 0}</span>
                    <span className={`status-pill ${tenant.status}`}>{tenant.status}</span>
                    <div className="platform-actions">
                      <a className="btn btn-secondary btn-small platform-open-link" href={tenantWorkspaceHref(tenant)} aria-label={`Open ${tenantHost(tenant)} workspace`}>
                        <span>Open workspace</span>
                      </a>
                      <button className="btn btn-secondary btn-small platform-copy-link" type="button" onClick={() => copyTenantLink(tenant)}>
                        <Copy aria-hidden="true" />
                        <span>Copy link</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!searchMatchedTenants.length ? (
                <EmptyPanel title="No user coverage found" body="Create a platoon workspace before assigning members." />
              ) : null}
            </section>
          ) : null}

          {activeView === "roles" ? (
            <section className="platform-role-grid" aria-label="Role groups">
              {roleCards.map(role => (
                <article className="platform-role-card" key={role.group}>
                  <span className="platform-stat-icon green">
                    <ShieldCheck aria-hidden="true" />
                  </span>
                  <div>
                    <h2>{role.label}</h2>
                    <code>{role.group}</code>
                    <p>{role.detail}</p>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {activeView === "organizations" ? (
            <>
              {renderStats()}
              <section className="platform-table-card platform-org-card">
                <div className="platform-section-heading">
                  <h2>Organization overview</h2>
                </div>
                <div className="platform-org-row">
                  <span>876 EN</span>
                  <span>{countLabel(tenants.length, "platoon")}</span>
                  <span>{countLabel(totalMembers, "user")}</span>
                  <span className="status-pill active">Active</span>
                </div>
              </section>
            </>
          ) : null}

          {activeView === "support" ? (
            <section className="platform-table-card platform-support-card">
              <div className="platform-card-header">
                <div>
                  <h2>Deployment details</h2>
                  <p>Safe values for routing and client configuration.</p>
                </div>
                <button className="btn btn-secondary btn-small" type="button" onClick={copyDiagnostics}>
                  <Copy aria-hidden="true" />
                  <span>Copy diagnostics</span>
                </button>
              </div>
              <div className="platform-diagnostics-grid">
                {diagnostics.map(([label, value]) => (
                  <div className="platform-diagnostic" key={label}>
                    <span>{label}</span>
                    {label === "API health" ? (
                      <a href={value} target="_blank" rel="noreferrer">{value}</a>
                    ) : (
                      <strong>{value}</strong>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </main>

      {isCreateOpen ? (
        <div className="modal-backdrop platform-modal-backdrop" role="presentation">
          <aside className="platform-create-modal" role="dialog" aria-modal="true" aria-labelledby="createPlatoonTitle">
            <div className="platform-modal-heading">
              <div>
                <p className="eyebrow">New workspace</p>
                <h2 id="createPlatoonTitle">Create platoon</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setIsCreateOpen(false)} aria-label="Close create platoon">
                <XCircle aria-hidden="true" />
              </button>
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

              <div className="button-row platform-modal-actions">
                <button className="btn btn-primary btn-full" type="submit" disabled={isSaving}>
                  <Plus aria-hidden="true" />
                  <span>{isSaving ? "Creating..." : "Create platoon"}</span>
                </button>
                <button className="btn btn-secondary btn-full" type="button" onClick={() => setIsCreateOpen(false)}>
                  <span>Cancel</span>
                </button>
              </div>
            </form>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function LeaderOverviewPanel({ token, tenantSlug, query, canManage, onOpenSessions, onOpenUpload, onOpenReview }) {
  const [sessions, setSessions] = useState([]);
  const [pendingItems, setPendingItems] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [status, setStatus] = useState({ text: "Loading dashboard...", isError: false });

  async function loadDashboard() {
    try {
      setStatus({ text: "Loading dashboard...", isError: false });
      const sessionData = await apiRequest("/inventory/sessions", { token, tenantSlug });
      const loadedSessions = sortSessionsByAttention(sessionData.sessions || []);
      const openSessions = loadedSessions.filter(session => session.status !== "closed");
      const detailTargets = openSessions.slice(0, 3);
      const detailResults = await Promise.all(
        detailTargets.map(async session => ({
          session,
          detail: await apiRequest(`/inventory/sessions/${session.id}`, { token, tenantSlug })
        }))
      );
      const rows = detailResults.flatMap(({ session, detail }) => {
        const rowSession = detail.session || session;
        return (detail.items || [])
          .filter(item => !sessionItemIsComplete(item))
          .sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b))
          .slice(0, 4)
          .map(item => ({ ...item, session: rowSession }));
      });
      let reviewRows = [];
      if (canManage) {
        const reviewData = await apiRequest("/inventory/review-queue", { token, tenantSlug });
        reviewRows = reviewData.submissions || [];
      }
      setSessions(loadedSessions);
      setPendingItems(rows.slice(0, 5));
      setSubmissions(reviewRows);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadDashboard();
  }, [tenantSlug, token, canManage]);

  const normalizedQuery = query.trim().toLowerCase();
  const openSessions = sessions.filter(session => session.status !== "closed");
  const reviewRowCount = openSessions.reduce((total, session) => total + Number(session.needsReviewCount || 0), 0);
  const totalRows = openSessions.reduce((total, session) => total + Number(session.itemCount || 0), 0);
  const foundRows = openSessions.reduce((total, session) => total + Number(session.foundCount || 0), 0);
  const overallProgress = totalRows ? Math.round((foundRows / totalRows) * 100) : 0;

  function rowMatches(values) {
    if (!normalizedQuery) return true;
    return values
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  }

  function itemTitle(item) {
    return item.inventoryItem?.commonName || item.inventoryItem?.title || item.packetLine || "Packet row";
  }

  function itemLocation(item) {
    return item.locationHint || item.inventoryItem?.currentLocation || "No location yet";
  }

  const visiblePendingItems = pendingItems.filter(item => rowMatches([
    itemTitle(item),
    item.packetLine,
    itemLocation(item),
    item.status,
    item.session?.name
  ]));
  const visibleSubmissions = submissions.filter(submission => rowMatches([
    submission.sessionItem?.packetLine,
    submission.session?.name,
    submission.submittedByName,
    submission.submittedByEmail,
    submission.locationText,
    submission.serialNumber,
    submission.note,
    submission.reviewNote
  ])).slice(0, 5);

  return (
    <div className="leader-dashboard">
      <div className="leader-page-heading">
        <div>
          <h1>Leader Dashboard</h1>
          <p>Manage inventories, review submissions, and guide your platoon.</p>
        </div>
        <div className="leader-page-actions">
          {canManage ? (
            <>
              <button className="btn btn-primary" type="button" onClick={onOpenSessions}>
                <Plus aria-hidden="true" />
                <span>Start new inventory</span>
              </button>
              <button className="btn btn-secondary" type="button" onClick={onOpenUpload}>
                <FileUp aria-hidden="true" />
                <span>Upload packet</span>
              </button>
            </>
          ) : (
            <button className="btn btn-primary" type="button" onClick={onOpenSessions}>
              <ListChecks aria-hidden="true" />
              <span>Open inventory</span>
            </button>
          )}
        </div>
      </div>

      <div className="leader-metric-strip" aria-label="Inventory overview">
        <div>
          <strong>{openSessions.length}</strong>
          <span>Open sessions</span>
        </div>
        <div>
          <strong>{pendingItems.length}</strong>
          <span>Pending rows</span>
        </div>
        <div>
          <strong>{reviewRowCount}</strong>
          <span>Needs review</span>
        </div>
        <div>
          <strong>{overallProgress}%</strong>
          <span>Found</span>
        </div>
      </div>

      <div className="leader-dashboard-grid">
        <section className="leader-card">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <Search aria-hidden="true" />
            </span>
            <div>
              <h2>Pending</h2>
              <p>Items that still need to be found.</p>
            </div>
            <button className="btn btn-secondary btn-small" type="button" onClick={onOpenSessions}>
              <span>View all</span>
            </button>
          </div>

          <div className="leader-table">
            {visiblePendingItems.length ? visiblePendingItems.map(item => {
              const imageUrls = getInventoryItemImages(item.inventoryItem);
              return (
                <article className="leader-table-row" key={item.id}>
                  <div className="leader-item-cell">
                    <span className="leader-thumb">
                      {imageUrls[0] ? <img src={imageUrls[0]} alt="" loading="lazy" /> : <FileText aria-hidden="true" />}
                    </span>
                    <div>
                      <strong>{itemTitle(item)}</strong>
                      <span>{item.session?.name || "Inventory session"}</span>
                    </div>
                  </div>
                  <span>{itemLocation(item)}</span>
                  <span className={`status-pill ${item.status}`}>{item.status}</span>
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenSessions}>
                    <span>Open</span>
                  </button>
                </article>
              );
            }) : (
              <EmptyPanel title="Nothing pending" body="Open a session to add packet rows or review completed work." />
            )}
          </div>
        </section>

        <section className="leader-card">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <ClipboardList aria-hidden="true" />
            </span>
            <div>
              <h2>Review</h2>
              <p>Leader approval required.</p>
            </div>
            {canManage ? (
              <button className="btn btn-secondary btn-small" type="button" onClick={onOpenReview}>
                <span>View all</span>
              </button>
            ) : null}
          </div>

          <div className="leader-table">
            {canManage && visibleSubmissions.length ? visibleSubmissions.map(submission => {
              const photo = submission.photos?.[0]?.url;
              return (
                <article className="leader-table-row review-row" key={submission.id}>
                  <div className="leader-item-cell">
                    <span className="leader-thumb">
                      {photo ? <img src={photo} alt="" loading="lazy" /> : <Camera aria-hidden="true" />}
                    </span>
                    <div>
                      <strong>{submission.sessionItem?.packetLine || "Submitted proof"}</strong>
                      <span>{submission.submittedByName || submission.submittedByEmail || "Submitted"}</span>
                    </div>
                  </div>
                  <span>{submission.reviewNote || submission.note || formatReviewState(submission.reviewState)}</span>
                  <span className={`status-pill ${submission.reviewState}`}>{formatReviewState(submission.reviewState)}</span>
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenReview}>
                    <span>Review</span>
                  </button>
                </article>
              );
            }) : (
              <EmptyPanel
                title={canManage ? "No proof waiting" : "Review is leader-only"}
                body={canManage ? "New submissions will appear here." : "Open inventory sessions to see assigned work."}
              />
            )}
          </div>
        </section>
      </div>

      <StatusLine status={status} />
    </div>
  );
}

function AccessSourcePanel({ access }) {
  if (!access) return null;

  const warnings = access.warnings || [];
  const matchedGroups = access.matchedGroups || [];

  return (
    <section className="access-source-panel admin-card">
      <div className="subsection-heading-row">
        <div>
          <p className="eyebrow">Access source</p>
          <h3>Why you can access this platoon</h3>
        </div>
        <span className={`status-pill ${access.source || "disabled"}`}>{formatAccessSource(access.source)}</span>
      </div>

      <div className="access-source-grid">
        <div>
          <span>Effective role</span>
          <strong>{access.effectiveRole ? formatRole(access.effectiveRole) : "None"}</strong>
        </div>
        <div>
          <span>Database</span>
          <strong>{formatAccessMembership(access.databaseMembership)}</strong>
        </div>
        <div>
          <span>Authentik</span>
          <strong>{formatAccessMembership(access.authentikMembership)}</strong>
        </div>
      </div>

      <div className="access-group-list">
        <span>Expected groups</span>
        <code>{access.expectedTenantGroup || "none"}</code>
        {access.expectedTenantAdminGroup ? <code>{access.expectedTenantAdminGroup}</code> : null}
      </div>

      {matchedGroups.length ? (
        <div className="access-group-list">
          <span>Matched groups</span>
          {matchedGroups.map(group => <code key={group}>{group}</code>)}
        </div>
      ) : null}

      {warnings.length ? (
        <div className="access-warning-list">
          {warnings.map(warning => (
            <p className={`access-warning ${warning.severity || "info"}`} key={warning.type || warning.message}>
              {warning.message}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TenantGuidancePanel({ token, tenantSlug, canManage, onOpenSessions, onOpenUpload }) {
  const starterGuidance = [
    "Inventory guidance",
    "",
    "- Start with the packet line and search by LIN, NSN, serial, or the plain item name.",
    "- Check the location hint and any existing photos before asking for help.",
    "- Take a wide photo first, then serial number or data plate photos when available.",
    "- If an item does not match the packet line, submit it as a mismatch and add a short note."
  ].join("\n");
  const [guidance, setGuidance] = useState({ body: "", updatedAt: null, updatedByName: "", updatedByEmail: "" });
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState({ text: "Loading guidance...", isError: false });

  async function loadGuidance() {
    try {
      setStatus({ text: "Loading guidance...", isError: false });
      const data = await apiRequest("/tenant/guidance", { token, tenantSlug });
      const loaded = data.guidance || {};
      setGuidance({
        body: loaded.body || "",
        updatedAt: loaded.updatedAt || null,
        updatedByName: loaded.updatedByName || "",
        updatedByEmail: loaded.updatedByEmail || ""
      });
      setDraft(loaded.body || starterGuidance);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadGuidance();
  }, [tenantSlug, token]);

  function startEditing() {
    setDraft(guidance.body || starterGuidance);
    setIsEditing(true);
    setStatus({ text: "", isError: false });
  }

  async function saveGuidance(event) {
    event.preventDefault();

    try {
      setIsSaving(true);
      const data = await apiRequest("/tenant/guidance", {
        method: "PATCH",
        token,
        tenantSlug,
        body: { body: draft }
      });
      const saved = data.guidance || {};
      setGuidance({
        body: saved.body || "",
        updatedAt: saved.updatedAt || null,
        updatedByName: saved.updatedByName || "",
        updatedByEmail: saved.updatedByEmail || ""
      });
      setDraft(saved.body || starterGuidance);
      setIsEditing(false);
      setStatus({ text: "Guidance saved", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  const hasGuidance = Boolean(guidance.body?.trim());
  const updatedBy = guidance.updatedByName || guidance.updatedByEmail;

  return (
    <div className="leader-dashboard guidance-page">
      <div className="leader-page-heading">
        <div>
          <h1>Inventory Guidance</h1>
          <p>{tenantSlug}.{appConfig.baseDomain}</p>
        </div>
        <div className="leader-page-actions">
          <button className="btn btn-secondary" type="button" onClick={onOpenSessions}>
            <ListChecks aria-hidden="true" />
            <span>Open sessions</span>
          </button>
          {canManage ? (
            <button className="btn btn-primary" type="button" onClick={onOpenUpload}>
              <FileUp aria-hidden="true" />
              <span>Upload packet</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="guidance-grid">
        <section className="leader-card guidance-card">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <BookOpen aria-hidden="true" />
            </span>
            <div>
              <h2>Local instructions</h2>
              <p>{updatedBy ? `Updated by ${updatedBy}${guidance.updatedAt ? ` - ${formatDate(guidance.updatedAt)}` : ""}` : "Shared with everyone in this workspace."}</p>
            </div>
            {canManage && !isEditing ? (
              <button className="btn btn-secondary btn-small" type="button" onClick={startEditing}>
                <span>{hasGuidance ? "Edit" : "Add"}</span>
              </button>
            ) : null}
          </div>

          {isEditing ? (
            <form className="guidance-editor" onSubmit={saveGuidance}>
              <label className="field-label" htmlFor="tenantGuidanceBody">Guidance</label>
              <textarea
                id="tenantGuidanceBody"
                className="input guidance-textarea"
                value={draft}
                maxLength={12000}
                onChange={event => setDraft(event.target.value)}
              />
              <div className="guidance-editor-footer">
                <span>{draft.length.toLocaleString()} / 12,000</span>
                <div className="button-row">
                  <button className="btn btn-secondary" type="button" onClick={() => setIsEditing(false)} disabled={isSaving}>
                    <span>Cancel</span>
                  </button>
                  <button className="btn btn-primary" type="submit" disabled={isSaving}>
                    <CheckCircle2 aria-hidden="true" />
                    <span>{isSaving ? "Saving..." : "Save guidance"}</span>
                  </button>
                </div>
              </div>
            </form>
          ) : hasGuidance ? (
            <div className="guidance-body">{guidance.body}</div>
          ) : (
            <EmptyPanel
              title="No guidance yet"
              body={canManage ? "Add local instructions for how your platoon should handle photos, notes, and packet rows." : "A platoon admin has not published guidance yet."}
            />
          )}
        </section>

        <aside className="leader-card guidance-workflow-card">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <ShieldCheck aria-hidden="true" />
            </span>
            <div>
              <h2>Use during inventory</h2>
              <p>Keep the packet and proof flow moving.</p>
            </div>
          </div>
          <div className="guidance-step-list">
            <div className="guidance-step">
              <Search aria-hidden="true" />
              <div>
                <strong>Search the packet row</strong>
                <span>Try the common name, LIN, NSN, serial, and location hints.</span>
              </div>
            </div>
            <div className="guidance-step">
              <Camera aria-hidden="true" />
              <div>
                <strong>Capture proof</strong>
                <span>Use a wide photo first. Add serial or data plate photos when requested.</span>
              </div>
            </div>
            <div className="guidance-step">
              <MessageSquare aria-hidden="true" />
              <div>
                <strong>Leave a short note</strong>
                <span>Call out mismatches, missing pieces, or weird locations before review.</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <StatusLine status={status} />
    </div>
  );
}

function TenantPeoplePanel({
  tenant,
  tenantSlug,
  access,
  members,
  invitations,
  inviteForm,
  onInviteFormChange,
  onCreateInvite,
  onUpdateMember,
  onDisableMember,
  onCopyInviteLink,
  onResendInvitation,
  onRevokeInvitation,
  inviteLinksById,
  inviteActionId,
  memberActionId,
  lastInviteUrl,
  isSaving
}) {
  const activeAdminCount = members.filter(member => member.role === "tenant_admin" && member.status === "active").length;

  return (
    <div className="people-panel">
      <section className="people-hero admin-card">
        <div className="admin-card-heading">
          <span className="admin-icon">
            <Users aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">{tenant?.name || `${tenantSlug} platoon`}</p>
            <h2>People & invites</h2>
            <p className="section-copy">Invite helpers, copy access links, and track who has joined this workspace.</p>
          </div>
        </div>
      </section>

      <AccessSourcePanel access={access} />

      <div className="admin-grid people-grid">
        <section className="admin-card">
          <div className="admin-card-heading">
            <span className="admin-icon">
              <MailPlus aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">New access</p>
              <h2>Invite helper</h2>
            </div>
          </div>

          <form className="admin-form" onSubmit={onCreateInvite}>
            <label className="field-label" htmlFor="inviteEmail">Email</label>
            <input
              id="inviteEmail"
              className="input"
              type="email"
              required
              value={inviteForm.email}
              placeholder="helper@example.com"
              onChange={e => onInviteFormChange(current => ({ ...current, email: e.target.value }))}
            />

            <label className="field-label" htmlFor="inviteName">Name</label>
            <input
              id="inviteName"
              className="input"
              value={inviteForm.displayName}
              placeholder="Name"
              onChange={e => onInviteFormChange(current => ({ ...current, displayName: e.target.value }))}
            />

            <label className="field-label" htmlFor="inviteRole">Role</label>
            <select
              id="inviteRole"
              className="select"
              value={inviteForm.role}
              onChange={e => onInviteFormChange(current => ({ ...current, role: e.target.value }))}
            >
              {tenantRoleOptions.map(option => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>

            <button className="btn btn-primary btn-full" type="submit" disabled={isSaving}>
              <Send aria-hidden="true" />
              <span>{isSaving ? "Creating..." : "Create invite"}</span>
            </button>
          </form>

          {lastInviteUrl ? (
            <div className="admin-copy-box">
              <span>Latest invite link</span>
              <a href={lastInviteUrl}>{lastInviteUrl}</a>
            </div>
          ) : null}
        </section>

        <section className="admin-card admin-card-wide">
          <div className="admin-card-heading">
            <span className="admin-icon">
              <UserPlus aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">Workspace access</p>
              <h2>Members</h2>
            </div>
          </div>

          {members.length ? (
            <div className="admin-list people-member-list">
              {members.map(member => {
                const isWorking = memberActionId === member.id;
                const isLastActiveAdmin = member.role === "tenant_admin" && member.status === "active" && activeAdminCount <= 1;
                const statusLabel = formatMemberStatus(member.status);

                return (
                  <article className="admin-list-row member-row" key={member.id}>
                    <div className="member-main">
                      <strong>{member.displayName || member.email}</strong>
                      <span>{member.email}</span>
                    </div>
                    <div className="admin-row-meta member-controls">
                      <span className={`status-pill ${member.status}`}>{statusLabel}</span>
                      <select
                        className="select member-role-select"
                        value={member.role}
                        aria-label={`Role for ${member.displayName || member.email}`}
                        disabled={isWorking || isLastActiveAdmin}
                        title={isLastActiveAdmin ? "Add another active platoon admin before changing this role." : "Change member role"}
                        onChange={event => onUpdateMember(member, { role: event.target.value })}
                      >
                        {tenantRoleOptions.map(option => (
                          <option value={option.value} key={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <button
                        className={member.status === "disabled" ? "btn btn-secondary btn-small" : "btn btn-danger-soft btn-small"}
                        type="button"
                        disabled={isWorking || isLastActiveAdmin}
                        title={isLastActiveAdmin ? "Add another active platoon admin before disabling this member." : ""}
                        onClick={() => {
                          if (member.status === "disabled") {
                            onUpdateMember(member, { status: "active" });
                          } else {
                            onDisableMember(member);
                          }
                        }}
                      >
                        <span>{isWorking ? "Saving..." : member.status === "disabled" ? "Enable" : "Disable"}</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyPanel title="No members loaded" body="Create an invite to give someone access." />
          )}

          <div className="admin-subsection">
            <div className="subsection-heading-row">
              <h3>Invitations</h3>
              <span>{invitations.length} total</span>
            </div>

            {invitations.length ? (
              <div className="admin-list compact">
                {invitations.map(invite => {
                  const isWorking = inviteActionId === invite.id;
                  const inviteLink = inviteLinksById[invite.id];

                  return (
                    <article className="admin-list-row invitation-row" key={invite.id}>
                      <div className="invitation-main">
                        <strong>{invite.email}</strong>
                        <span>{formatRole(invite.role)} - {inviteTimeline(invite)}</span>
                        {inviteLink ? <a href={inviteLink}>{inviteLink}</a> : null}
                      </div>
                      <div className="admin-row-meta invitation-actions">
                        <span className={`status-pill ${invite.status}`}>{formatInviteStatus(invite.status)}</span>
                        {inviteCanBeRefreshed(invite) ? (
                          <>
                            <button
                              className="btn btn-secondary btn-small"
                              type="button"
                              disabled={isWorking}
                              onClick={() => onCopyInviteLink(invite)}
                            >
                              <Copy aria-hidden="true" />
                              <span>Copy link</span>
                            </button>
                            <button
                              className="btn btn-secondary btn-small"
                              type="button"
                              disabled={isWorking}
                              onClick={() => onResendInvitation(invite)}
                            >
                              <Send aria-hidden="true" />
                              <span>{isWorking ? "Working..." : "Resend"}</span>
                            </button>
                          </>
                        ) : null}
                        {inviteCanBeRevoked(invite) ? (
                          <button
                            className="btn btn-danger-soft btn-small"
                            type="button"
                            disabled={isWorking}
                            onClick={() => onRevokeInvitation(invite.id)}
                          >
                            <Trash2 aria-hidden="true" />
                            <span>Revoke</span>
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyPanel title="No invites yet" body="Created invitations will appear here with copy, resend, and revoke actions." />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function TenantPanel({ token, tenantSlug, me, onRefresh, onLogout }) {
  const isTenantAdmin = Boolean(me?.isPlatformAdmin || me?.membership?.role === "tenant_admin");
  const canSubmitProof = Boolean(isTenantAdmin || me?.membership?.role === "contributor");
  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "tasks", label: "Inventory Sessions", icon: CalendarDays },
    { id: "guidance", label: "Inventory Guidance", icon: BookOpen },
    ...(isTenantAdmin ? [{ id: "review", label: "Review Queue", icon: ClipboardList }] : []),
    ...(isTenantAdmin ? [{ id: "people", label: "People & Invites", icon: Users }] : [])
  ];
  const [activeTab, setActiveTab] = useState("dashboard");
  const [sessionIntent, setSessionIntent] = useState("");
  const [leaderQuery, setLeaderQuery] = useState("");
  const [tenant, setTenant] = useState(null);
  const [access, setAccess] = useState(me?.access || null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [inviteForm, setInviteForm] = useState({ email: "", displayName: "", role: "contributor" });
  const [status, setStatus] = useState({ text: "Loading tenant...", isError: false });
  const [lastInviteUrl, setLastInviteUrl] = useState("");
  const [inviteLinksById, setInviteLinksById] = useState({});
  const [inviteActionId, setInviteActionId] = useState("");
  const [memberActionId, setMemberActionId] = useState("");
  const [notifications, setNotifications] = useState([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationStatus, setNotificationStatus] = useState("");
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const notificationsRef = useRef(null);
  const userMenuRef = useRef(null);
  const userName = me?.user?.display_name || me?.user?.email || "Signed in";
  const userRole = me?.membership?.role ? formatRole(me.membership.role) : isTenantAdmin ? "Platoon admin" : "Member";
  const userInitial = String(userName || "U").slice(0, 1).toUpperCase();

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      setIsSidebarOpen(false);
      setIsNotificationsOpen(false);
      setIsUserMenuOpen(false);
    }

    function handlePointerDown(event) {
      const target = event.target;
      if (notificationsRef.current && !notificationsRef.current.contains(target)) {
        setIsNotificationsOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(target)) {
        setIsUserMenuOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  function openPlatformAdmin() {
    const port = window.location.port ? `:${window.location.port}` : "";
    const isLocalhost = window.location.hostname.endsWith("localhost");
    window.location.assign(isLocalhost
      ? `${window.location.protocol}//admin.localhost${port}/#/admin`
      : `https://admin.${appConfig.baseDomain}/#/admin`);
  }

  function selectTenantTab(tabId) {
    setActiveTab(tabId);
    setIsSidebarOpen(false);
    setIsNotificationsOpen(false);
    setIsUserMenuOpen(false);
  }

  async function loadTenant() {
    try {
      setStatus({ text: "Loading tenant...", isError: false });
      const tenantData = await apiRequest("/tenant", { token, tenantSlug });
      setTenant(tenantData.tenant);
      setAccess(tenantData.access || me?.access || null);

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
      setAccess(me?.access || null);
    }
  }

  async function loadNotifications() {
    if (!tenantSlug || !token) return;

    setIsLoadingNotifications(true);
    try {
      const data = await apiRequest("/tenant/notifications", { token, tenantSlug });
      setNotifications(data.notifications || []);
      setNotificationUnreadCount(Number(data.unreadCount || 0));
      setNotificationStatus("");
    } catch (error) {
      setNotifications([]);
      setNotificationUnreadCount(0);
      setNotificationStatus(getApiErrorMessage(error));
    } finally {
      setIsLoadingNotifications(false);
    }
  }

  useEffect(() => {
    if (tenantSlug) {
      loadTenant();
      loadNotifications();
    }
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
      if (data.invitation?.id && data.invitation?.inviteUrl) {
        setInviteLinksById(current => ({
          ...current,
          [data.invitation.id]: data.invitation.inviteUrl
        }));
      }
      setStatus({ text: "Invite created", isError: false });
      await loadTenant();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function updateMember(member, patch) {
    const hasChange = Object.entries(patch).some(([key, value]) => value && member[key] !== value);
    if (!hasChange) return;

    setMemberActionId(member.id);
    try {
      const data = await apiRequest(`/tenant/members/${member.id}`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: patch
      });

      if (data.member) {
        setMembers(current => current.map(item => item.id === data.member.id ? data.member : item));
      }

      await loadTenant();
      if (member.userId === me?.user?.id) await onRefresh?.();

      const message = patch.role
        ? "Member role updated"
        : patch.status === "active"
          ? "Member enabled"
          : "Member updated";
      setStatus({ text: message, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  async function disableMember(member) {
    if (member.status === "disabled") return;

    setMemberActionId(member.id);
    try {
      const data = await apiRequest(`/tenant/members/${member.id}/disable`, {
        method: "POST",
        token,
        tenantSlug
      });

      if (data.member) {
        setMembers(current => current.map(item => item.id === data.member.id ? data.member : item));
      }

      await loadTenant();
      if (member.userId === me?.user?.id) await onRefresh?.();
      setStatus({ text: "Member disabled", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  async function refreshInvitation(invite, { sendEmail }) {
    setInviteActionId(invite.id);
    try {
      const data = await apiRequest(`/tenant/invitations/${invite.id}/resend`, {
        method: "POST",
        token,
        tenantSlug,
        body: { sendEmail }
      });

      if (data.invitation?.id && data.invitation?.inviteUrl) {
        setInviteLinksById(current => ({
          ...current,
          [data.invitation.id]: data.invitation.inviteUrl
        }));
        setLastInviteUrl(data.invitation.inviteUrl);
      }

      await loadTenant();
      return data;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return null;
    } finally {
      setInviteActionId("");
    }
  }

  async function copyInviteLink(invite) {
    const data = await refreshInvitation(invite, { sendEmail: false });
    const inviteUrl = data?.invitation?.inviteUrl;
    if (!inviteUrl) return;

    let copied = false;
    try {
      copied = await copyText(inviteUrl);
    } catch {
      copied = false;
    }

    setStatus({
      text: copied ? "Fresh invite link copied" : "Fresh invite link ready below",
      isError: false
    });
  }

  async function resendInvitation(invite) {
    const data = await refreshInvitation(invite, { sendEmail: true });
    if (!data) return;

    const email = data.email || {};
    const message = email.sent
      ? "Invite email resent"
      : email.reason === "smtp_not_configured"
        ? "Invite link refreshed. Email is not configured, so copy the link instead."
        : "Invite link refreshed. Email was not sent, so copy the link instead.";

    setStatus({ text: message, isError: false });
  }

  async function revokeInvitation(invitationId) {
    setInviteActionId(invitationId);
    try {
      await apiRequest(`/tenant/invitations/${invitationId}/revoke`, { method: "POST", token, tenantSlug });
      setInviteLinksById(current => {
        const next = { ...current };
        delete next[invitationId];
        return next;
      });
      setStatus({ text: "Invite revoked", isError: false });
      await loadTenant();
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setInviteActionId("");
    }
  }

  function openSessions(intent = "") {
    setSessionIntent(intent);
    selectTenantTab("tasks");
  }

  function openNotification(notification) {
    const tab = notification?.action?.tab;
    if (tab === "review" && isTenantAdmin) {
      selectTenantTab("review");
      return;
    }

    selectTenantTab("tasks");
  }

  if (!tenantSlug) {
    return <EmptyPanel title="No platoon selected" body="Open a platoon subdomain to manage members." />;
  }

  return (
    <div className={[
      "leader-shell",
      isSidebarOpen ? "sidebar-open" : "",
      isSidebarCollapsed ? "sidebar-collapsed" : ""
    ].filter(Boolean).join(" ")}>
      <button className="leader-sidebar-backdrop" type="button" aria-label="Close menu" onClick={() => setIsSidebarOpen(false)} />
      <aside className="leader-sidebar">
        <div className="leader-brand">
          <button
            className="leader-menu-button"
            type="button"
            aria-label={isSidebarOpen ? "Close menu" : isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              if (isSidebarOpen) {
                setIsSidebarOpen(false);
                return;
              }
              setIsSidebarCollapsed(current => !current);
            }}
          >
            <Menu aria-hidden="true" />
          </button>
          <strong>876 Inventory</strong>
        </div>

        <nav className="leader-nav" aria-label="Platoon workspace">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                className={activeTab === item.id ? "active" : ""}
                type="button"
                key={item.id}
                aria-label={item.label}
                title={item.label}
                onClick={() => selectTenantTab(item.id)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="leader-system-card">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Workspace active</strong>
            <span>{tenant?.name || `${tenantSlug}.${appConfig.baseDomain}`}</span>
          </div>
        </div>
      </aside>

      <main className="leader-main">
        <header className="leader-topbar">
          <button
            className="leader-mobile-nav-toggle"
            type="button"
            aria-label="Open workspace menu"
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <label className="leader-search">
            <Search aria-hidden="true" />
            <input
              value={leaderQuery}
              placeholder="Search items, sessions, locations..."
              onChange={e => setLeaderQuery(e.target.value)}
            />
          </label>
          <div className="leader-user-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                loadTenant();
                loadNotifications();
                onRefresh?.();
              }}
              aria-label="Refresh"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <div className="leader-popover-anchor" ref={notificationsRef}>
              <button
                className="icon-button leader-notification-button"
                type="button"
                aria-label="Notifications"
                aria-expanded={isNotificationsOpen}
                onClick={() => {
                  const nextOpen = !isNotificationsOpen;
                  setIsNotificationsOpen(nextOpen);
                  if (nextOpen) loadNotifications();
                  setIsUserMenuOpen(false);
                }}
              >
                <Bell aria-hidden="true" />
                {notificationUnreadCount ? (
                  <span className="leader-notification-badge">
                    {notificationUnreadCount > 9 ? "9+" : notificationUnreadCount}
                  </span>
                ) : null}
              </button>
              {isNotificationsOpen ? (
                <section className="leader-popover leader-notification-panel" aria-label="Notifications">
                  <div className="leader-popover-heading">
                    <strong>Notifications</strong>
                    <span>{notificationSummaryText(notificationUnreadCount, isLoadingNotifications)}</span>
                  </div>
                  {notificationStatus ? (
                    <div className="leader-notification-error">{notificationStatus}</div>
                  ) : null}
                  {notifications.length ? (
                    <div className="leader-notification-list">
                      {notifications.map(notification => {
                        const Icon = notificationIconFor(notification.type);
                        const meta = [notification.sessionName, formatRelativeTime(notification.createdAt)].filter(Boolean).join(" - ");
                        return (
                          <button
                            className={`leader-notification-item ${notification.priority || "low"}`}
                            type="button"
                            key={notification.id}
                            onClick={() => openNotification(notification)}
                          >
                            <span className="leader-notification-icon">
                              <Icon aria-hidden="true" />
                            </span>
                            <span className="leader-notification-copy">
                              <strong>{notification.title}</strong>
                              <span>{notification.body}</span>
                              {meta ? <small>{meta}</small> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="leader-notification-empty">
                      <ShieldCheck aria-hidden="true" />
                      <div>
                        <strong>{isLoadingNotifications ? "Checking workspace" : "No action needed"}</strong>
                        <span>{isTenantAdmin ? "New proof submissions, imports, and closed sessions will appear here." : "Proof requests and open session work will appear here."}</span>
                      </div>
                    </div>
                  )}
                  <div className="leader-menu-actions">
                    <button type="button" onClick={loadNotifications}>
                      <RefreshCw aria-hidden="true" />
                      <span>Refresh alerts</span>
                    </button>
                    <button type="button" onClick={() => selectTenantTab("tasks")}>
                      <CalendarDays aria-hidden="true" />
                      <span>Open sessions</span>
                    </button>
                    {isTenantAdmin ? (
                      <button type="button" onClick={() => selectTenantTab("review")}>
                        <ClipboardList aria-hidden="true" />
                        <span>Open review queue</span>
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
            <div className="leader-popover-anchor" ref={userMenuRef}>
              <button
                className="leader-user-card leader-user-trigger"
                type="button"
                aria-label="Open user menu"
                aria-expanded={isUserMenuOpen}
                onClick={() => {
                  setIsUserMenuOpen(current => !current);
                  setIsNotificationsOpen(false);
                }}
              >
                <span className="leader-avatar">{userInitial}</span>
                <div>
                  <strong>{userName}</strong>
                  <span>{userRole}</span>
                </div>
                <ChevronDown aria-hidden="true" />
              </button>
              {isUserMenuOpen ? (
                <section className="leader-popover leader-user-menu" aria-label="User menu">
                  <div className="leader-profile-summary">
                    <span className="leader-avatar">{userInitial}</span>
                    <div>
                      <strong>{userName}</strong>
                      <span>{userRole}</span>
                    </div>
                  </div>
                  <div className="leader-menu-actions">
                    <button type="button" onClick={() => selectTenantTab("dashboard")}>
                      <Home aria-hidden="true" />
                      <span>Workspace home</span>
                    </button>
                    <button type="button" onClick={() => window.location.assign("/#/launch")}>
                      <Users aria-hidden="true" />
                      <span>Switch workspace</span>
                    </button>
                    {me?.isPlatformAdmin ? (
                      <button type="button" onClick={openPlatformAdmin}>
                        <Building2 aria-hidden="true" />
                        <span>Platform admin</span>
                      </button>
                    ) : null}
                    <details className="leader-menu-details">
                      <summary>Access details</summary>
                      <dl>
                        <div>
                          <dt>Workspace</dt>
                          <dd>{tenant?.name || `${tenantSlug}.${appConfig.baseDomain}`}</dd>
                        </div>
                        <div>
                          <dt>Email</dt>
                          <dd>{me?.user?.email || "Not provided"}</dd>
                        </div>
                        <div>
                          <dt>Role</dt>
                          <dd>{userRole}</dd>
                        </div>
                      </dl>
                    </details>
                    <button type="button" onClick={onLogout}>
                      <LogOut aria-hidden="true" />
                      <span>Sign out</span>
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </header>

        <div className="leader-content">
          <StatusLine status={status} />

          {activeTab === "dashboard" ? (
            <LeaderOverviewPanel
              token={token}
              tenantSlug={tenantSlug}
              query={leaderQuery}
              canManage={isTenantAdmin}
              onOpenSessions={() => openSessions()}
              onOpenUpload={() => openSessions("packet")}
              onOpenReview={() => selectTenantTab("review")}
            />
          ) : null}

          {activeTab === "tasks" ? (
            <SessionPanel
              token={token}
              tenantSlug={tenantSlug}
              canManage={isTenantAdmin}
              canSubmit={canSubmitProof}
              uploadIntent={sessionIntent}
              onUploadIntentHandled={() => setSessionIntent("")}
              onOpenGuidance={() => selectTenantTab("guidance")}
            />
          ) : null}

          {activeTab === "guidance" ? (
            <TenantGuidancePanel
              token={token}
              tenantSlug={tenantSlug}
              canManage={isTenantAdmin}
              onOpenSessions={() => openSessions()}
              onOpenUpload={() => openSessions("packet")}
            />
          ) : null}

          {activeTab === "review" && isTenantAdmin ? (
            <ReviewPanel token={token} tenantSlug={tenantSlug} />
          ) : null}

          {activeTab === "people" && isTenantAdmin ? (
            <TenantPeoplePanel
              tenant={tenant}
              tenantSlug={tenantSlug}
              access={access}
              members={members}
              invitations={invitations}
              inviteForm={inviteForm}
              onInviteFormChange={setInviteForm}
              onCreateInvite={createInvite}
              onUpdateMember={updateMember}
              onDisableMember={disableMember}
              onCopyInviteLink={copyInviteLink}
              onResendInvitation={resendInvitation}
              onRevokeInvitation={revokeInvitation}
              inviteLinksById={inviteLinksById}
              inviteActionId={inviteActionId}
              memberActionId={memberActionId}
              lastInviteUrl={lastInviteUrl}
              isSaving={isSaving}
            />
          ) : null}
        </div>
      </main>
    </div>
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
      let callbackFailed = false;
      try {
        const redirectedSession = await completeOidcRedirect();
        if (redirectedSession && !ignore) {
          setSession(redirectedSession);
          await loadMe(redirectedSession.accessToken);
          return;
        }
      } catch (error) {
        callbackFailed = true;
        if (!ignore) setStatus({ text: error.message || "Login failed", isError: true });
      }

      if (!token && !callbackFailed && !appConfig.enableQaAuth && !appConfig.enableManualTokenAuth) {
        try {
          setStatus({ text: "Redirecting to Authentik...", isError: false });
          await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
          return;
        } catch (error) {
          if (!ignore) setStatus({ text: error.message || "Could not start login", isError: true });
          return;
        }
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
      frg: {
        sub: "qa-frg",
        email: "qa-frg@876en.test",
        name: "QA Newsletter Admin",
        groups: ["876en-frg-admins"]
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

  const normalizedHash = typeof window === "undefined" ? "" : window.location.hash.toLowerCase();
  const isNewsletterPage = normalizedHash === "#/newsletter" || normalizedHash.startsWith("#/newsletter?");
  const isPlatformPage = !isNewsletterPage && (isAdminHostname() || !tenantSlug);
  const canUsePlatform = Boolean(me?.isPlatformAdmin);
  const canUseNewsletter = Boolean(me?.isPlatformAdmin || me?.isFrgAdmin);
  const canUseTenant = Boolean(
    tenantSlug && (me?.isPlatformAdmin || ["tenant_admin", "contributor", "viewer"].includes(me?.membership?.role))
  );
  const isTenantDashboard = Boolean(token && me && !isPlatformPage && canUseTenant);
  const isNewsletterDashboard = Boolean(
    token && me && canUseNewsletter && (isNewsletterPage || (isAdminHostname() && !canUsePlatform))
  );
  const isPlatformDashboard = Boolean(token && me && isPlatformPage && canUsePlatform);
  const shellClassName = isTenantDashboard ? "leader-app" : isPlatformDashboard || isNewsletterDashboard ? "platform-app" : "app-frame admin-frame";

  return (
    <div className={shellClassName}>
      {!isTenantDashboard && !isPlatformDashboard && !isNewsletterDashboard ? (
        <AdminHeader me={me} tenantSlug={tenantSlug} mode={isNewsletterPage ? "newsletter" : ""} onRefresh={() => loadMe()} onLogout={logout} />
      ) : null}

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
          {!isTenantDashboard && !isPlatformDashboard && !isNewsletterDashboard ? (
          <section className="admin-profile-strip">
            <span className="badge strong">{me.user?.display_name || me.user?.email}</span>
            {me.isPlatformAdmin ? <span className="badge">Platform admin</span> : null}
            {me.isFrgAdmin && !me.isPlatformAdmin ? <span className="badge">FRG admin</span> : null}
            {me.membership?.role ? <span className="badge">{formatRole(me.membership.role)}</span> : null}
          </section>
          ) : null}

          {isNewsletterPage || (isPlatformPage && canUseNewsletter && !canUsePlatform) ? (
            canUseNewsletter
              ? <NewsletterPanel token={token} me={me} onRefresh={() => loadMe()} onLogout={logout} />
              : <EmptyPanel title="Newsletter admin access required" body="This account can sign in, but it is not assigned newsletter publishing access." />
          ) : isPlatformPage ? (
            canUsePlatform
              ? <PlatformPanel token={token} me={me} onRefresh={() => loadMe()} onLogout={logout} />
              : <EmptyPanel title="Platform access required" body="This account can sign in, but it is not a root admin." />
          ) : canUseTenant ? (
            <TenantPanel token={token} tenantSlug={tenantSlug} me={me} onRefresh={() => loadMe()} onLogout={logout} />
          ) : (
            <EmptyPanel title="Platoon admin access required" body="This account is not assigned as a platoon admin here." />
          )}
        </>
      )}
    </div>
  );
}
