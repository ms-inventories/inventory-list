import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Camera,
  CheckCircle2,
  Copy,
  ClipboardList,
  ClipboardPlus,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  FileUp,
  Home,
  History,
  ListChecks,
  LogIn,
  LogOut,
  MailPlus,
  Megaphone,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
  XCircle,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { appConfig, getTenantSlugFromHostname, isAdminHostname } from "../config.js";
import { APP_NAME } from "../branding.js";
import CrewAccessDialog from "./CrewAccessDialog.jsx";
import { apiRequest, clearQaIdentity, CREW_ACCESS_ENDED_EVENT, getApiErrorMessage, readLastApiRequestId, saveQaIdentity } from "../lib/api.js";
import { matchesSearch, metadataSearchText, searchTerms } from "../lib/search.js";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  beginOidcLogin,
  clearAuthSession,
  completeOidcRedirect,
  getSessionAccessToken,
  readAuthSession,
  saveAuthSession
} from "../lib/auth.js";
import { readPacketFileText } from "../lib/ocr.js";
import {
  analyzePacketRows,
  createPacketDraftRows,
  packetMimeTypeForFile,
  sanitizePacketDraftRows
} from "../lib/packetParser.js";

const roleLabels = {
  tenant_admin: "Platoon admin",
  contributor: "Contributor",
  crew: "Crew member",
  viewer: "Viewer"
};

const tenantRoleOptions = [
  { value: "tenant_admin", label: "Platoon admin" },
  { value: "contributor", label: "Contributor" },
  { value: "viewer", label: "Viewer" }
];

const teamRoleOptions = [
  { value: "tenant_admin", label: "Leader" },
  { value: "contributor", label: "Team member" },
  { value: "viewer", label: "Read only" }
];

const permanentTeamRoleOptions = teamRoleOptions.filter(option => option.value !== "viewer");
const provisioningWorkStatuses = new Set(["pending", "running", "retry_wait"]);

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

function formatTeamRole(role) {
  return teamRoleOptions.find(option => option.value === role)?.label || formatRole(role);
}

function memberAccountState(member, { provisioningAvailable = false } = {}) {
  const provisioning = member?.provisioning || null;
  const provisioningStatus = String(provisioning?.status || "").toLowerCase();
  const isDisabledCleanup = member?.status === "disabled" && provisioning?.desiredState === "disabled";

  if (isDisabledCleanup) {
    if (provisioningStatus === "failed") {
      return { label: "Needs attention", tone: "failed" };
    }
    if (provisioningWorkStatuses.has(provisioningStatus)) {
      return provisioningAvailable
        ? { label: "Removing access", tone: "pending" }
        : { label: "Cleanup paused", tone: "failed" };
    }
    return { label: "Disabled", tone: "disabled" };
  }
  if (provisioningStatus === "failed") {
    return { label: "Needs attention", tone: "failed" };
  }
  if (provisioningWorkStatuses.has(provisioningStatus)) {
    return provisioningAvailable
      ? { label: "Setting up", tone: "pending" }
      : { label: "Setup paused", tone: "failed" };
  }
  if (member?.status === "invited") {
    return { label: provisioning ? "Setting up" : "Invite pending", tone: "pending" };
  }
  if (member?.status === "disabled") {
    return { label: "Disabled", tone: "disabled" };
  }
  if (member?.hasSignedIn === true) {
    return { label: "Active", tone: "active" };
  }
  if (provisioning?.enrollmentSentAt) {
    return { label: "Email sent", tone: "sent" };
  }
  if (provisioningStatus === "succeeded") {
    return { label: "Ready", tone: "approved" };
  }

  return { label: formatMemberStatus(member?.status), tone: member?.status || "active" };
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

function defaultInventorySessionName() {
  try {
    const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date());
    return `${month} inventory`;
  } catch {
    return "New inventory";
  }
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

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches || false);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

function ResponsiveActionMenu({ label = "More actions", ariaLabel = label, children, className = "" }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target)) setIsOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={menuRef} className={`responsive-action-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        className="btn btn-secondary"
        type="button"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(open => !open)}
      >
        <MoreHorizontal aria-hidden="true" />
        <span>{label}</span>
      </button>
      {isOpen ? (
        <div
          className="responsive-action-panel"
          onClick={event => {
            if (event.target.closest("button, a")) setIsOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
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
        <p className="eyebrow">{APP_NAME}</p>
        <h1>{title}</h1>
        <p className="header-copy">{subtitle}</p>
      </div>
      <div className="header-actions">
        <a className="btn btn-secondary" href="/#/launch">
          <LogIn aria-hidden="true" />
          <span>Launch app</span>
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

function getProtectedAuthErrorMessage(error) {
  const code = error?.code || error?.details?.code || "";

  if (code.startsWith("token_exchange")) {
    return "Sign-in reached the app, but the inventory API did not finish the callback. Try again or ask an admin to check API routing.";
  }

  if (code === "state_mismatch") {
    return "The sign-in session expired. Try again.";
  }

  if (error?.status === 401) {
    return "Your sign-in expired. Try again.";
  }

  return getApiErrorMessage(error);
}

function StatusLine({ status }) {
  if (!status?.text) return null;
  const text = /failed to fetch/i.test(status.text) ? getApiErrorMessage(new Error(status.text)) : status.text;
  return (
    <div
      className={`admin-status ${status.isError ? "error" : ""}`}
      role={status.isError ? "alert" : "status"}
      aria-live={status.isError ? "assertive" : "polite"}
    >
      {text}
    </div>
  );
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

const supportedPacketMimeTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function describePacketSourceType(source = {}) {
  const mimeType = String(source.mimeType || "").toLowerCase();
  const fileName = String(source.fileName || source.name || "").toLowerCase();
  if (mimeType.includes("pdf") || fileName.endsWith(".pdf")) return "PDF";
  if (mimeType.includes("csv") || fileName.endsWith(".csv")) return "CSV";
  if (mimeType.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/.test(fileName)) return "Photo";
  if (mimeType.includes("text") || fileName.endsWith(".txt")) return "Text";
  return "Pasted text";
}

function normalizeMetadataValue(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeMetadataValue);
  if (value && typeof value === "object") {
    return normalizeMetadataValue(value.url || value.src || value.href || value.value);
  }
  return value ? [String(value)] : [];
}

function getLegacyInventoryItemImages(item) {
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

function getInventoryItemPhotos(item) {
  const hasNormalizedPhotos = Array.isArray(item?.photos) || Array.isArray(item?.savedPhotos);
  const savedPhotos = Array.isArray(item?.photos)
    ? item.photos
    : Array.isArray(item?.savedPhotos)
      ? item.savedPhotos
      : [];
  const normalized = savedPhotos
    .map((photo, index) => {
      if (typeof photo === "string") {
        return {
          id: `saved-${index}-${photo}`,
          mediaUploadId: "",
          url: photo,
          kind: "general",
          caption: ""
        };
      }
      return {
        ...photo,
        id: photo?.id || photo?.mediaUploadId || photo?.storageKey || `saved-${index}`,
        mediaUploadId: photo?.mediaUploadId || "",
        url: photo?.url || "",
        kind: photo?.kind || "general",
        caption: photo?.caption || ""
      };
    })
    .filter(photo => photo.url);

  if (!hasNormalizedPhotos || item?.legacyMediaMetadata === true) {
    getLegacyInventoryItemImages(item).forEach((url, index) => {
      if (!normalized.some(photo => photo.url === url)) {
        normalized.push({
          id: `legacy-${index}-${url}`,
          mediaUploadId: "",
          url,
          kind: "general",
          caption: "Saved reference"
        });
      }
    });
  }

  const seen = new Set();
  return normalized.filter(photo => {
    const key = photo.mediaUploadId || photo.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function getInventoryItemImages(item) {
  return getInventoryItemPhotos(item).map(photo => photo.url);
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

function normalizeSessionName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
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

function sessionItemAssignedToUser(item, me) {
  const userId = me?.user?.id || "";
  const email = String(me?.user?.email || "").toLowerCase();
  return Boolean(
    item?.assignedTo && userId && item.assignedTo === userId
  ) || Boolean(
    item?.assignedToEmail && email && String(item.assignedToEmail).toLowerCase() === email
  );
}

function sessionItemAssignmentBucket(item, me = null) {
  if (!item?.assignedTo && !item?.assignedToEmail) return "available";
  return sessionItemAssignedToUser(item, me) ? "mine" : "team";
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
    item?.suggestedInventoryItem?.title,
    item?.suggestedInventoryItem?.commonName,
    item?.suggestedInventoryItem?.armyName,
    item?.suggestedInventoryItem?.lin,
    item?.suggestedInventoryItem?.nsn,
    item?.suggestedInventoryItem?.serialNumber,
    item?.suggestedInventoryItem?.currentLocation,
    latest?.status,
    latest?.locationText,
    latest?.serialNumber,
    latest?.note,
    latest?.reviewNote,
    latest?.submittedByEmail,
    latest?.submittedByName,
    (item?.submissions || []).flatMap(submission => [
      submission?.status,
      submission?.reviewState,
      submission?.locationText,
      submission?.serialNumber,
      submission?.note,
      submission?.reviewNote,
      submission?.submittedByEmail,
      submission?.submittedByName
    ]),
    item?.assignedToEmail,
    item?.assignedToName
  ].flat(Infinity).filter(Boolean).join(" ").toLowerCase();
}

function sessionItemMatchesQuery(item, query) {
  return matchesSearch(getSessionItemSearchText(item), query);
}

function formatReviewState(value) {
  const labels = {
    pending: "Pending review",
    approved: "Approved",
    request_more_info: "More proof requested",
    rejected: "Rejected",
    superseded: "Earlier proof"
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

function assignedPerson(item) {
  return item?.assignedToName || item?.assignedToEmail || "";
}

function itemDisplayName(item) {
  return item?.inventoryItem?.commonName || item?.inventoryItem?.title || item?.packetLine || "Untitled row";
}

function reportItemIsResolved(item) {
  return ["approved", "found"].includes(item?.status);
}

function reportItemOutcome(item) {
  const latest = latestSubmission(item);
  if (item?.status === "approved") {
    return latest?.reviewState === "approved" && ["found", "not_found", "mismatch"].includes(latest.status)
      ? latest.status
      : "found";
  }
  if (item?.status === "needs_review" && ["found", "not_found", "mismatch"].includes(latest?.status)) {
    return latest.status;
  }
  return item?.status || "unchecked";
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

  const resolved = rows.filter(reportItemIsResolved).length;
  const issueRows = rows.filter(item => !reportItemIsResolved(item));

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
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
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

function buildReportsCsv(rows) {
  const headers = [
    "Session",
    "Session Status",
    "Item",
    "Packet Line",
    "LIN",
    "NSN",
    "Expected Qty",
    "Outcome",
    "Workflow Status",
    "Proof Status",
    "Location",
    "Serial",
    "Note",
    "Submitted By",
    "Updated"
  ];
  const values = (rows || []).map(item => {
    const latest = latestSubmission(item);
    return [
      item.sessionName || "",
      formatItemStatus(item.sessionStatus),
      itemDisplayName(item),
      item.packetLine || "",
      item.inventoryItem?.lin || "",
      item.inventoryItem?.nsn || "",
      item.expectedQty ?? "",
      formatItemStatus(reportItemOutcome(item)),
      formatItemStatus(item.status),
      latest?.reviewState ? formatReviewState(latest.reviewState) : "No proof",
      latest?.locationText || item.inventoryItem?.currentLocation || item.locationHint || "",
      latest?.serialNumber || "",
      latest?.note || latest?.reviewNote || "",
      latest ? submissionPerson(latest) : "",
      formatDate(latest?.createdAt || item.updatedAt || item.createdAt)
    ];
  });
  return [headers, ...values].map(row => row.map(csvCell).join(",")).join("\r\n");
}

function reportSummary(rows) {
  const summary = {
    total: rows.length,
    resolved: 0,
    found: 0,
    missing: 0,
    mismatch: 0,
    unchecked: 0,
    proofWork: 0
  };
  rows.forEach(item => {
    const outcome = reportItemOutcome(item);
    const proofState = latestSubmission(item)?.reviewState;
    if (reportItemIsResolved(item)) summary.resolved += 1;
    if (outcome === "found") summary.found += 1;
    else if (outcome === "not_found") summary.missing += 1;
    else if (outcome === "mismatch") summary.mismatch += 1;
    else summary.unchecked += 1;
    if (["pending", "request_more_info", "rejected"].includes(proofState)) summary.proofWork += 1;
  });
  summary.completion = summary.total ? Math.round((summary.resolved / summary.total) * 100) : 0;
  return summary;
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

const proofPhotoKindLabels = {
  general: "General photo",
  serial: "Serial photo",
  location: "Location photo",
  damage: "Damage photo"
};

function proofPhotoLabel(photo) {
  return proofPhotoKindLabels[photo?.kind] || "Proof photo";
}

function proofPhotoAlt(photo) {
  const label = proofPhotoLabel(photo);
  return photo?.caption ? `${label}: ${photo.caption}` : label;
}

function applicableProofRequest(history = [], evidence = null) {
  if (evidence?.reviewState === "request_more_info" && evidence?.reviewNote) return evidence.reviewNote;
  const evidenceCreatedAt = Date.parse(evidence?.createdAt || "") || Number.POSITIVE_INFINITY;
  return history.find(historyItem => (
    historyItem.id !== evidence?.id &&
    ["request_more_info", "superseded"].includes(historyItem.reviewState) &&
    historyItem.reviewNote &&
    (Date.parse(historyItem.createdAt || "") || 0) <= evidenceCreatedAt
  ))?.reviewNote || "";
}

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

function deliveryStatusLabel(status) {
  return {
    sent: "Sent",
    skipped: "Skipped",
    failed: "Failed"
  }[status] || status || "Unknown";
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
  const savedItemPhotos = getInventoryItemPhotos(item?.inventoryItem);
  const previousLocation = item?.inventoryItem?.currentLocation || "";
  const savedLocation = previousLocation || item?.locationHint || "";
  const [form, setForm] = useState({
    status: "found",
    locationText: savedLocation,
    serialNumber: "",
    note: "",
    photoFiles: []
  });
  const [pendingAction, setPendingAction] = useState("");
  const isSaving = Boolean(pendingAction);
  const pendingActionRef = useRef("");
  const uploadedPhotosRef = useRef(new Map());

  function beginAction(action) {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishAction(action) {
    if (pendingActionRef.current !== action) return;
    pendingActionRef.current = "";
    setPendingAction("");
  }

  async function discardUploadedPhoto(photoFile) {
    const uploaded = uploadedPhotosRef.current.get(photoFile);
    if (!uploaded?.photo?.uploadId) return;
    await apiRequest(`/uploads/photos/${encodeURIComponent(uploaded.photo.uploadId)}`, {
      method: "DELETE",
      token,
      tenantSlug
    });
    uploadedPhotosRef.current.delete(photoFile);
  }

  async function removePhoto(photoFile, photoIndex) {
    const action = `remove:${photoIndex}`;
    if (!beginAction(action)) return;
    try {
      await discardUploadedPhoto(photoFile);
      setForm(current => ({
        ...current,
        photoFiles: current.photoFiles.filter((_, index) => index !== photoIndex)
      }));
    } catch (error) {
      onStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishAction(action);
    }
  }

  async function cancelProof() {
    const action = "cancel";
    if (!beginAction(action)) return;
    try {
      for (const photoFile of [...uploadedPhotosRef.current.keys()]) {
        await discardUploadedPhoto(photoFile);
      }
      onCancel();
    } catch (error) {
      onStatus({ text: `${getApiErrorMessage(error)} Try discard again before closing.`, isError: true });
    } finally {
      finishAction(action);
    }
  }

  async function submitProof(e) {
    e.preventDefault();
    if (pendingActionRef.current) return;

    if (form.status === "found" && !form.photoFiles.length) {
      onStatus({ text: "Add a photo for found items.", isError: true });
      return;
    }

    const action = "submit";
    if (!beginAction(action)) return;
    try {
      onStatus({ text: "Submitting proof...", isError: false });
      const photos = [];

      for (const photoFile of form.photoFiles) {
        let uploaded = uploadedPhotosRef.current.get(photoFile);
        if (!uploaded) {
          const dataUrl = await fileToDataUrl(photoFile);
          uploaded = await apiRequest("/uploads/photos", {
            method: "POST",
            token,
            tenantSlug,
            body: {
              fileName: photoFile.name,
              mimeType: photoFile.type || "image/jpeg",
              dataUrl,
              kind: form.serialNumber ? "serial" : "general"
            }
          });
          uploadedPhotosRef.current.set(photoFile, uploaded);
        }
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
      uploadedPhotosRef.current.clear();
      onSaved();
    } catch (error) {
      const retryCopy = uploadedPhotosRef.current.size ? " Your uploaded photos will be reused when you retry." : "";
      onStatus({ text: `${getApiErrorMessage(error)}${retryCopy}`, isError: true });
    } finally {
      finishAction(action);
    }
  }

  return (
    <form id={`proof-form-${item.id}`} className="proof-form" onSubmit={submitProof}>
      {requestNote ? (
        <div className="proof-request-context">
          <strong>Platoon admin request</strong>
          <span>{requestNote}</span>
        </div>
      ) : null}

      {item?.inventoryItem ? (
        <div className="saved-record-context">
          <div>
            <strong>Previous inventory</strong>
            <span>{previousLocation ? `Last saved at ${previousLocation}` : "Saved item record"}</span>
          </div>
          {savedItemPhotos.length ? (
            <div className="saved-record-photo-strip" aria-label="Previously saved item photos">
              {savedItemPhotos.map((photo, index) => (
                <a href={photo.url} target="_blank" rel="noreferrer" key={photo.id || photo.url} aria-label={`Open saved item photo ${index + 1}`}>
                  <img src={photo.url} alt="" loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="segmented-control" role="group" aria-label="Inventory result">
        {[
          ["found", "Found"],
          ["not_found", "Not found"],
          ["mismatch", "Mismatch"]
        ].map(([value, label]) => (
          <button
            className={form.status === value ? "active" : ""}
            type="button"
            key={value}
            aria-pressed={form.status === value}
            autoFocus={value === "found"}
            disabled={isSaving}
            onClick={() => setForm(current => ({ ...current, status: value }))}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="proof-field">
        <span>Location</span>
        <input
          className="input"
          disabled={isSaving}
          value={form.locationText}
          placeholder="Where you found or checked it"
          onChange={e => setForm(current => ({ ...current, locationText: e.target.value }))}
        />
      </label>
      <label className="proof-field">
        <span>Serial number</span>
        <input
          className="input"
          disabled={isSaving}
          value={form.serialNumber}
          placeholder="Enter the serial number, if visible"
          onChange={e => setForm(current => ({ ...current, serialNumber: e.target.value }))}
        />
      </label>
      <label className="proof-field">
        <span>{requestNote ? "Response note" : "Note"}</span>
        <textarea
          className="input proof-note"
          disabled={isSaving}
          value={form.note}
          placeholder={requestNote ? "Explain how this answers the request" : "Add any useful detail"}
          onChange={e => setForm(current => ({ ...current, note: e.target.value }))}
        />
      </label>
      {form.photoFiles.length ? (
        <div className="proof-photo-selection" role="list" aria-label="Selected proof photos">
          {form.photoFiles.map((file, index) => (
            <div className="proof-photo-selection-item" role="listitem" key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
              <Camera aria-hidden="true" />
              <span title={file.name}>{file.name}</span>
              <small>{formatFileSize(file.size)}</small>
              <button
                type="button"
                disabled={isSaving}
                aria-label={pendingAction === `remove:${index}` ? `Removing ${file.name}` : `Remove ${file.name}`}
                onClick={() => removePhoto(file, index)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <label className={`photo-picker ${form.photoFiles.length >= 3 || isSaving ? "disabled" : ""}`}>
        <Camera aria-hidden="true" />
        <span>{pendingAction.startsWith("remove:")
          ? "Removing photo..."
          : form.photoFiles.length
            ? `Add another photo (${form.photoFiles.length}/3)`
            : "Add photos (up to 3)"}</span>
        <input
          className="photo-picker-input"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          disabled={form.photoFiles.length >= 3 || isSaving}
          aria-label={form.photoFiles.length ? "Add another proof photo" : "Add proof photos"}
          onChange={event => {
            const selectedFiles = [...(event.target.files || [])];
            event.target.value = "";
            if (!selectedFiles.length) return;
            if (form.photoFiles.length + selectedFiles.length > 3) {
              onStatus({ text: "You can add up to 3 photos per item.", isError: true });
            }
            setForm(current => ({
              ...current,
              photoFiles: [...current.photoFiles, ...selectedFiles].slice(0, 3)
            }));
          }}
        />
      </label>

      <div className="button-row">
        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          <Send aria-hidden="true" />
          <span>{pendingAction === "submit" ? "Submitting..." : requestNote ? "Send response" : "Submit proof"}</span>
        </button>
        <button className="btn btn-secondary" type="button" disabled={isSaving} onClick={cancelProof}>
          <span>{pendingAction === "cancel" ? "Canceling..." : "Cancel"}</span>
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
        <span className={`status-pill ${report.session?.status}`}>{formatItemStatus(report.session?.status)}</span>
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

function PossiblePriorMatchCard({ item, isSaving = false, onConfirm, onDismiss }) {
  const candidate = item?.suggestedInventoryItem;
  if (!candidate) return null;

  const photos = getInventoryItemPhotos(candidate);
  const identifiers = [
    candidate.lin ? `LIN ${candidate.lin}` : "",
    candidate.nsn ? `NSN ${candidate.nsn}` : "",
    candidate.serialNumber ? `SN ${candidate.serialNumber}` : ""
  ].filter(Boolean);

  return (
    <section className="prior-match-card" aria-label="Possible previous inventory record">
      <div className="prior-match-card-heading">
        <div>
          <p className="eyebrow">Possible previous record</p>
          <h3>{candidate.commonName || candidate.title || candidate.armyName || "Saved item"}</h3>
        </div>
        <History aria-hidden="true" />
      </div>
      {identifiers.length ? <p className="prior-match-identifiers">{identifiers.join(" · ")}</p> : null}
      {candidate.currentLocation ? (
        <p className="prior-match-location"><strong>Last saved location:</strong> {candidate.currentLocation}</p>
      ) : null}
      {photos.length ? (
        <div className="prior-match-photos" aria-label="Previously saved photos">
          {photos.map((photo, index) => (
            <a href={photo.url} target="_blank" rel="noreferrer" key={photo.id || photo.url} aria-label={`Open previous photo ${index + 1}`}>
              <img src={photo.url} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      <p className="prior-match-copy">Is this the same physical item?</p>
      <div className="prior-match-actions">
        <button className="btn btn-primary" type="button" disabled={isSaving} onClick={onConfirm}>
          <CheckCircle2 aria-hidden="true" />
          <span>{isSaving ? "Saving..." : "Use this record"}</span>
        </button>
        <button className="btn btn-secondary" type="button" disabled={isSaving} onClick={onDismiss}>
          <XCircle aria-hidden="true" />
          <span>Not the same item</span>
        </button>
      </div>
    </section>
  );
}

function SessionItemDrawer({
  item,
  session,
  importBatch,
  canManage,
  canSubmit,
  canClaim,
  assignmentAction,
  directCheckAction,
  matchAction,
  isClosed,
  status,
  assignableMembers,
  assignedMemberId,
  proofOpen,
  token,
  tenantSlug,
  onAssign,
  onClaim,
  onDirectCheck,
  onResolveMatch,
  onOpenProof,
  onOpenReview,
  onOpenPhoto,
  onProofCancel,
  onProofSaved,
  onStatus,
  onClose
}) {
  if (!item) return null;

  const title = itemDisplayName(item);
  const latest = latestSubmission(item);
  const needsMoreProof = latest?.reviewState === "request_more_info";
  const pendingProof = latest?.reviewState === "pending";
  const isDirectCheckPending = Boolean(directCheckAction);
  const isAssignmentPending = Boolean(assignmentAction);
  const knownImages = getInventoryItemImages(item.inventoryItem);
  const assignedName = assignedPerson(item);
  const packetSubtitle = item.packetLine && item.packetLine !== title ? item.packetLine : "";

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!proofOpen) onClose();
    } else if (event.key === "Tab") {
      const focusable = [...event.currentTarget.querySelectorAll(
        'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(element => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div
      className="session-item-drawer-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (!proofOpen && event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="session-item-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessionItemDrawerTitle"
        aria-describedby={packetSubtitle ? "sessionItemDrawerPacketLine" : undefined}
        onKeyDown={handleKeyDown}
      >
        <header className="session-item-drawer-heading">
          <div>
            <p className="eyebrow">{session?.name || "Inventory session"}</p>
            <h2 id="sessionItemDrawerTitle">{title}</h2>
            {packetSubtitle ? <p id="sessionItemDrawerPacketLine">{packetSubtitle}</p> : null}
          </div>
          {!proofOpen ? (
            <button className="icon-button" type="button" aria-label="Close item details" onClick={onClose} autoFocus>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </header>

        <div className="session-item-drawer-body">
          <StatusLine status={status} />

          {proofOpen ? (
            <section className="session-detail-section session-detail-proof-form" aria-label="Submit proof">
              <div className="session-detail-section-heading">
                <div>
                  <p className="eyebrow">Proof</p>
                  <h3>{needsMoreProof ? "Send the requested proof" : "Record what you found"}</h3>
                </div>
                <span>Up to 3 photos</span>
              </div>
              <ProofForm
                key={item.id}
                item={item}
                token={token}
                tenantSlug={tenantSlug}
                requestNote={needsMoreProof ? latest.reviewNote : applicableProofRequest(item.submissions, latest)}
                onCancel={onProofCancel}
                onSaved={onProofSaved}
                onStatus={onStatus}
              />
            </section>
          ) : (
            <>
          <div className="session-item-drawer-summary">
            <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
            <span>{item.expectedQty == null ? "Quantity not listed" : `Expected quantity ${item.expectedQty}`}</span>
            <span>{assignedName ? `Assigned to ${assignedName}` : "Unassigned"}</span>
          </div>

          {canManage && item.suggestedInventoryItem ? (
            <PossiblePriorMatchCard
              item={item}
              isSaving={Boolean(matchAction)}
              onConfirm={() => onResolveMatch("confirm")}
              onDismiss={() => onResolveMatch("dismiss")}
            />
          ) : null}

          <details className="session-detail-section session-detail-disclosure">
            <summary>
              <span>
                <small>Packet row</small>
                <strong>Inventory details</strong>
              </span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <dl className="session-detail-facts">
              <div>
                <dt>Packet line</dt>
                <dd>{item.packetLine || "Not provided"}</dd>
              </div>
              <div>
                <dt>Location hint</dt>
                <dd>{item.locationHint || "Not provided"}</dd>
              </div>
              <div>
                <dt>Assignment</dt>
                <dd>{assignedName || "Unassigned"}</dd>
              </div>
              {item.assignedByName || item.assignedByEmail ? (
                <div>
                  <dt>Assigned by</dt>
                  <dd>{item.assignedByName || item.assignedByEmail}{item.assignedAt ? ` - ${formatDate(item.assignedAt)}` : ""}</dd>
                </div>
              ) : null}
              {item.directVerifiedByEmail ? (
                <div>
                  <dt>Direct check</dt>
                  <dd>{item.directVerifiedByEmail}</dd>
                </div>
              ) : null}
              <div>
                <dt>Last updated</dt>
                <dd>{formatDate(item.updatedAt || item.createdAt)}</dd>
              </div>
            </dl>
          </details>

          <details className="session-detail-section session-detail-disclosure">
            <summary>
              <span>
                <small>Previous inventory</small>
                <strong>Saved record</strong>
              </span>
              <span className="session-detail-summary-side">
                {item.inventoryItem ? <span className="session-detail-match">Matched</span> : null}
                <ChevronDown aria-hidden="true" />
              </span>
            </summary>
            {item.inventoryItem ? (
              <>
                <dl className="session-detail-facts">
                  <div>
                    <dt>Common name</dt>
                    <dd>{item.inventoryItem.commonName || item.inventoryItem.title || "Not provided"}</dd>
                  </div>
                  <div>
                    <dt>Army name</dt>
                    <dd>{item.inventoryItem.armyName || "Not provided"}</dd>
                  </div>
                  <div>
                    <dt>LIN</dt>
                    <dd>{item.inventoryItem.lin || "Not provided"}</dd>
                  </div>
                  <div>
                    <dt>NSN</dt>
                    <dd>{item.inventoryItem.nsn || "Not provided"}</dd>
                  </div>
                  <div>
                    <dt>Known location</dt>
                    <dd>{item.inventoryItem.currentLocation || "Not provided"}</dd>
                  </div>
                  <div>
                    <dt>Description</dt>
                    <dd>{item.inventoryItem.description || "Not provided"}</dd>
                  </div>
                </dl>
                {knownImages.length ? (
                  <div className="session-detail-known-photos" aria-label="Known item photos">
                    {knownImages.map((url, index) => (
                      <a href={url} target="_blank" rel="noreferrer" key={url} aria-label={`Open known item photo ${index + 1}`}>
                        <img src={url} alt={`${title} reference ${index + 1}`} loading="lazy" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="session-detail-empty">No saved item record is linked to this packet row yet.</p>
            )}
          </details>

          <details className="session-detail-section session-detail-disclosure">
            <summary>
              <span>
                <small>Traceability</small>
                <strong>Packet source</strong>
              </span>
              <ChevronDown aria-hidden="true" />
            </summary>
            {importBatch ? (
              <div className="session-detail-source">
                <div>
                  <strong>{importBatch.sourceName || "Packet import"}</strong>
                  <span>
                    Imported {formatDate(importBatch.createdAt)}
                    {importBatch.createdByName || importBatch.createdByEmail ? ` by ${importBatch.createdByName || importBatch.createdByEmail}` : ""}
                  </span>
                  <small>
                    {importBatch.sourceMimeType || "Pasted packet text"}
                    {importBatch.sourceSizeBytes ? ` - ${formatFileSize(importBatch.sourceSizeBytes)}` : ""}
                  </small>
                </div>
                {importBatch.sourceUrl ? (
                  <a className="btn btn-secondary btn-small" href={importBatch.sourceUrl} target="_blank" rel="noreferrer">
                    <FileText aria-hidden="true" />
                    <span>Open source</span>
                  </a>
                ) : null}
              </div>
            ) : item.importBatchId ? (
              <p className="session-detail-empty">Imported from a packet batch. Source details are available to platoon admins.</p>
            ) : (
              <p className="session-detail-empty">This row was added manually and is not linked to a packet batch.</p>
            )}
          </details>

          <details className="session-detail-section session-detail-disclosure">
            <summary>
              <span>
                <small>Evidence</small>
                <strong>Proof history</strong>
              </span>
              <span className="session-detail-summary-side">
                <span>{countLabel(item.submissions?.length || 0, "submission")}</span>
                <ChevronDown aria-hidden="true" />
              </span>
            </summary>
            {item.submissions?.length ? (
              <div className="session-detail-proof-list">
                {item.submissions.map(submission => (
                  <article className="session-detail-proof" key={submission.id}>
                    <div className="session-detail-proof-heading">
                      <div>
                        <strong>{formatReviewState(submission.reviewState)}</strong>
                        <span>{submissionPerson(submission)} - {formatDate(submission.createdAt)}</span>
                      </div>
                      <span className={`status-pill ${submission.status}`}>{formatItemStatus(submission.status)}</span>
                    </div>
                    <div className="session-detail-proof-facts">
                      {submission.locationText ? <span>Location: {submission.locationText}</span> : null}
                      {submission.serialNumber ? <span>Serial: {submission.serialNumber}</span> : null}
                    </div>
                    {submission.note ? <p>{submission.note}</p> : null}
                    {submission.reviewNote ? (
                      <p className={submission.reviewState === "request_more_info" ? "session-detail-proof-request" : ""}>
                        {submission.reviewState === "request_more_info" ? "Requested" : "Review note"}: {submission.reviewNote}
                      </p>
                    ) : null}
                    <ProofPhotoStrip
                      photos={submission.photos}
                      compact
                      label={`Evidence from ${submissionPerson(submission)}`}
                      onOpen={index => onOpenPhoto(submission, index)}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <p className="session-detail-empty">No proof has been submitted for this row.</p>
            )}
          </details>

          {canManage ? (
            <details className="session-detail-section session-detail-disclosure session-item-manage-disclosure">
              <summary>
                <span>
                  <small>Leader tools</small>
                  <strong>Manage item</strong>
                </span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <label className="session-assignment-control">
                <span>Assign to</span>
                <select value={assignedMemberId} disabled={isAssignmentPending || isDirectCheckPending || isClosed} onChange={event => onAssign(event.target.value)}>
                  <option value="">Unassigned</option>
                  {assignableMembers.map(member => (
                    <option value={member.id} key={member.id}>
                      {member.displayName || member.email || formatRole(member.role)}
                    </option>
                  ))}
                </select>
              </label>
              {!isClosed ? (
                <div className="button-row session-item-direct-actions">
                  <button className="btn btn-secondary btn-small" type="button" disabled={isAssignmentPending || isDirectCheckPending} onClick={() => onDirectCheck("approved")}>
                    <CheckCircle2 aria-hidden="true" />
                    <span>{directCheckAction === "approved" ? "Marking found..." : "Mark found"}</span>
                  </button>
                  <button className="btn btn-secondary btn-small" type="button" disabled={isAssignmentPending || isDirectCheckPending} onClick={() => onDirectCheck("not_found")}>
                    <span>{directCheckAction === "not_found" ? "Marking not found..." : "Mark not found"}</span>
                  </button>
                </div>
              ) : null}
            </details>
          ) : null}

            </>
          )}
        </div>

        {!proofOpen ? <footer className="session-item-drawer-actions">
          {canClaim ? (
            <button className="btn btn-secondary btn-small" type="button" disabled={isAssignmentPending || isDirectCheckPending} onClick={onClaim}>
              <UserPlus aria-hidden="true" />
              <span>{assignmentAction === "claim" ? "Claiming..." : "Claim item"}</span>
            </button>
          ) : null}
          {canSubmit && !pendingProof && !isClosed ? (
            <button data-proof-item-id={item.id} className="btn btn-primary btn-small" type="button" disabled={isDirectCheckPending} onClick={onOpenProof}>
              <Camera aria-hidden="true" />
              <span>{needsMoreProof ? "Respond with proof" : "Add proof"}</span>
            </button>
          ) : null}
          {canManage && pendingProof && !isClosed && onOpenReview ? (
            <button className="btn btn-primary btn-small" type="button" disabled={isDirectCheckPending} onClick={onOpenReview}>
              <MessageSquare aria-hidden="true" />
              <span>Review proof</span>
            </button>
          ) : null}
          {pendingProof && !canManage ? <span className="session-proof-awaiting">Awaiting review</span> : null}
        </footer> : null}
      </aside>
    </div>
  );
}

function SessionPanel({
  token,
  tenantSlug,
  me = null,
  members = [],
  canManage,
  canSubmit,
  query = "",
  onQueryChange = () => {},
  uploadIntent,
  preferredSessionId = "",
  preferredSessionItemId = "",
  onUploadIntentHandled,
  onPreferredSessionItemHandled,
  onSessionChange,
  onInviteCrew,
  onOpenReview
}) {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [isSessionCreateOpen, setIsSessionCreateOpen] = useState(false);
  const [packetRows, setPacketRows] = useState("");
  const [packetDraftRows, setPacketDraftRows] = useState([]);
  const [packetParseSummary, setPacketParseSummary] = useState(null);
  const [packetSourceName, setPacketSourceName] = useState("");
  const [packetSourceFile, setPacketSourceFile] = useState(null);
  const [isPacketImportOpen, setIsPacketImportOpen] = useState(false);
  const [packetWizardOpen, setPacketWizardOpen] = useState(false);
  const [packetWizardStep, setPacketWizardStep] = useState(1);
  const [packetWizardMode, setPacketWizardMode] = useState("existing");
  const [packetWizardSessionId, setPacketWizardSessionId] = useState("");
  const [packetWizardSessionName, setPacketWizardSessionName] = useState("");
  const [packetWizardSummary, setPacketWizardSummary] = useState(null);
  const [sessionItemFilter, setSessionItemFilter] = useState("available");
  const [proofItemId, setProofItemId] = useState("");
  const [detailItemId, setDetailItemId] = useState("");
  const [detailPhotoViewer, setDetailPhotoViewer] = useState(null);
  const [status, setStatus] = useState({ text: "Loading inventory sessions...", isError: false });
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [packetAction, setPacketAction] = useState("");
  const [deleteSessionTarget, setDeleteSessionTarget] = useState(null);
  const [closeSessionTarget, setCloseSessionTarget] = useState(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [directCheckActions, setDirectCheckActions] = useState(() => new Map());
  const [assignmentActions, setAssignmentActions] = useState(() => new Map());
  const [matchActions, setMatchActions] = useState(() => new Map());
  const [sessionStatusActions, setSessionStatusActions] = useState(() => new Map());
  const [printReportId, setPrintReportId] = useState("");
  const [packetWizardModeTouched, setPacketWizardModeTouched] = useState(false);
  const packetFileInputRef = useRef(null);
  const packetTextareaRef = useRef(null);
  const detailItemTriggerRef = useRef(null);
  const detailPhotoTriggerRef = useRef(null);
  const proofTriggerRef = useRef(null);
  const packetWizardCurrentRef = useRef({ mode: "existing", sessionId: "", sessionName: "" });
  const packetActionRef = useRef("");
  const sessionCreateActionRef = useRef(false);
  const sessionListRequestRef = useRef(0);
  const sessionDetailRequestRef = useRef(0);
  const sessionItemFilterSessionRef = useRef("");
  const directCheckActionRef = useRef(new Map());
  const assignmentActionRef = useRef(new Map());
  const matchActionRef = useRef(new Map());
  const sessionStatusActionRef = useRef(new Map());
  const isPacketUploadIntent = uploadIntent === "packet" || isPacketImportOpen;
  const isPacketBusy = Boolean(packetAction);
  const isReadingPacket = packetAction === "read";

  function beginPacketAction(action) {
    if (packetActionRef.current) return false;
    packetActionRef.current = action;
    setPacketAction(action);
    return true;
  }

  function finishPacketAction(action) {
    if (packetActionRef.current !== action) return;
    packetActionRef.current = "";
    setPacketAction("");
  }

  function clearSelectedSessionState() {
    sessionDetailRequestRef.current += 1;
    setSelectedSessionId("");
    setDetail(null);
    setProofItemId("");
    setDetailItemId("");
    setDetailPhotoViewer(null);
    setPacketWizardSessionId("");
    setIsPacketImportOpen(false);
    clearPacketImport();
  }

  async function loadSessions(nextSelectedId = selectedSessionId) {
    const requestId = sessionListRequestRef.current + 1;
    sessionListRequestRef.current = requestId;
    setIsLoadingSessions(true);

    try {
      setStatus({ text: "Loading inventory sessions...", isError: false });
      const data = await apiRequest("/inventory/sessions", { token, tenantSlug });
      if (requestId !== sessionListRequestRef.current) return false;

      const loaded = sortSessionsByAttention(data.sessions || []);
      setSessions(loaded);
      const selected = nextSelectedId && loaded.some(session => session.id === nextSelectedId)
        ? nextSelectedId
        : loaded.find(session => session.status !== "closed")?.id || "";
      setSelectedSessionId(selected);
      let detailLoaded = true;
      if (selected) {
        detailLoaded = await loadSessionDetail(selected, false, requestId);
      } else {
        clearSelectedSessionState();
      }

      if (detailLoaded && requestId === sessionListRequestRef.current) {
        setStatus({ text: "", isError: false });
      }
      return detailLoaded && requestId === sessionListRequestRef.current;
    } catch (error) {
      if (requestId === sessionListRequestRef.current) {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
    } finally {
      if (requestId === sessionListRequestRef.current) {
        setIsLoadingSessions(false);
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
      if (showStatus) setStatus({ text: "", isError: false });
      return true;
    } catch (error) {
      if (requestId === sessionDetailRequestRef.current && (!sessionListRequestId || sessionListRequestId === sessionListRequestRef.current)) {
        if (error?.status === 404 && !sessionListRequestId) {
          clearSelectedSessionState();
          await loadSessions("");
          setStatus({
            text: "That session is no longer available. Pick another session or start a new one.",
            isError: false
          });
          return false;
        }
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
    }
  }

  useEffect(() => {
    loadSessions(preferredSessionId || selectedSessionId);
  }, [tenantSlug, token, preferredSessionId]);

  useEffect(() => {
    if (uploadIntent !== "packet") return;
    openPacketWizard(preferredSessionId || selectedSessionId || openSessions[0]?.id || "");
    setStatus({ text: "", isError: false });
    onUploadIntentHandled?.();
  }, [uploadIntent, onUploadIntentHandled]);

  useEffect(() => {
    onQueryChange("");
    sessionItemFilterSessionRef.current = "";
    setSessionItemFilter("available");
    setProofItemId("");
    setDetailItemId("");
    setDetailPhotoViewer(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (
      !selectedSessionId
      || detail?.session?.id !== selectedSessionId
      || !detail?.items
      || sessionItemFilterSessionRef.current === selectedSessionId
    ) return;
    const actionableItems = detail.items.filter(item => !sessionItemIsComplete(item));
    if (!actionableItems.length) {
      setSessionItemFilter("available");
      return;
    }
    const nextFilter = actionableItems.some(item => sessionItemAssignmentBucket(item, me) === "mine")
      ? "mine"
      : actionableItems.some(item => sessionItemAssignmentBucket(item, me) === "available")
        ? "available"
        : "team";
    sessionItemFilterSessionRef.current = selectedSessionId;
    setSessionItemFilter(nextFilter);
  }, [selectedSessionId, detail?.items, me?.user?.id, me?.user?.email]);

  useEffect(() => {
    if (!preferredSessionItemId || !detail?.items?.some(item => item.id === preferredSessionItemId)) return;
    openItemDetail(preferredSessionItemId);
    onPreferredSessionItemHandled?.();
  }, [preferredSessionItemId, detail?.items, onPreferredSessionItemHandled]);

  async function selectSession(sessionId) {
    if (!sessionId) return;
    setStatus({ text: "", isError: false });
    setSelectedSessionId(sessionId);
    onSessionChange?.(sessionId);
    await loadSessionDetail(sessionId);
  }

  function findDuplicateOpenEmptySession(name) {
    const normalizedName = normalizeSessionName(name);
    if (!normalizedName) return null;
    return sessions.find(session =>
      session.status !== "closed" &&
      Number(session.itemCount || 0) === 0 &&
      normalizeSessionName(session.name) === normalizedName
    ) || null;
  }

  async function openExistingEmptySession(session, message = "") {
    if (!session?.id) return "";
    setSelectedSessionId(session.id);
    onSessionChange?.(session.id);
    setPacketWizardMode("existing");
    setPacketWizardSessionId(session.id);
    setPacketWizardSessionName("");
    setNewSessionName("");
    clearPacketImport();
    await loadSessionDetail(session.id, false);
    setStatus({
      text: message || `${session.name} is already an empty session. Opened it instead.`,
      isError: false
    });
    return session.id;
  }

  async function createSession(e) {
    e.preventDefault();
    if (sessionCreateActionRef.current) return;
    const name = newSessionName.trim();
    if (!name) return;

    const duplicate = findDuplicateOpenEmptySession(name);
    if (duplicate) {
      await openExistingEmptySession(duplicate);
      return;
    }

    try {
      sessionCreateActionRef.current = true;
      setIsSaving(true);
      const data = await apiRequest("/inventory/sessions", {
        method: "POST",
        token,
        tenantSlug,
        body: { name, status: "active" }
      });
      setNewSessionName("");
      setIsSessionCreateOpen(false);
      setStatus({ text: `Started ${data.session.name}`, isError: false });
      onSessionChange?.(data.session.id);
      await loadSessions(data.session.id);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      sessionCreateActionRef.current = false;
      setIsSaving(false);
    }
  }

  function openPacketWizard(sessionId = selectedSessionId) {
    const fallbackSessionId = sessionId || selectedSessionId || openSessions[0]?.id || "";
    setPacketWizardModeTouched(false);
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
    if (packetActionRef.current) return;
    setPacketWizardModeTouched(false);
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

  async function refreshSessions() {
    await loadSessions(selectedSessionId);
  }

  function requestDeleteSession(session) {
    if (!session || Number(session.itemCount || 0) > 0) return;
    setDeleteSessionTarget(session);
    setStatus({ text: "", isError: false });
  }

  function closeDeleteSessionDialog() {
    if (isDeletingSession) return;
    setDeleteSessionTarget(null);
  }

  function requestCloseSession(session) {
    if (!session || session.status === "closed" || sessionStatusActionRef.current.has(session.id)) return;
    setCloseSessionTarget(session);
    setStatus({ text: "", isError: false });
  }

  function closeCloseSessionDialog() {
    if (isSaving || (closeSessionTarget?.id && sessionStatusActionRef.current.has(closeSessionTarget.id))) return;
    setCloseSessionTarget(null);
  }

  async function confirmCloseSession() {
    if (!closeSessionTarget?.id) return;
    const target = closeSessionTarget;
    const didClose = await updateSessionStatus("closed", target.id);
    if (didClose) setCloseSessionTarget(null);
  }

  async function preparePacketWizardSession() {
    const action = "prepare";
    if (!beginPacketAction(action)) return "";
    const currentWizard = packetWizardCurrentRef.current;
    const fallbackSessionId = currentWizard.sessionId;
    const shouldUseExistingSession = currentWizard.mode === "existing";

    try {
      if (shouldUseExistingSession) {
        const sessionId = fallbackSessionId;
        if (!sessionId) {
          setStatus({ text: "Choose a session or create a new one first.", isError: true });
          return "";
        }

        setSelectedSessionId(sessionId);
        onSessionChange?.(sessionId);
        setPacketWizardSessionId(sessionId);
        setPacketWizardStep(2);
        setStatus({ text: "", isError: false });
        void loadSessionDetail(sessionId, false);
        return sessionId;
      }

      const name = currentWizard.sessionName.trim();
      if (!name) {
        setStatus({ text: "Name the inventory session first.", isError: true });
        return "";
      }

      const duplicate = findDuplicateOpenEmptySession(name);
      if (duplicate) {
        const sessionId = await openExistingEmptySession(
          duplicate,
          `${duplicate.name} is already an empty session. Using that session instead.`
        );
        if (sessionId) setPacketWizardStep(2);
        return sessionId;
      }

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
      onSessionChange?.(data.session.id);
      await loadSessions(data.session.id);
      setPacketWizardStep(2);
      setStatus({ text: `Started ${data.session.name}`, isError: false });
      return data.session.id;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return "";
    } finally {
      finishPacketAction(action);
    }
  }

  function reviewPacketRows(sourceText = packetRows, sourceName = packetSourceName, sessionId = selectedSessionId, sourceMeta = packetSourceFile) {
    if (!sessionId) {
      setStatus({ text: "Create or select a session first.", isError: true });
      return [];
    }

    const analysis = analyzePacketRows(sourceText);
    const rows = createPacketDraftRows(analysis.rows);
    const source = sourceMeta || {};
    const displaySourceName = sourceName || source.fileName || "Pasted packet text";
    setPacketDraftRows(rows);
    setPacketParseSummary({
      ...analysis,
      sourceName: displaySourceName,
      sourceType: describePacketSourceType(source.fileName || source.mimeType ? source : { fileName: displaySourceName })
    });
    setPacketSourceName(sourceName || source.fileName || "");

    if (!rows.length) {
      setStatus({ text: "No packet rows found. Try pasting one item per line.", isError: true });
      return [];
    }

    setStatus({ text: `Found ${rows.length} packet rows and ignored ${analysis.ignoredCount} non-item lines.`, isError: false });
    return rows;
  }

  async function readPacketUpload(file) {
    if (!file) return;
    const mimeType = packetMimeTypeForFile(file);
    if (!supportedPacketMimeTypes.has(mimeType)) {
      setStatus({ text: "Choose a PDF, CSV, text file, or JPEG/PNG/WebP/GIF image.", isError: true });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus({ text: "Packet source files must be 10MB or smaller.", isError: true });
      return;
    }

    const action = "read";
    if (!beginPacketAction(action)) return;
    try {
      setStatus({ text: "Reading packet file...", isError: false });
      const [text, dataUrl] = await Promise.all([
        readPacketFileText(file, message => setStatus({ text: message, isError: false })),
        fileToDataUrl(file)
      ]);
      setPacketRows(text);
      setPacketSourceFile({
        fileName: file.name,
        mimeType,
        dataUrl,
        size: file.size
      });
      const rows = reviewPacketRows(
        text,
        file.name,
        packetWizardSessionId || selectedSessionId,
        {
          fileName: file.name,
          mimeType,
          size: file.size
        }
      );
      if (rows.length) setPacketWizardStep(3);
    } catch (error) {
      setStatus({ text: error.message || "Could not read packet file.", isError: true });
    } finally {
      finishPacketAction(action);
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
    setPacketParseSummary(null);
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
    const rows = reviewPacketRows(
      batch.extractedText,
      batch.sourceName || "Saved import",
      selectedSessionId,
      { fileName: batch.sourceName || "Saved import", mimeType: batch.sourceMimeType || "text/plain" }
    );
    if (!rows.length) return;
    setPacketWizardModeTouched(false);
    setPacketWizardOpen(true);
    setPacketWizardStep(3);
    setPacketWizardSummary(null);
    setPacketWizardMode("existing");
    setPacketWizardSessionId(selectedSessionId);
    setPacketWizardSessionName("");
    setIsPacketImportOpen(false);
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

    const action = "import";
    if (!beginPacketAction(action)) return null;

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
        size: packetSourceFile.size,
        dataUrl: packetSourceFile.dataUrl
      };
    }

    try {
      const data = await apiRequest(`/inventory/sessions/${targetSessionId}/items/bulk`, {
        method: "POST",
        token,
        tenantSlug,
        body: { items, importBatch }
      });
      const possibleMatchCount = Number(
        data.possibleMatchCount
        ?? (data.sessionItems || []).filter(item => item.suggestedInventoryItemId || item.suggested_inventory_item_id).length
        ?? 0
      );
      clearPacketImport();
      setStatus({
        text: possibleMatchCount
          ? `Added ${items.length} packet rows. ${possibleMatchCount} possible previous ${possibleMatchCount === 1 ? "record needs" : "records need"} review.`
          : `Added ${items.length} packet rows.`,
        isError: false
      });
      await loadSessions(targetSessionId);
      return { count: items.length, sourceName, sessionId: targetSessionId, possibleMatchCount };
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return null;
    } finally {
      finishPacketAction(action);
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
    if (!sessionItemId || directCheckActionRef.current.has(sessionItemId)) return false;

    directCheckActionRef.current.set(sessionItemId, nextStatus);
    setDirectCheckActions(current => {
      const next = new Map(current);
      next.set(sessionItemId, nextStatus);
      return next;
    });

    const target = detail?.items?.find(item => item.id === sessionItemId);
    const targetLabel = target ? itemDisplayName(target) : "session item";
    const actionLabel = nextStatus === "approved" ? "found" : "not found";
    try {
      setStatus({ text: `Marking ${targetLabel} ${actionLabel}...`, isError: false });
      await apiRequest(`/session-items/${sessionItemId}/direct-check`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { status: nextStatus }
      });
      const refreshed = await loadSessions(selectedSessionId);
      if (refreshed) setStatus({ text: "Session item updated.", isError: false });
      return true;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return false;
    } finally {
      directCheckActionRef.current.delete(sessionItemId);
      setDirectCheckActions(current => {
        const next = new Map(current);
        next.delete(sessionItemId);
        return next;
      });
    }
  }

  async function resolvePriorMatch(sessionItemId, action) {
    if (!sessionItemId || matchActionRef.current.has(sessionItemId)) return false;
    const remainingCandidates = (detail?.items || []).filter(item => item.suggestedInventoryItem && item.id !== sessionItemId);
    const nextCandidateId = remainingCandidates[0]?.id || "";

    matchActionRef.current.set(sessionItemId, action);
    setMatchActions(current => {
      const next = new Map(current);
      next.set(sessionItemId, action);
      return next;
    });

    try {
      setStatus({ text: action === "confirm" ? "Linking the saved record..." : "Removing the suggested match...", isError: false });
      await apiRequest(`/session-items/${sessionItemId}/inventory-match`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { action }
      });
      await loadSessionDetail(selectedSessionId, false);
      if (nextCandidateId) {
        setProofItemId("");
        setDetailItemId(nextCandidateId);
        setStatus({
          text: `${action === "confirm" ? "Saved record linked." : "Suggestion removed."} ${remainingCandidates.length} possible ${remainingCandidates.length === 1 ? "match remains" : "matches remain"}.`,
          isError: false
        });
      } else {
        setStatus({ text: action === "confirm" ? "Saved record linked." : "Suggestion removed.", isError: false });
      }
      return true;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      if (error?.status === 409) await loadSessionDetail(selectedSessionId, false);
      return false;
    } finally {
      matchActionRef.current.delete(sessionItemId);
      setMatchActions(current => {
        const next = new Map(current);
        next.delete(sessionItemId);
        return next;
      });
    }
  }

  async function updateSessionItemAssignment(sessionItemId, memberId, { claim = false } = {}) {
    if (!sessionItemId || assignmentActionRef.current.has(sessionItemId)) return false;

    const action = claim ? "claim" : "assign";
    if (claim) {
      proofTriggerRef.current = document.activeElement;
      detailItemTriggerRef.current = document.activeElement;
    }
    assignmentActionRef.current.set(sessionItemId, action);
    setAssignmentActions(current => {
      const next = new Map(current);
      next.set(sessionItemId, action);
      return next;
    });

    try {
      setStatus({ text: claim ? "Claiming item..." : "Saving assignment...", isError: false });
      await apiRequest(`/session-items/${sessionItemId}/assignment`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { memberId: memberId || null }
      });
      setStatus({
        text: claim ? "Item claimed. Add proof now." : memberId ? "Row assigned." : "Row assignment cleared.",
        isError: false
      });
      await loadSessionDetail(selectedSessionId, false);
      if (claim) {
        setSessionItemFilter("mine");
        setDetailItemId(sessionItemId);
        setProofItemId(sessionItemId);
      } else if (!memberId) {
        setSessionItemFilter("available");
      } else {
        const target = assignmentOptions.find(member => member.id === memberId);
        setSessionItemFilter(target?.userId && target.userId === me?.user?.id ? "mine" : "team");
      }
      return true;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      if (error?.status === 409) await loadSessionDetail(selectedSessionId, false);
      return false;
    } finally {
      assignmentActionRef.current.delete(sessionItemId);
      setAssignmentActions(current => {
        const next = new Map(current);
        next.delete(sessionItemId);
        return next;
      });
    }
  }

  async function updateSessionStatus(nextStatus, sessionIdOverride = selectedSessionId) {
    if (!sessionIdOverride || sessionStatusActionRef.current.has(sessionIdOverride)) return false;
    const sessionId = sessionIdOverride;

    sessionStatusActionRef.current.set(sessionId, nextStatus);
    setSessionStatusActions(current => {
      const next = new Map(current);
      next.set(sessionId, nextStatus);
      return next;
    });

    try {
      setStatus({ text: nextStatus === "closed" ? "Closing session..." : "Reopening session...", isError: false });
      const data = await apiRequest(`/inventory/sessions/${sessionId}`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { status: nextStatus }
      });
      const refreshed = await loadSessions(nextStatus === "closed" ? "" : sessionId);
      if (refreshed) {
        const crewAccessRevoked = Number(data.crewAccessRevoked || 0);
        const message = nextStatus === "closed"
          ? crewAccessRevoked
            ? `Session closed. ${crewAccessRevoked} temporary crew ${crewAccessRevoked === 1 ? "pass" : "passes"} removed.`
            : "Session closed."
          : "Session reopened.";
        setStatus({ text: message, isError: false });
      }
      return true;
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      return false;
    } finally {
      sessionStatusActionRef.current.delete(sessionId);
      setSessionStatusActions(current => {
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function deleteEmptySession() {
    if (!deleteSessionTarget?.id) return;
    const target = deleteSessionTarget;

    try {
      setIsDeletingSession(true);
      setStatus({ text: "", isError: false });
      await apiRequest(`/inventory/sessions/${target.id}`, {
        method: "DELETE",
        token,
        tenantSlug
      });
      setDeleteSessionTarget(null);
      if (selectedSessionId === target.id) {
        setSelectedSessionId("");
        setDetail(null);
        clearPacketImport();
        setPacketWizardOpen(false);
        setPacketWizardSessionId("");
      }
      await loadSessions("");
      setStatus({ text: `Deleted empty session ${target.name}.`, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsDeletingSession(false);
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
  const assignableMembers = useMemo(
    () => (members || []).filter(member =>
      member.status === "active" && ["tenant_admin", "contributor"].includes(member.role)
    ),
    [members]
  );
  const assignmentOptions = useMemo(() => {
    const options = [...assignableMembers];
    const currentUserId = me?.user?.id || "";
    if (currentUserId && !options.some(member => member.userId === currentUserId)) {
      options.unshift({
        id: "self",
        userId: currentUserId,
        displayName: `${me?.user?.display_name || me?.user?.email || "Current user"} (you)`,
        email: me?.user?.email || "",
        role: me?.membership?.role || (canManage ? "tenant_admin" : "contributor")
      });
    }
    return options;
  }, [assignableMembers, me?.user?.id, me?.user?.display_name, me?.user?.email, me?.membership?.role, canManage]);
  const assignedMemberIdByUserId = useMemo(() => {
    const lookup = new Map();
    assignmentOptions.forEach(member => {
      if (member.userId) lookup.set(member.userId, member.id);
    });
    return lookup;
  }, [assignmentOptions]);
  const detailItems = useMemo(
    () => [...(detail?.items || [])].sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b)),
    [detail?.items]
  );
  const actionableDetailItems = useMemo(
    () => detailItems.filter(item => !sessionItemIsComplete(item)),
    [detailItems]
  );
  const completedDetailItems = useMemo(
    () => detailItems.filter(sessionItemIsComplete),
    [detailItems]
  );
  const possibleMatchItems = useMemo(
    () => detailItems.filter(item => item.suggestedInventoryItem),
    [detailItems]
  );
  const sessionItemFilterCounts = useMemo(() => ({
    available: actionableDetailItems.filter(item => sessionItemAssignmentBucket(item, me) === "available").length,
    mine: actionableDetailItems.filter(item => sessionItemAssignmentBucket(item, me) === "mine").length,
    team: actionableDetailItems.filter(item => sessionItemAssignmentBucket(item, me) === "team").length
  }), [actionableDetailItems, me]);
  const visibleDetailItems = useMemo(
    () => actionableDetailItems.filter(item => sessionItemAssignmentBucket(item, me) === sessionItemFilter && sessionItemMatchesQuery(item, query)),
    [actionableDetailItems, sessionItemFilter, query, me]
  );
  const visibleCompletedItems = useMemo(
    () => completedDetailItems.filter(item => sessionItemMatchesQuery(item, query)),
    [completedDetailItems, query]
  );
  const sessionItemFilterOptions = [
    ["available", "Unclaimed"],
    ["mine", "Mine"],
    ["team", "Others"]
  ];
  const sessionReport = useMemo(
    () => selectedSession ? buildSessionReport(selectedSession, detail?.items || []) : null,
    [selectedSession, detail?.items]
  );
  const importBatches = detail?.importBatches || [];
  const detailItem = detailItems.find(item => item.id === detailItemId) || null;
  const detailItemImportBatch = detailItem?.importBatchId
    ? importBatches.find(batch => batch.id === detailItem.importBatchId) || null
    : null;
  const detailItemAssignedMemberId = detailItem?.assignedTo
    ? assignedMemberIdByUserId.get(detailItem.assignedTo) || ""
    : "";

  useEffect(() => {
    if (detailItemId && !detailItem) {
      setDetailItemId("");
      setDetailPhotoViewer(null);
    }
  }, [detailItemId, detailItem]);

  useEffect(() => {
    if (!detailItem && !detailPhotoViewer) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [Boolean(detailItem), Boolean(detailPhotoViewer)]);

  useEffect(() => {
    if (!detailItem || detailPhotoViewer) return undefined;
    const handleEscape = event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeItemDetail();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [Boolean(detailItem), Boolean(detailPhotoViewer)]);

  function openItemDetail(itemId) {
    detailItemTriggerRef.current = document.activeElement;
    setProofItemId("");
    setDetailItemId(itemId);
  }

  function openFirstPossibleMatch() {
    const first = possibleMatchItems[0];
    if (!first) return;
    if (packetWizardOpen) closePacketWizard();
    openItemDetail(first.id);
  }

  function openProof(itemId) {
    proofTriggerRef.current = document.activeElement;
    if (detailItemId !== itemId) {
      detailItemTriggerRef.current = document.activeElement;
      setDetailItemId(itemId);
    }
    setProofItemId(itemId);
  }

  function closeItemDetail() {
    setProofItemId("");
    setDetailPhotoViewer(null);
    setDetailItemId("");
    window.requestAnimationFrame(() => detailItemTriggerRef.current?.focus?.());
  }

  function openDetailPhotoViewer(submission, index) {
    if (!detailItem || !submission?.photos?.length) return;
    detailPhotoTriggerRef.current = document.activeElement;
    setDetailPhotoViewer({
      photos: submission.photos,
      index,
      isZoomed: false,
      packetLine: detailItem.packetLine || itemDisplayName(detailItem),
      sessionName: selectedSession?.name || "Inventory session",
      submittedBy: submissionPerson(submission),
      createdAt: submission.createdAt,
      locationText: submission.locationText,
      serialNumber: submission.serialNumber,
      note: submission.note,
      requestedProof: applicableProofRequest(detailItem.submissions, submission)
    });
  }

  function closeDetailPhotoViewer() {
    setDetailPhotoViewer(null);
    window.requestAnimationFrame(() => detailPhotoTriggerRef.current?.focus?.());
  }

  function moveDetailPhotoViewer(delta) {
    setDetailPhotoViewer(current => {
      if (!current?.photos?.length) return current;
      const index = (current.index + delta + current.photos.length) % current.photos.length;
      return { ...current, index, isZoomed: false };
    });
  }

  function selectDetailPhotoViewer(index) {
    setDetailPhotoViewer(current => current ? { ...current, index, isZoomed: false } : current);
  }
  const packetRowsReadyCount = sanitizePacketDraftRows(packetDraftRows).length;
  const lowConfidencePacketRowCount = packetDraftRows.filter(row => row.confidence === "low").length;
  const packetIgnoredPreview = packetParseSummary?.ignoredLines || [];
  const selectedSessionIsClosed = selectedSession?.status === "closed";
  const selectedSessionStatusAction = selectedSession?.id ? sessionStatusActions.get(selectedSession.id) || "" : "";
  const closeSessionAction = closeSessionTarget?.id ? sessionStatusActions.get(closeSessionTarget.id) || "" : "";
  const detailItemDirectCheckAction = detailItem?.id ? directCheckActions.get(detailItem.id) || "" : "";
  const detailItemAssignmentAction = detailItem?.id ? assignmentActions.get(detailItem.id) || "" : "";
  const detailItemMatchAction = detailItem?.id ? matchActions.get(detailItem.id) || "" : "";
  const detailItemAssignedToCurrentUser = detailItem ? sessionItemAssignedToUser(detailItem, me) : false;
  const detailCanClaim = Boolean(
    detailItem
    && canSubmit
    && !detailItem.assignedTo
    && !detailItem.assignedToEmail
    && !sessionItemIsComplete(detailItem)
    && latestSubmission(detailItem)?.reviewState !== "pending"
    && !selectedSessionIsClosed
  );
  const detailCanSubmitProof = Boolean(
    detailItem
    && canSubmit
    && detailItemAssignedToCurrentUser
    && !sessionItemIsComplete(detailItem)
  );
  const openSessions = useMemo(
    () => sessions.filter(session => session.status !== "closed"),
    [sessions]
  );
  const packetWizardFallbackSessionId = packetWizardSessionId || selectedSessionId || openSessions[0]?.id || "";
  const effectivePacketWizardMode = (
    !packetWizardModeTouched && !packetWizardSessionName.trim() && packetWizardFallbackSessionId
  ) ? "existing" : packetWizardMode;
  packetWizardCurrentRef.current = {
    mode: effectivePacketWizardMode,
    sessionId: packetWizardFallbackSessionId,
    sessionName: packetWizardSessionName
  };
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
        onClick={() => selectSession(session.id)}
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
          <span className={`status-pill ${session.status}`}>{formatItemStatus(session.status)}</span>
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
        <button className="icon-button admin-card-heading-action" type="button" aria-label="Refresh sessions" title="Refresh sessions" onClick={refreshSessions}>
          <RefreshCw aria-hidden="true" />
        </button>
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
            <details
              className="session-create"
              open={isSessionCreateOpen || (!isLoadingSessions && !sessions.length)}
              onToggle={event => setIsSessionCreateOpen(event.currentTarget.open)}
            >
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
                    disabled={isSaving}
                    placeholder="July sensitive items"
                    onChange={e => setNewSessionName(e.target.value)}
                  />
                  <button className="btn btn-primary" type="submit" disabled={isSaving}>
                    <Plus aria-hidden="true" />
                    <span>{isSaving ? "Starting session..." : "Start session"}</span>
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
                <div className="admin-row-meta session-summary-actions">
                  <span className="badge">{selectedSession.foundCount || 0} found</span>
                  <span className="badge">{selectedSession.needsReviewCount || 0} needs review</span>
                  {canManage && selectedSession.status === "active" && onInviteCrew ? (
                    <button className="btn btn-primary btn-small" type="button" onClick={() => onInviteCrew(selectedSession)}>
                      <UserPlus aria-hidden="true" />
                      <span>Invite crew</span>
                    </button>
                  ) : null}
                  {canManage ? (
                    Number(selectedSession.itemCount || 0) === 0 ? (
                      <button className="btn btn-danger-soft btn-small" type="button" disabled={Boolean(selectedSessionStatusAction)} onClick={() => requestDeleteSession(selectedSession)}>
                        <Trash2 aria-hidden="true" />
                        <span>Delete draft</span>
                      </button>
                    ) : (
                      selectedSession.status !== "closed" ? (
                        <button className="btn btn-secondary btn-small" type="button" disabled={Boolean(selectedSessionStatusAction)} onClick={() => requestCloseSession(selectedSession)}>
                          <span>{selectedSessionStatusAction === "closed" ? "Closing..." : "Close out"}</span>
                        </button>
                      ) : (
                        <button className="btn btn-secondary btn-small" type="button" disabled={Boolean(selectedSessionStatusAction)} onClick={() => updateSessionStatus("active")}>
                          <span>{selectedSessionStatusAction === "active" ? "Reopening..." : "Reopen"}</span>
                        </button>
                      )
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
                <details className="packet-import-history">
                  <summary className="packet-import-history-heading">
                    <strong>Import history</strong>
                    <span>{importBatches.length}</span>
                  </summary>
                  <div className="packet-import-history-list">
                    {importBatches.slice(0, 4).map(batch => (
                      <div className="packet-import-history-row" key={batch.id}>
                        <div>
                          <strong>{batch.sourceName || "Packet import"}</strong>
                          <span>
                            {batch.rowCount || 0} rows - {formatDate(batch.createdAt)}
                            {batch.sourceMimeType ? ` - ${batch.sourceMimeType}` : ""}
                            {batch.sourceSizeBytes ? ` - ${formatFileSize(batch.sourceSizeBytes)}` : ""}
                            {batch.createdByName || batch.createdByEmail ? ` - uploaded by ${batch.createdByName || batch.createdByEmail}` : ""}
                          </span>
                        </div>
                        <div className="packet-import-history-actions">
                          {batch.sourceUrl ? (
                            <a className="btn btn-secondary btn-small" href={batch.sourceUrl} target="_blank" rel="noreferrer">
                              <FileText aria-hidden="true" />
                              <span>Source</span>
                            </a>
                          ) : null}
                          {!selectedSessionIsClosed ? (
                            <button className="btn btn-secondary btn-small" type="button" onClick={() => retryImportBatch(batch)}>
                              <ClipboardPlus aria-hidden="true" />
                              <span>Review again</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {canManage && !selectedSessionIsClosed ? (
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
                    disabled={isPacketBusy || isSaving}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      readPacketUpload(file);
                    }}
                  />
                </div>
              ) : null}

              {canManage && possibleMatchItems.length && !selectedSessionIsClosed ? (
                <div className="prior-match-banner">
                  <History aria-hidden="true" />
                  <div>
                    <strong>{possibleMatchItems.length} possible previous {possibleMatchItems.length === 1 ? "record" : "records"}</strong>
                    <span>Confirm the same physical item before the team uses old locations or photos.</span>
                  </div>
                  <button className="btn btn-secondary btn-small" type="button" onClick={openFirstPossibleMatch}>
                    <span>Review matches</span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ) : null}

              {actionableDetailItems.length ? (
                <div className="session-item-toolbar">
                  <div className="session-filter-strip session-assignment-tabs" role="group" aria-label="Work assignment lists">
                    {sessionItemFilterOptions.map(([value, label]) => (
                      <button
                        className={sessionItemFilter === value ? "active" : ""}
                        type="button"
                        key={value}
                        aria-pressed={sessionItemFilter === value}
                        onClick={() => setSessionItemFilter(value)}
                      >
                        <span>{label}</span>
                        <strong>{sessionItemFilterCounts[value] || 0}</strong>
                      </button>
                    ))}
                  </div>
                  <div className="session-filter-meta">
                    <span>{visibleDetailItems.length} in this list</span>
                    {query.trim() ? (
                      <button
                        className="btn btn-secondary btn-small"
                        type="button"
                        onClick={() => {
                          onQueryChange("");
                        }}
                      >
                        <RefreshCw aria-hidden="true" />
                        <span>Reset</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="session-items" role="region" aria-label="Session row results">
                {visibleDetailItems.length ? visibleDetailItems.map(item => {
                  const submission = latestSubmission(item);
                  const needsMoreProof = submission?.reviewState === "request_more_info";
                  const pendingProof = submission?.reviewState === "pending";
                  const knownLocation = item.inventoryItem?.currentLocation || "";
                  const assignedName = assignedPerson(item);
                  const assignedToCurrentUser = sessionItemAssignedToUser(item, me);
                  const canClaim = Boolean(canSubmit && !pendingProof && !item.assignedTo && !item.assignedToEmail && !selectedSessionIsClosed);
                  const canSubmitItemProof = Boolean(canSubmit && assignedToCurrentUser);
                  const directCheckAction = directCheckActions.get(item.id) || "";
                  const assignmentAction = assignmentActions.get(item.id) || "";
                  const isDirectCheckPending = Boolean(directCheckAction);
                  const isAssignmentPending = Boolean(assignmentAction);
                  return (
                    <article className={`session-item ${needsMoreProof ? "needs-response" : ""}`} key={item.id}>
                      <div className="session-item-main">
                        <FileText aria-hidden="true" />
                        <div>
                          <strong>{item.inventoryItem?.commonName || item.inventoryItem?.title || item.packetLine || "Untitled row"}</strong>
                          {item.inventoryItem?.lin || item.inventoryItem?.nsn ? (
                            <span>
                              {[item.inventoryItem.lin ? `LIN ${item.inventoryItem.lin}` : "", item.inventoryItem.nsn ? `NSN ${item.inventoryItem.nsn}` : ""].filter(Boolean).join(" · ")}
                            </span>
                          ) : item.packetLine && item.packetLine !== itemDisplayName(item) ? <span>{item.packetLine}</span> : null}
                          {item.locationHint || knownLocation ? <small>{item.locationHint || knownLocation}</small> : null}
                          {item.inventoryItem ? <small className="session-prior-chip confirmed">Saved record</small> : null}
                          {canManage && item.suggestedInventoryItem ? <small className="session-prior-chip suggested">Possible previous record</small> : null}
                          {submission ? (
                            <small className={`session-proof-state ${needsMoreProof ? "requested" : ""}`}>
                              {formatReviewState(submission.reviewState)}
                            </small>
                          ) : null}
                          {needsMoreProof && submission.reviewNote ? (
                            <small className="session-proof-request">Requested: {submission.reviewNote}</small>
                          ) : null}
                          <small className={`session-assignment-summary ${assignedName ? "assigned" : ""}`}>
                            {assignedName ? `Assigned to ${assignedName}` : "Unassigned"}
                          </small>
                        </div>
                      </div>
                      <div className="session-item-actions">
                        <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                        <button
                          className="btn btn-secondary btn-small session-row-details-action"
                          type="button"
                          aria-label={`Open details for ${itemDisplayName(item)}`}
                          aria-haspopup="dialog"
                          onClick={() => openItemDetail(item.id)}
                        >
                          <ChevronRight aria-hidden="true" />
                          <span>Details</span>
                        </button>
                        {canClaim ? (
                          <button
                            className="btn btn-secondary btn-small session-row-claim-action"
                            type="button"
                            disabled={isAssignmentPending || isDirectCheckPending}
                            onClick={() => updateSessionItemAssignment(item.id, "self", { claim: true })}
                          >
                            <UserPlus aria-hidden="true" />
                            <span>{assignmentAction === "claim" ? "Claiming..." : "Claim item"}</span>
                          </button>
                        ) : null}
                        {pendingProof && canManage && onOpenReview && !selectedSessionIsClosed ? (
                          <button className="btn btn-primary btn-small session-row-primary-action" type="button" onClick={onOpenReview}>
                            <MessageSquare aria-hidden="true" />
                            <span>Review proof</span>
                          </button>
                        ) : pendingProof ? (
                          <span className="session-proof-awaiting">Awaiting review</span>
                        ) : canSubmitItemProof && selectedSession.status !== "closed" ? (
                          <button data-proof-item-id={item.id} className="btn btn-primary btn-small session-row-primary-action" type="button" disabled={isAssignmentPending || isDirectCheckPending} onClick={() => openProof(item.id)}>
                            <Camera aria-hidden="true" />
                            <span>{needsMoreProof ? "Respond" : "Add proof"}</span>
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                }) : query.trim() && visibleCompletedItems.length ? null : actionableDetailItems.length ? (
                  <EmptyPanel
                    title={query.trim()
                      ? "No matching items"
                      : sessionItemFilter === "available"
                        ? "No items available to claim"
                        : sessionItemFilter === "mine"
                          ? "No items assigned to you"
                          : "No team assignments"}
                    body={query.trim()
                      ? "Clear the search or try another assignment list."
                      : sessionItemFilter === "available"
                        ? "Choose Mine or Others to see claimed items."
                        : sessionItemFilter === "mine"
                          ? "Claim an available item to start working it."
                          : "Items claimed by teammates will appear here."}
                  />
                ) : detailItems.length ? (
                  <EmptyPanel
                    title="All current work is complete"
                    body="Open Completed below to review item details and submitted proof."
                  />
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

              {completedDetailItems.length ? (
                <details className="session-completed-items" open={Boolean(query.trim() && visibleCompletedItems.length)}>
                  <summary>
                    <span>Completed</span>
                    <strong>{completedDetailItems.length}</strong>
                  </summary>
                  <div className="session-completed-list">
                    {visibleCompletedItems.length ? visibleCompletedItems.map(item => (
                      <button
                        className="session-completed-item"
                        type="button"
                        key={item.id}
                        aria-label={`Open details for completed item ${itemDisplayName(item)}`}
                        onClick={() => openItemDetail(item.id)}
                      >
                        <span>
                          <strong>{itemDisplayName(item)}</strong>
                          <small>{assignedPerson(item) ? `Completed by ${assignedPerson(item)}` : "Completed"}</small>
                        </span>
                        <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                        <ChevronRight aria-hidden="true" />
                      </button>
                    )) : (
                      <p>No completed items match this search.</p>
                    )}
                  </div>
                </details>
              ) : null}
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

      <SessionItemDrawer
        item={detailItem}
        session={selectedSession}
        importBatch={detailItemImportBatch}
        canManage={canManage}
        canSubmit={detailCanSubmitProof}
        canClaim={detailCanClaim}
        assignmentAction={detailItemAssignmentAction}
        directCheckAction={detailItemDirectCheckAction}
        matchAction={detailItemMatchAction}
        isClosed={selectedSessionIsClosed}
        status={status}
        assignableMembers={assignmentOptions}
        assignedMemberId={detailItemAssignedMemberId}
        proofOpen={Boolean(detailItem && proofItemId === detailItem.id)}
        token={token}
        tenantSlug={tenantSlug}
        onAssign={memberId => updateSessionItemAssignment(detailItem.id, memberId)}
        onClaim={() => updateSessionItemAssignment(detailItem.id, "self", { claim: true })}
        onDirectCheck={nextStatus => updateDirectCheck(detailItem.id, nextStatus)}
        onResolveMatch={action => resolvePriorMatch(detailItem.id, action)}
        onOpenProof={() => openProof(detailItem.id)}
        onOpenReview={canManage && onOpenReview ? () => {
          setProofItemId("");
          setDetailPhotoViewer(null);
          setDetailItemId("");
          onOpenReview();
        } : null}
        onOpenPhoto={openDetailPhotoViewer}
        onProofCancel={closeItemDetail}
        onProofSaved={() => {
          closeItemDetail();
          loadSessions(selectedSessionId);
        }}
        onStatus={setStatus}
        onClose={closeItemDetail}
      />

      <ProofPhotoViewer
        viewer={detailPhotoViewer}
        onClose={closeDetailPhotoViewer}
        onMove={moveDetailPhotoViewer}
        onSelect={selectDetailPhotoViewer}
        onToggleZoom={() => setDetailPhotoViewer(current => current ? { ...current, isZoomed: !current.isZoomed } : current)}
      />

      {packetWizardOpen ? (
        <div className="modal-backdrop packet-wizard-backdrop" role="presentation">
          <div className="modal-panel packet-wizard-panel" role="dialog" aria-modal="true" aria-labelledby="packetWizardTitle" aria-busy={isPacketBusy}>
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
                <button className="icon-button" type="button" aria-label="Close packet wizard" disabled={isPacketBusy} onClick={closePacketWizard}>
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
                  <StatusLine status={status} />

                  {openSessions.length ? (
                    <label className={`packet-choice ${effectivePacketWizardMode === "existing" ? "active" : ""}`}>
                      <input
                        type="radio"
                        name="packetSessionMode"
                        checked={effectivePacketWizardMode === "existing"}
                        disabled={isPacketBusy}
                        onChange={() => {
                          setPacketWizardModeTouched(true);
                          setPacketWizardMode("existing");
                        }}
                      />
                      <span>
                        <strong>Use an open session</strong>
                        <small>Best when you already started the inventory.</small>
                      </span>
                      <select
                        className="input"
                        value={packetWizardFallbackSessionId}
                        disabled={effectivePacketWizardMode !== "existing" || isPacketBusy}
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

                  <label className={`packet-choice ${effectivePacketWizardMode === "new" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="packetSessionMode"
                      checked={effectivePacketWizardMode === "new"}
                      disabled={isPacketBusy}
                      onChange={() => {
                        setPacketWizardModeTouched(true);
                        setPacketWizardMode("new");
                      }}
                    />
                    <span>
                      <strong>Start a new session</strong>
                      <small>Use this when the packet begins a new inventory task.</small>
                    </span>
                    <input
                      className="input"
                      value={packetWizardSessionName}
                      disabled={effectivePacketWizardMode !== "new" || isPacketBusy}
                      placeholder="July sensitive items"
                      onChange={e => setPacketWizardSessionName(e.target.value)}
                    />
                  </label>

                  <div className="packet-wizard-actions">
                    <button className="btn btn-secondary" type="button" disabled={isPacketBusy} onClick={closePacketWizard}>
                      <span>Cancel</span>
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={isPacketBusy || isLoadingSessions || (
                        effectivePacketWizardMode === "existing"
                          ? !packetWizardFallbackSessionId
                          : !packetWizardSessionName.trim()
                      )}
                      onClick={preparePacketWizardSession}
                    >
                      <span>{packetAction === "prepare"
                        ? effectivePacketWizardMode === "new" ? "Starting session..." : "Opening session..."
                        : isLoadingSessions ? "Loading sessions..." : "Choose source"}</span>
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
                  <StatusLine status={status} />

                  <div className="packet-source-grid">
                    <button
                      className="packet-source-card"
                      type="button"
                      disabled={isPacketBusy}
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
                      disabled={isPacketBusy}
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
                    disabled={isPacketBusy}
                    placeholder="Paste hand-receipt text or one item per line. Example:&#10;000009148 R20684 RADIAC SET: AN/VDR-2&#10;B67839 BINOCULAR: M24"
                    onChange={e => {
                      setPacketRows(e.target.value);
                      setPacketDraftRows([]);
                      setPacketSourceName("");
                      setPacketSourceFile(null);
                    }}
                  />

                  <div className="packet-wizard-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={isPacketBusy}
                      onClick={() => {
                        setStatus({ text: "", isError: false });
                        setPacketWizardStep(1);
                      }}
                    >
                      <span>Back</span>
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={!packetRows.trim() || isPacketBusy}
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
                  <StatusLine status={status} />

                  {packetParseSummary ? (
                    <div className="packet-review-summary" aria-label="Packet parser summary">
                      <div>
                        <span>Source</span>
                        <strong>{packetParseSummary.sourceType}</strong>
                        <small>{packetParseSummary.sourceName}</small>
                      </div>
                      <div>
                        <span>Rows ready</span>
                        <strong>{packetRowsReadyCount}</strong>
                        <small>will import</small>
                      </div>
                      <div>
                        <span>Needs review</span>
                        <strong>{lowConfidencePacketRowCount}</strong>
                        <small>low confidence</small>
                      </div>
                      <div>
                        <span>Ignored</span>
                        <strong>{packetParseSummary.ignoredCount || 0}</strong>
                        <small>headers, notes, or duplicates</small>
                      </div>
                    </div>
                  ) : null}

                  {packetIgnoredPreview.length ? (
                    <details className="packet-review-ignored">
                      <summary>
                        <span>Ignored text</span>
                        <strong>{packetIgnoredPreview.length}{packetParseSummary?.ignoredCount > packetIgnoredPreview.length ? "+" : ""} lines</strong>
                      </summary>
                      <div className="packet-review-ignored-list">
                        {packetIgnoredPreview.map((line, index) => (
                          <div className="packet-review-ignored-row" key={`${line.text}-${index}`}>
                            <span>{line.reason}</span>
                            <p>{line.text}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {packetDraftRows.length ? (
                    <div className="packet-review">
                      <div className="packet-review-heading">
                        <strong>{packetRowsReadyCount} ready to import</strong>
                        <span>
                          {packetDraftRows.length} rows found
                          {lowConfidencePacketRowCount ? ` - ${lowConfidencePacketRowCount} need closer review` : ""}
                        </span>
                      </div>
                      {lowConfidencePacketRowCount ? (
                        <div className="packet-review-warning">
                          <AlertCircle aria-hidden="true" />
                          <span>Check low-confidence rows before importing. Remove anything that came from headers, notes, or page text.</span>
                        </div>
                      ) : null}
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
                                disabled={isPacketBusy}
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
                              disabled={isPacketBusy}
                              onChange={e => updatePacketDraftRow(row.id, "packetLine", e.target.value)}
                            />
                            <div className="packet-review-fields">
                              <label>
                                <span className="field-label">Qty</span>
                                <input
                                  className="input"
                                  inputMode="numeric"
                                  value={row.expectedQty}
                                  disabled={isPacketBusy}
                                  onChange={e => updatePacketDraftRow(row.id, "expectedQty", e.target.value)}
                                />
                              </label>
                              <label>
                                <span className="field-label">Location hint</span>
                                <input
                                  className="input"
                                  value={row.locationHint}
                                  disabled={isPacketBusy}
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
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={isPacketBusy}
                      onClick={() => {
                        setStatus({ text: "", isError: false });
                        setPacketWizardStep(2);
                      }}
                    >
                      <span>Back</span>
                    </button>
                    <button className="btn btn-secondary" type="button" disabled={isPacketBusy} onClick={() => clearPacketImport({ clearStatus: true })}>
                      <Trash2 aria-hidden="true" />
                      <span>Clear</span>
                    </button>
                    <button className="btn btn-primary" type="button" disabled={isPacketBusy || packetRowsReadyCount === 0} onClick={finishPacketWizardImport}>
                      <ClipboardPlus aria-hidden="true" />
                      <span>{packetAction === "import" ? "Importing..." : `Import ${packetRowsReadyCount} ${packetRowsReadyCount === 1 ? "row" : "rows"}`}</span>
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
                    {packetWizardSummary?.possibleMatchCount ? (
                      <p>{packetWizardSummary.possibleMatchCount} possible previous {packetWizardSummary.possibleMatchCount === 1 ? "record is" : "records are"} ready for leader review.</p>
                    ) : null}
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
                    <button className="btn btn-primary" type="button" onClick={packetWizardSummary?.possibleMatchCount ? openFirstPossibleMatch : closePacketWizard}>
                      {packetWizardSummary?.possibleMatchCount ? <History aria-hidden="true" /> : <ListChecks aria-hidden="true" />}
                      <span>{packetWizardSummary?.possibleMatchCount ? "Review matches" : "Open session"}</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {closeSessionTarget ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="closeSessionTitle">
            <div className="modal-stack">
              <div className="modal-heading">
                <span className="modal-icon">
                  <CheckCircle2 aria-hidden="true" />
                </span>
                <div>
                  <p className="eyebrow">Closeout</p>
                  <h2 className="modal-title" id="closeSessionTitle">Close this session?</h2>
                  <p className="modal-copy">
                    This moves {closeSessionTarget.name} out of the active work list. You can reopen it later from the closed archive.
                  </p>
                </div>
              </div>
              <div className="close-session-summary">
                <span>
                  <strong>{closeSessionTarget.itemCount || 0}</strong>
                  packet rows
                </span>
                <span>
                  <strong>{closeSessionTarget.foundCount || 0}</strong>
                  found
                </span>
                <span>
                  <strong>{closeSessionTarget.needsReviewCount || 0}</strong>
                  needs review
                </span>
              </div>
              <StatusLine status={status} />
              <div className="button-row start-inventory-actions">
                <button className="btn btn-primary" type="button" onClick={confirmCloseSession} disabled={isSaving || Boolean(closeSessionAction)}>
                  <CheckCircle2 aria-hidden="true" />
                  <span>{closeSessionAction === "closed" ? "Closing..." : "Close session"}</span>
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeCloseSessionDialog} disabled={isSaving || Boolean(closeSessionAction)}>
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteSessionTarget ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="deleteSessionTitle">
            <div className="modal-stack">
              <div className="modal-heading">
                <span className="modal-icon danger">
                  <Trash2 aria-hidden="true" />
                </span>
                <div>
                  <p className="eyebrow">Empty session</p>
                  <h2 className="modal-title" id="deleteSessionTitle">Delete draft session?</h2>
                  <p className="modal-copy">
                    This removes the empty session named {deleteSessionTarget.name}. Sessions with packet rows use the closeout flow instead.
                  </p>
                </div>
              </div>
              <div className="button-row start-inventory-actions">
                <button className="btn btn-danger" type="button" onClick={deleteEmptySession} disabled={isDeletingSession}>
                  <Trash2 aria-hidden="true" />
                  <span>{isDeletingSession ? "Deleting..." : "Delete session"}</span>
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeDeleteSessionDialog} disabled={isDeletingSession}>
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!packetWizardOpen ? <StatusLine status={status} /> : null}
    </section>
  );
}

function ProofPhotoStrip({ photos = [], onOpen, compact = false, label = "Submitted proof photos" }) {
  if (!photos.length) return null;

  return (
    <div className={`proof-photo-strip ${compact ? "compact" : ""}`} aria-label={label}>
      {photos.map((photo, index) => (
        <button
          className="proof-photo-thumbnail"
          type="button"
          key={photo.id || photo.storageKey}
          aria-label={`View ${proofPhotoAlt(photo)}`}
          aria-haspopup="dialog"
          onClick={() => onOpen(index)}
        >
          <img src={photo.url} alt="" loading="lazy" />
          <span className="proof-photo-thumbnail-copy">
            <strong>{proofPhotoLabel(photo)}</strong>
            {photo.caption ? <small>{photo.caption}</small> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function ProofPhotoViewer({ viewer, onClose, onMove, onSelect, onToggleZoom }) {
  if (!viewer?.photos?.length) return null;

  const photo = viewer.photos[viewer.index] || viewer.photos[0];
  const photoCount = viewer.photos.length;
  const position = Math.min(viewer.index + 1, photoCount);

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowLeft" && photoCount > 1) {
      event.preventDefault();
      onMove(-1);
    } else if (event.key === "ArrowRight" && photoCount > 1) {
      event.preventDefault();
      onMove(1);
    } else if (event.key === "Tab") {
      const focusable = [...event.currentTarget.querySelectorAll(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div
      className="proof-viewer-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="proof-viewer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proofViewerTitle"
        aria-describedby="proofViewerContext"
        onKeyDown={handleKeyDown}
      >
        <header className="proof-viewer-heading">
          <div>
            <p className="eyebrow">{viewer.sessionName || "Submitted evidence"}</p>
            <h2 id="proofViewerTitle">Evidence photo</h2>
            <p id="proofViewerContext">{viewer.packetLine || "Inventory proof"}</p>
          </div>
          <button className="proof-viewer-icon-button" type="button" aria-label="Close evidence viewer" onClick={onClose} autoFocus>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="proof-viewer-content">
          <div className="proof-viewer-stage">
            <div className={`proof-viewer-image-scroll ${viewer.isZoomed ? "zoomed" : ""}`}>
              <img src={photo.url} alt={`${proofPhotoAlt(photo)} for ${viewer.packetLine || "inventory proof"}`} />
            </div>
            <span className="proof-viewer-count" aria-live="polite">{position} of {photoCount}</span>
            {photoCount > 1 ? (
              <>
                <button className="proof-viewer-nav previous" type="button" aria-label="Previous photo" onClick={() => onMove(-1)}>
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button className="proof-viewer-nav next" type="button" aria-label="Next photo" onClick={() => onMove(1)}>
                  <ChevronRight aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>

          <aside className="proof-viewer-details">
            <div className="proof-viewer-photo-heading">
              <span>{proofPhotoLabel(photo)}</span>
              <strong>{photo.caption || proofPhotoLabel(photo)}</strong>
            </div>

            <dl className="proof-viewer-facts">
              <div>
                <dt>Submitted by</dt>
                <dd>{viewer.submittedBy || "Unknown"}</dd>
              </div>
              {viewer.createdAt ? (
                <div>
                  <dt>Submitted</dt>
                  <dd>{formatDate(viewer.createdAt)}</dd>
                </div>
              ) : null}
              {viewer.locationText ? (
                <div>
                  <dt>Location</dt>
                  <dd>{viewer.locationText}</dd>
                </div>
              ) : null}
              {viewer.serialNumber ? (
                <div>
                  <dt>Serial</dt>
                  <dd>{viewer.serialNumber}</dd>
                </div>
              ) : null}
            </dl>

            {viewer.note ? (
              <div className="proof-viewer-note">
                <strong>Submitter note</strong>
                <p>{viewer.note}</p>
              </div>
            ) : null}

            {viewer.requestedProof ? (
              <div className="proof-viewer-request">
                <strong>Requested proof</strong>
                <p>{viewer.requestedProof}</p>
              </div>
            ) : null}

            <div className="proof-viewer-tools">
              <button className="btn btn-secondary btn-small" type="button" aria-pressed={viewer.isZoomed} onClick={onToggleZoom}>
                {viewer.isZoomed ? <ZoomOut aria-hidden="true" /> : <ZoomIn aria-hidden="true" />}
                <span>{viewer.isZoomed ? "Fit photo" : "Zoom photo"}</span>
              </button>
              <a className="btn btn-secondary btn-small" href={photo.url} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                <span>Open original</span>
              </a>
            </div>
          </aside>
        </div>

        {photoCount > 1 ? (
          <div className="proof-viewer-thumbnails" aria-label="All evidence photos">
            {viewer.photos.map((item, index) => (
              <button
                className={index === viewer.index ? "active" : ""}
                type="button"
                key={item.id || item.storageKey}
                aria-label={`Show ${proofPhotoAlt(item)}`}
                aria-current={index === viewer.index ? "true" : undefined}
                onClick={() => onSelect(index)}
              >
                <img src={item.url} alt="" loading="lazy" />
                <span>{proofPhotoLabel(item)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function savedEvidenceChoices(submission) {
  const saved = getInventoryItemPhotos(submission?.sessionItem?.inventoryItem)
    .filter(photo => photo.mediaUploadId)
    .map(photo => ({ ...photo, source: "saved", sourceLabel: "Saved" }));
  const current = (submission?.photos || [])
    .filter(photo => photo.mediaUploadId)
    .map(photo => ({ ...photo, source: "submission", sourceLabel: "New" }));
  const choices = [];
  const seen = new Set();
  [...saved, ...current].forEach(photo => {
    if (seen.has(photo.mediaUploadId)) return;
    seen.add(photo.mediaUploadId);
    choices.push(photo);
  });
  return choices;
}

function defaultSavedEvidenceIds(submission) {
  const choices = savedEvidenceChoices(submission);
  const saved = choices.filter(photo => photo.source === "saved");
  const current = choices.filter(photo => photo.source === "submission");
  return [...saved, ...current].slice(0, 3).map(photo => photo.mediaUploadId);
}

function SavedEvidencePicker({
  submission,
  enabled = false,
  selectedIds = [],
  onEnabledChange,
  onToggle
}) {
  const choices = savedEvidenceChoices(submission);
  const savedCount = choices.filter(photo => photo.source === "saved" && selectedIds.includes(photo.mediaUploadId)).length;
  const newCount = choices.filter(photo => photo.source === "submission" && selectedIds.includes(photo.mediaUploadId)).length;

  return (
    <details className="saved-evidence-picker">
      <summary>
        <span>
          <small>After approval</small>
          <strong>Save for next inventory</strong>
        </span>
        <span className="saved-evidence-count">{enabled ? `${selectedIds.length}/3 photos` : "Optional"}</span>
      </summary>
      <div className="saved-evidence-picker-body">
        <label className="saved-evidence-enable">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => onEnabledChange(event.target.checked)}
          />
          <span>
            <strong>Save or update this item</strong>
            <small>Carry the approved location, serial, and selected photos into the next inventory.</small>
          </span>
        </label>
        {enabled ? (
          <>
            <p>Pick up to three photos to keep with the saved record.</p>
            {choices.length ? (
              <div className="saved-evidence-options" role="group" aria-label="Photos saved for next inventory">
                {choices.map((photo, index) => {
                  const selected = selectedIds.includes(photo.mediaUploadId);
                  return (
                    <label className={`saved-evidence-option ${selected ? "selected" : ""}`} key={photo.mediaUploadId}>
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`${selected ? "Remove" : "Save"} ${photo.sourceLabel.toLowerCase()} photo ${index + 1}`}
                        onChange={() => onToggle(photo.mediaUploadId)}
                      />
                      <img src={photo.url} alt="" loading="lazy" />
                      <span>{photo.sourceLabel}</span>
                      {selected ? <CheckCircle2 aria-hidden="true" /> : null}
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="saved-evidence-empty">No photos are available to save. Location and serial can still be carried forward.</p>
            )}
            <small>{savedCount ? `${savedCount} saved` : "No old photos"}{newCount ? ` · ${newCount} new` : ""}</small>
          </>
        ) : (
          <p>Leave this off to approve the proof without changing the saved item record.</p>
        )}
      </div>
    </details>
  );
}

function ReviewPanel({ token, tenantSlug, query = "", onQueryChange, onClearSearch, onOpenSessions }) {
  const [submissions, setSubmissions] = useState([]);
  const [status, setStatus] = useState({ text: "Loading review queue...", isError: false });
  const [requestingSubmissionId, setRequestingSubmissionId] = useState("");
  const [proofRequestMessage, setProofRequestMessage] = useState("");
  const [proofRequestFields, setProofRequestFields] = useState(["serial_photo", "wide_photo"]);
  const [isRequestingProof, setIsRequestingProof] = useState(false);
  const [reviewingSubmissionId, setReviewingSubmissionId] = useState("");
  const [matchActionId, setMatchActionId] = useState("");
  const [savedEvidenceBySubmission, setSavedEvidenceBySubmission] = useState({});
  const [saveItemBySubmission, setSaveItemBySubmission] = useState({});
  const [photoViewer, setPhotoViewer] = useState(null);
  const photoViewerTriggerRef = useRef(null);
  const hasSearchQuery = searchTerms(query).length > 0;
  const visibleSubmissions = submissions.filter(submission => matchesSearch([
    submission.sessionItem?.packetLine,
    submission.session?.name,
    submission.submittedByName,
    submission.submittedByEmail,
    submission.status,
    submission.reviewState,
    submission.locationText,
    submission.serialNumber,
    submission.note,
    submission.reviewNote,
    submission.sessionItem?.inventoryItem?.title,
    submission.sessionItem?.inventoryItem?.commonName,
    submission.sessionItem?.inventoryItem?.lin,
    submission.sessionItem?.inventoryItem?.nsn,
    submission.sessionItem?.inventoryItem?.currentLocation,
    submission.sessionItem?.suggestedInventoryItem?.title,
    submission.sessionItem?.suggestedInventoryItem?.commonName,
    submission.sessionItem?.suggestedInventoryItem?.lin,
    submission.sessionItem?.suggestedInventoryItem?.nsn,
    submission.sessionItem?.suggestedInventoryItem?.currentLocation,
    (submission.history || []).flatMap(historyItem => [
      historyItem.status,
      historyItem.reviewState,
      historyItem.submittedByName,
      historyItem.submittedByEmail,
      historyItem.locationText,
      historyItem.serialNumber,
      historyItem.note,
      historyItem.reviewNote
    ])
  ], query));

  async function loadQueue() {
    try {
      setStatus({ text: "Loading review queue...", isError: false });
      const data = await apiRequest("/inventory/review-queue", { token, tenantSlug });
      const nextSubmissions = data.submissions || [];
      setSubmissions(nextSubmissions);
      setSavedEvidenceBySubmission(current => {
        const next = {};
        nextSubmissions.forEach(submission => {
          const validIds = new Set(savedEvidenceChoices(submission).map(photo => photo.mediaUploadId));
          const preserved = (current[submission.id] || []).filter(id => validIds.has(id)).slice(0, 3);
          next[submission.id] = Object.prototype.hasOwnProperty.call(current, submission.id)
            ? preserved
            : defaultSavedEvidenceIds(submission);
        });
        return next;
      });
      setSaveItemBySubmission(current => {
        const next = {};
        nextSubmissions.forEach(submission => {
          next[submission.id] = Boolean(current[submission.id]);
        });
        return next;
      });
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadQueue();
  }, [tenantSlug, token]);

  useEffect(() => {
    if (!photoViewer) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [Boolean(photoViewer)]);

  async function review(submissionId, decision, note = "") {
    const submission = submissions.find(item => item.id === submissionId);
    const packetLine = submission?.sessionItem?.packetLine || "the submitted proof";
    const actionLabel = decision === "approved" ? "Approved" : "Rejected";
    if (decision === "approved" && submission?.sessionItem?.suggestedInventoryItem) {
      setStatus({ text: `Confirm whether the possible previous record is the same item before approving ${packetLine}.`, isError: true });
      return;
    }
    const canSaveItem = Boolean(
      decision === "approved"
      && submission?.status === "found"
      && (submission?.sessionItem?.expectedQty == null || Number(submission.sessionItem.expectedQty) === 1)
    );
    const shouldSaveItem = canSaveItem && Boolean(saveItemBySubmission[submissionId]);
    try {
      setReviewingSubmissionId(submissionId);
      setStatus({ text: `${actionLabel === "Approved" ? "Approving" : "Rejecting"} ${packetLine}...`, isError: false });
      await apiRequest(`/submissions/${submissionId}/review`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: {
          decision,
          note,
          saveItem: shouldSaveItem,
          savedMediaUploadIds: shouldSaveItem ? (savedEvidenceBySubmission[submissionId] || []) : undefined
        }
      });
      await loadQueue();
      setStatus({ text: `${actionLabel} proof for ${packetLine}.`, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setReviewingSubmissionId("");
    }
  }

  function toggleSavedEvidence(submissionId, mediaUploadId) {
    const selected = savedEvidenceBySubmission[submissionId] || [];
    if (!selected.includes(mediaUploadId) && selected.length >= 3) {
      setStatus({ text: "Keep up to 3 photos with the saved item.", isError: true });
      return;
    }
    setStatus({ text: "", isError: false });
    setSavedEvidenceBySubmission(current => ({
      ...current,
      [submissionId]: selected.includes(mediaUploadId)
        ? selected.filter(id => id !== mediaUploadId)
        : [...selected, mediaUploadId]
    }));
  }

  async function resolveReviewMatch(submission, action) {
    const sessionItemId = submission?.sessionItem?.id;
    if (!sessionItemId || matchActionId) return;
    try {
      setMatchActionId(submission.id);
      setStatus({ text: action === "confirm" ? "Linking the saved record..." : "Removing the suggested match...", isError: false });
      await apiRequest(`/session-items/${sessionItemId}/inventory-match`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { action }
      });
      setSavedEvidenceBySubmission(current => {
        const next = { ...current };
        delete next[submission.id];
        return next;
      });
      await loadQueue();
      setStatus({ text: action === "confirm" ? "Saved record linked. Review can continue." : "Suggestion removed. Review can continue.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMatchActionId("");
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
      const submission = submissions.find(item => item.id === requestingSubmissionId);
      const packetLine = submission?.sessionItem?.packetLine || "the submitted proof";
      setStatus({ text: `Proof request sent for ${packetLine}.`, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsRequestingProof(false);
    }
  }

  function openPhotoViewer(submission, evidence, photos, index) {
    const requestedProof = applicableProofRequest(submission.history, evidence) || submission.reviewNote || "";

    photoViewerTriggerRef.current = document.activeElement;
    setPhotoViewer({
      photos,
      index,
      isZoomed: false,
      packetLine: submission.sessionItem?.packetLine || "Inventory proof",
      sessionName: submission.session?.name || "Submitted evidence",
      submittedBy: submissionPerson(evidence),
      createdAt: evidence.createdAt,
      locationText: evidence.locationText,
      serialNumber: evidence.serialNumber,
      note: evidence.note,
      requestedProof
    });
  }

  function closePhotoViewer() {
    setPhotoViewer(null);
    window.requestAnimationFrame(() => photoViewerTriggerRef.current?.focus?.());
  }

  function movePhotoViewer(delta) {
    setPhotoViewer(current => {
      if (!current?.photos?.length) return current;
      const index = (current.index + delta + current.photos.length) % current.photos.length;
      return { ...current, index, isZoomed: false };
    });
  }

  function selectPhotoViewer(index) {
    setPhotoViewer(current => current ? { ...current, index, isZoomed: false } : current);
  }

  return (
    <section className="admin-card review-panel">
      <div className="admin-card-heading">
        <span className="admin-icon">
          <MessageSquare aria-hidden="true" />
        </span>
        <div>
          <p className="eyebrow">Platoon admin review</p>
          <h2>Review Queue</h2>
        </div>
      </div>

      <StatusLine status={status} />

      <div className="review-list" role="region" aria-label="Review queue results">
        {visibleSubmissions.length ? visibleSubmissions.map(submission => (
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

            <ProofPhotoStrip
              photos={submission.photos}
              onOpen={index => openPhotoViewer(submission, submission, submission.photos, index)}
            />

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
                        <ProofPhotoStrip
                          photos={historyItem.photos}
                          compact
                          label={`Photos submitted by ${submissionPerson(historyItem)}`}
                          onOpen={index => openPhotoViewer(submission, historyItem, historyItem.photos, index)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {submission.sessionItem?.suggestedInventoryItem ? (
              <PossiblePriorMatchCard
                item={submission.sessionItem}
                isSaving={matchActionId === submission.id}
                onConfirm={() => resolveReviewMatch(submission, "confirm")}
                onDismiss={() => resolveReviewMatch(submission, "dismiss")}
              />
            ) : null}

            {!submission.sessionItem?.suggestedInventoryItem
              && submission.status === "found"
              && (submission.sessionItem?.expectedQty == null || Number(submission.sessionItem.expectedQty) === 1) ? (
                <SavedEvidencePicker
                  submission={submission}
                  enabled={Boolean(saveItemBySubmission[submission.id])}
                  selectedIds={savedEvidenceBySubmission[submission.id] || []}
                  onEnabledChange={enabled => setSaveItemBySubmission(current => ({
                    ...current,
                    [submission.id]: enabled
                  }))}
                  onToggle={mediaUploadId => toggleSavedEvidence(submission.id, mediaUploadId)}
                />
              ) : null}

            <div className="review-actions">
              <button
                className="btn btn-primary btn-small"
                type="button"
                disabled={reviewingSubmissionId === submission.id || isRequestingProof || Boolean(matchActionId) || Boolean(submission.sessionItem?.suggestedInventoryItem)}
                onClick={() => review(submission.id, "approved")}
              >
                <CheckCircle2 aria-hidden="true" />
                <span>{reviewingSubmissionId === submission.id ? "Updating..." : submission.sessionItem?.suggestedInventoryItem ? "Check match first" : "Approve"}</span>
              </button>
              <button
                className="btn btn-secondary btn-small"
                type="button"
                disabled={reviewingSubmissionId === submission.id || isRequestingProof || Boolean(matchActionId)}
                onClick={() => openProofRequest(submission)}
              >
                <Camera aria-hidden="true" />
                <span>More proof</span>
              </button>
              <button
                className="btn btn-danger-soft btn-small"
                type="button"
                disabled={reviewingSubmissionId === submission.id || isRequestingProof || Boolean(matchActionId)}
                onClick={() => review(submission.id, "rejected")}
              >
                <XCircle aria-hidden="true" />
                <span>{reviewingSubmissionId === submission.id ? "Updating..." : "Reject"}</span>
              </button>
            </div>

            {requestingSubmissionId === submission.id ? (
              <form className="proof-request-form" onSubmit={sendProofRequest}>
                <div className="proof-request-chips" role="group" aria-label="Requested proof">
                  {proofRequestOptions.map(option => (
                    <button
                      className={proofRequestFields.includes(option.value) ? "active" : ""}
                      type="button"
                      key={option.value}
                      aria-pressed={proofRequestFields.includes(option.value)}
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
          <EmptyPanel
            title={hasSearchQuery ? "No matching review work" : "Nothing to review"}
            body={hasSearchQuery ? "Clear the search or try a packet line, session, submitter, serial, location, or proof note." : "Submitted proof will appear here."}
            action={hasSearchQuery ? (
              <button className="btn btn-secondary btn-small" type="button" onClick={() => {
                if (onClearSearch) onClearSearch();
                else onQueryChange?.("");
              }}>Clear search</button>
            ) : (
              <button className="btn btn-primary btn-small" type="button" onClick={onOpenSessions}>Open inventory sessions</button>
            )}
          />
        )}
      </div>

      <ProofPhotoViewer
        viewer={photoViewer}
        onClose={closePhotoViewer}
        onMove={movePhotoViewer}
        onSelect={selectPhotoViewer}
        onToggleZoom={() => setPhotoViewer(current => current ? { ...current, isZoomed: !current.isZoomed } : current)}
      />

    </section>
  );
}

function NewsletterPanel({ token, me, onRefresh, onLogout }) {
  const [issues, setIssues] = useState([]);
  const [contentBlocks, setContentBlocks] = useState([]);
  const [subscribers, setSubscribers] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [subscriberStats, setSubscriberStats] = useState({ pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 });
  const [deliverySettings, setDeliverySettings] = useState({ emailConfigured: false });
  const [activeSection, setActiveSection] = useState("content");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedContentBlockId, setSelectedContentBlockId] = useState("");
  const [form, setForm] = useState(() => newsletterIssueForm());
  const [contentForm, setContentForm] = useState(() => frgContentForm());
  const [testEmail, setTestEmail] = useState(() => me?.user?.email || "");
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [contentTypeFilter, setContentTypeFilter] = useState("all");
  const [subscriberQuery, setSubscriberQuery] = useState("");
  const [subscriberStatusFilter, setSubscriberStatusFilter] = useState("pending");
  const [reviewNotes, setReviewNotes] = useState({});
  const [status, setStatus] = useState({ text: "Loading newsletter...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [isDeletingContent, setIsDeletingContent] = useState(false);
  const [reviewingSubscriberId, setReviewingSubscriberId] = useState("");
  const [reviewingSubscriberDecision, setReviewingSubscriberDecision] = useState("");
  const roleLabel = me?.isPlatformAdmin ? "Super administrator" : "Newsletter admin";
  const selectedIssue = issues.find(issue => issue.id === selectedIssueId) || null;
  const selectedContentBlock = contentBlocks.find(block => block.id === selectedContentBlockId) || null;
  const filteredContentBlocks = contentBlocks.filter(block => {
    const matchesType = contentTypeFilter === "all" || block.blockType === contentTypeFilter;
    const matchesQuery = matchesSearch([
      block.title,
      block.summary,
      block.body,
      block.status,
      block.href,
      block.linkLabel,
      contentTypeLabel(block.blockType)
    ], contentQuery);
    return matchesType && matchesQuery;
  });
  const filteredIssues = issues.filter(issue => matchesSearch([
      issue.title,
      issue.editionLabel,
      issue.summary,
      issue.body,
      issue.status
    ], query));
  const filteredSubscribers = subscribers.filter(subscriber => {
    const matchesStatus = subscriberStatusFilter === "all" || subscriber.status === subscriberStatusFilter;
    const matchesQuery = matchesSearch([
      subscriber.displayName,
      subscriber.email,
      subscriber.platoon,
      subscriber.supervisorName,
      subscriber.status,
      subscriber.reviewNote
    ], subscriberQuery);
    return matchesStatus && matchesQuery;
  });
  const selectedIssueDeliveries = selectedIssueId
    ? deliveries.filter(delivery => delivery.issueId === selectedIssueId)
    : [];
  const previewLines = newsletterBodyParagraphs(form.body);

  async function loadNewsletter() {
    try {
      setStatus({ text: "Loading newsletter...", isError: false });
      const data = await apiRequest("/newsletter/admin", { token });
      const nextIssues = data.issues || [];
      const nextContentBlocks = data.contentBlocks || [];
      const nextSubscribers = data.subscribers || [];
      const nextDeliveries = data.deliveries || [];
      setIssues(nextIssues);
      setContentBlocks(nextContentBlocks);
      setSubscribers(nextSubscribers);
      setDeliveries(nextDeliveries);
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

  async function sendTestIssue() {
    if (!selectedIssueId) {
      setStatus({ text: "Save the issue before sending a test.", isError: true });
      return;
    }

    const email = testEmail.trim();
    if (!email) {
      setStatus({ text: "Enter a test email address.", isError: true });
      return;
    }

    setIsSendingTest(true);
    try {
      const data = await apiRequest(`/newsletter/admin/issues/${selectedIssueId}/test-send`, {
        method: "POST",
        token,
        body: { email }
      });
      const result = data.testSend || {};
      setStatus({
        text: result.sent
          ? `Test email sent to ${data.email || email}.`
          : `Test email was not sent: ${result.reason || result.error || "delivery unavailable"}.`,
        isError: !result.sent && result.reason !== "smtp_not_configured"
      });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSendingTest(false);
    }
  }

  function exportSubscribers() {
    const rows = [
      [
        "Email",
        "Name",
        "Platoon",
        "Immediate Supervisor",
        "Status",
        "Approved/Requested",
        "Updated",
        "Emails Sent",
        "Failed",
        "Skipped",
        "Last Delivery",
        "Last Issue",
        "Last Error"
      ],
      ...subscribers.map(subscriber => [
        subscriber.email,
        subscriber.displayName || "",
        subscriber.platoon || "",
        subscriber.supervisorName || "",
        subscriber.status,
        formatShortDate(subscriber.lastSubscribedAt || subscriber.createdAt),
        formatDate(subscriber.updatedAt),
        subscriber.sentCount || 0,
        subscriber.failedCount || 0,
        subscriber.skippedCount || 0,
        subscriber.lastDeliveryAt ? `${deliveryStatusLabel(subscriber.lastDeliveryStatus)} - ${formatDate(subscriber.lastDeliveryAt)}` : "",
        subscriber.lastDeliveryIssueTitle || "",
        subscriber.lastDeliveryError || ""
      ])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    downloadTextFile(`newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  }

  function exportDeliveries() {
    const rows = [
      ["Issue", "Email", "Subscriber", "Subscriber Status", "Delivery Status", "Error", "Sent At", "Recorded At"],
      ...deliveries.map(delivery => [
        delivery.issueTitle || "",
        delivery.email || "",
        delivery.subscriberName || "",
        delivery.subscriberStatus || "",
        deliveryStatusLabel(delivery.status),
        delivery.error || "",
        delivery.sentAt ? formatDate(delivery.sentAt) : "",
        delivery.createdAt ? formatDate(delivery.createdAt) : ""
      ])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    downloadTextFile(`newsletter-deliveries-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  }

  function exportSelectedIssueDeliveries() {
    if (!selectedIssue) return;
    const rows = [
      ["Issue", "Email", "Subscriber", "Subscriber Status", "Delivery Status", "Error", "Sent At", "Recorded At"],
      ...selectedIssueDeliveries.map(delivery => [
        delivery.issueTitle || selectedIssue.title || "",
        delivery.email || "",
        delivery.subscriberName || "",
        delivery.subscriberStatus || "",
        deliveryStatusLabel(delivery.status),
        delivery.error || "",
        delivery.sentAt ? formatDate(delivery.sentAt) : "",
        delivery.createdAt ? formatDate(delivery.createdAt) : ""
      ])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
    downloadTextFile(`newsletter-${safeFileNamePart(selectedIssue.title)}-deliveries.csv`, csv, "text/csv");
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
  const isEmailConfigured = Boolean(deliverySettings.emailConfigured);
  const subscriberEmptyTitle = subscribers.length
    ? subscriberStatusFilter === "pending"
      ? "No pending requests"
      : "No matching subscribers"
    : "No subscribers yet";
  const subscriberEmptyBody = subscribers.length
    ? subscriberStatusFilter === "pending"
      ? "New public newsletter requests will appear here first."
      : "Adjust the search or status filter."
    : "Public newsletter signups will appear here.";

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
              {activeSection !== "content" ? (
                <span className={`newsletter-delivery-status ${isEmailConfigured ? "ready" : "offline"}`} title={isEmailConfigured ? "Newsletter email delivery is configured." : "Newsletter email delivery is not configured in this environment."}>
                  <MailPlus aria-hidden="true" />
                  <span>{isEmailConfigured ? "Email ready" : "Email offline"}</span>
                </span>
              ) : null}
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
                <>
                  <button className="btn btn-secondary" type="button" onClick={exportDeliveries} disabled={!deliveries.length}>
                    <Download aria-hidden="true" />
                    <span>Export deliveries</span>
                  </button>
                  <button className="btn btn-primary" type="button" onClick={startNewDraft}>
                    <Plus aria-hidden="true" />
                    <span>New issue</span>
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <StatusLine status={status} />

          {activeSection === "issues" && !isEmailConfigured ? (
            <div className="newsletter-delivery-note newsletter-delivery-note-inline" role="note">
              <MailPlus aria-hidden="true" />
              <span>Email delivery is not configured in this environment. You can still write, test the layout, and save issues; live sending will be skipped.</span>
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
                  <div className="platform-search" role="search">
                    <Search aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="Search public content"
                      value={contentQuery}
                      placeholder="Search public content..."
                      onChange={event => setContentQuery(event.target.value)}
                    />
                    {contentQuery ? <button type="button" aria-label="Clear search" onClick={() => setContentQuery("")}><X aria-hidden="true" /></button> : null}
                  </div>
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
                <div className="platform-search" role="search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search newsletter issues"
                    value={query}
                    placeholder="Search issues..."
                    onChange={event => setQuery(event.target.value)}
                  />
                  {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X aria-hidden="true" /></button> : null}
                </div>
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

                  <div className="newsletter-test-send">
                    <label className="field-label" htmlFor="newsletterTestEmail">Send test</label>
                    <div className="newsletter-test-send-row">
                      <input
                        id="newsletterTestEmail"
                        className="input"
                        type="email"
                        value={testEmail}
                        placeholder="name@example.com"
                        onChange={event => setTestEmail(event.target.value)}
                      />
                      <button className="btn btn-secondary" type="button" onClick={sendTestIssue} disabled={!selectedIssueId || isSendingTest}>
                        <MailPlus aria-hidden="true" />
                        <span>{isSendingTest ? "Sending..." : "Send test"}</span>
                      </button>
                    </div>
                    <small>Send one proof email before publishing. This does not publish the issue or add delivery records.</small>
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
                  <div className="newsletter-delivery-log">
                    <div className="newsletter-delivery-log-heading">
                      <div>
                        <strong>Delivery records</strong>
                        <span>{selectedIssueDeliveries.length ? countLabel(selectedIssueDeliveries.length, "recipient") : "No delivery records yet"}</span>
                      </div>
                      <button
                        className="btn btn-secondary btn-small"
                        type="button"
                        onClick={exportSelectedIssueDeliveries}
                        disabled={!selectedIssueDeliveries.length}
                      >
                        <Download aria-hidden="true" />
                        <span>Export</span>
                      </button>
                    </div>
                    {selectedIssueDeliveries.length ? (
                      <div className="newsletter-delivery-list">
                        {selectedIssueDeliveries.map(delivery => (
                          <div className="newsletter-delivery-row" key={delivery.id}>
                            <div>
                              <strong>{delivery.subscriberName || delivery.email}</strong>
                              <span>{delivery.email}</span>
                              {delivery.error ? <small>{delivery.error}</small> : null}
                            </div>
                            <div className="newsletter-delivery-row-meta">
                              <span className={`status-pill ${delivery.status}`}>{deliveryStatusLabel(delivery.status)}</span>
                              <small>{delivery.sentAt ? formatDate(delivery.sentAt) : formatDate(delivery.createdAt)}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted-copy">Publish the issue to create delivery records for approved subscribers.</p>
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
                <p>{subscriberStatusFilter === "pending" ? "Review new requests first. Approved and rejected subscribers stay available in the filter." : `${countLabel(filteredSubscribers.length, "subscriber")} shown from ${countLabel(subscribers.length, "request")}.`}</p>
              </div>
              <button className="btn btn-secondary btn-small" type="button" onClick={exportSubscribers} disabled={!subscribers.length}>
                <Download aria-hidden="true" />
                <span>Export CSV</span>
              </button>
            </div>

            <div className="newsletter-subscriber-toolbar">
              <div className="platform-search" role="search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search subscribers"
                  value={subscriberQuery}
                  placeholder="Search subscribers..."
                  onChange={event => setSubscriberQuery(event.target.value)}
                />
                {subscriberQuery ? <button type="button" aria-label="Clear search" onClick={() => setSubscriberQuery("")}><X aria-hidden="true" /></button> : null}
              </div>
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
                  const details = [
                    subscriber.reviewNote ? ["Review note", subscriber.reviewNote] : null,
                    subscriber.reviewedAt ? ["Reviewed", formatDate(subscriber.reviewedAt)] : null,
                    subscriber.lastDeliveryAt ? [
                      "Last delivery",
                      `${deliveryStatusLabel(subscriber.lastDeliveryStatus)}${subscriber.lastDeliveryIssueTitle ? ` for ${subscriber.lastDeliveryIssueTitle}` : ""} on ${formatDate(subscriber.lastDeliveryAt)}`
                    ] : null,
                    subscriber.lastDeliveryError ? ["Delivery note", subscriber.lastDeliveryError] : null
                  ].filter(Boolean);

                  return (
                  <article className="admin-list-row" key={subscriber.id}>
                    <div className="newsletter-subscriber-main">
                      <strong>{subscriber.displayName || subscriber.email}</strong>
                      <span>{subscriber.email}</span>
                      <span>{subscriber.platoon || "No connection provided"}</span>
                      <span>Unit contact: {subscriber.supervisorName || "Not provided"}</span>
                      {details.length ? (
                        <details className="newsletter-subscriber-details">
                          <summary>Details</summary>
                          <dl>
                            {details.map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
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
                title={subscriberEmptyTitle}
                body={subscriberEmptyBody}
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
  const isMobileViewport = useMediaQuery("(max-width: 860px)");
  const [tenants, setTenants] = useState([]);
  const [form, setForm] = useState({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeView, setActiveView] = useState("dashboard");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [status, setStatus] = useState({ text: "Loading platoons...", isError: false });
  const [isSaving, setIsSaving] = useState(false);
  const [platformProvisioningAvailable, setPlatformProvisioningAvailable] = useState(false);
  const userMenuRef = useRef(null);
  const mobileNavToggleRef = useRef(null);
  const mobileNavCloseRef = useRef(null);
  const platformUserName = me?.user?.display_name || me?.user?.email || "Admin user";
  const platformUserEmail = me?.user?.email || me?.identity?.email || "";
  const platformUserInitial = String(platformUserName || "A").slice(0, 1).toUpperCase();
  const totalMembers = tenants.reduce((sum, tenant) => sum + Number(tenant.memberCount || 0), 0);
  const totalAdmins = tenants.reduce((sum, tenant) => sum + Number(tenant.adminCount || 0), 0);
  const activeTenants = tenants.filter(tenant => tenant.status === "active");
  const recentlyCreatedTenants = [...tenants]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, isMobileViewport ? 2 : 4);
  const searchMatchedTenants = tenants.filter(tenant => {
    const matchesQuery = matchesSearch([
      tenant.name,
      tenant.slug,
      tenant.status,
      tenantHost(tenant),
      "876en-platoon-admin"
    ], query);
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
    ["Last request ID", readLastApiRequestId() || "none recorded"],
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
      const accountSetupAvailable = data.provisioningAvailable === true;
      setPlatformProvisioningAvailable(accountSetupAvailable);
      if (!accountSetupAvailable) {
        setForm(current => ({ ...current, adminEmail: "", adminDisplayName: "" }));
      }
      setStatus({ text: "", isError: false });
    } catch (error) {
      setPlatformProvisioningAvailable(false);
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadTenants();
  }, [token]);

  useEffect(() => {
    function handlePointerDown(event) {
      if (isUserMenuOpen && !userMenuRef.current?.contains(event.target)) {
        setIsUserMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsUserMenuOpen(false);
        if (isMobileNavOpen) closePlatformNav();
      }
    }

    if (isUserMenuOpen) document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isUserMenuOpen, isMobileNavOpen, isMobileViewport]);

  async function refreshPlatform() {
    await loadTenants();
    onRefresh?.();
  }

  function selectPlatformView(view) {
    setActiveView(view);
    closePlatformNav(false);
  }

  function openPlatformNav() {
    setIsMobileNavOpen(true);
    window.requestAnimationFrame(() => mobileNavCloseRef.current?.focus());
  }

  function closePlatformNav(restoreFocus = true) {
    setIsMobileNavOpen(false);
    if (restoreFocus && isMobileViewport) {
      window.requestAnimationFrame(() => mobileNavToggleRef.current?.focus());
    }
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
        adminEmail: platformProvisioningAvailable ? form.adminEmail.trim() || undefined : undefined,
        adminDisplayName: platformProvisioningAvailable ? form.adminDisplayName.trim() || undefined : undefined
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

  function openAppLauncher() {
    window.location.assign(appLauncherUrl);
  }

  function openSupportDetails() {
    setActiveView("support");
    setIsUserMenuOpen(false);
  }

  async function copyDiagnosticsFromMenu() {
    await copyDiagnostics();
    setIsUserMenuOpen(false);
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
          {!compact ? <span>Subdomain</span> : null}
          {!compact ? <span>Admins</span> : null}
          {!compact ? <span>Members</span> : null}
          <span>Status</span>
          {!compact ? <span>Created</span> : null}
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
              {!compact ? <span className="platform-domain" data-label="Subdomain"><span className="mobile-field-label">Subdomain</span><span>{host}</span></span> : null}
              {!compact ? <span className="platform-table-number" data-label="Admins"><span className="mobile-field-label">Admins</span><span>{tenant.adminCount || 0}</span></span> : null}
              {!compact ? <span className="platform-table-number" data-label="Members"><span className="mobile-field-label">Members</span><span>{tenant.memberCount || 0}</span></span> : null}
              <span className="platform-status-field" data-label="Status"><span className="mobile-field-label">Status</span><span className={`status-pill ${tenant.status}`}>{tenant.status}</span></span>
              {!compact ? <span className="platform-table-date" data-label="Created"><span className="mobile-field-label">Created</span><span>{formatShortDate(tenant.createdAt)}</span></span> : null}
              <div className="platform-actions" data-label="Actions">
                <span className="mobile-field-label">Actions</span>
                <a className="btn btn-secondary btn-small platform-open-link" href={tenantWorkspaceHref(tenant)} aria-label={`Open ${host} workspace`}>
                  <span>Open workspace</span>
                </a>
                <button className="btn btn-secondary btn-small platform-copy-link desktop-secondary-action" type="button" onClick={() => copyTenantLink(tenant)}>
                  <Copy aria-hidden="true" />
                  <span>Copy link</span>
                </button>
                <ResponsiveActionMenu label="More" ariaLabel={`More actions for ${tenantDisplayName(tenant)}`} className="mobile-secondary-actions platform-row-action-menu">
                  <button type="button" onClick={() => copyTenantLink(tenant)}>
                    <Copy aria-hidden="true" />
                    <span>Copy link</span>
                  </button>
                </ResponsiveActionMenu>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`platform-shell ${isMobileNavOpen ? "platform-nav-open" : ""}`}>
      <button className="platform-sidebar-backdrop" type="button" aria-label="Close platform menu" onClick={() => closePlatformNav()} />
      <aside className="platform-sidebar" aria-hidden={isMobileViewport && !isMobileNavOpen ? "true" : undefined} inert={isMobileViewport && !isMobileNavOpen ? true : undefined}>
        <div className="platform-brand">
          <ShieldCheck aria-hidden="true" />
          <strong>{APP_NAME}</strong>
          <button ref={mobileNavCloseRef} className="platform-mobile-nav-close" type="button" aria-label="Close platform menu" onClick={() => closePlatformNav()}>
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="platform-nav" aria-label="Platform admin">
          {platformNavItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                className={activeView === item.id ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => selectPlatformView(item.id)}
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
          <button
            ref={mobileNavToggleRef}
            className="platform-mobile-nav-toggle"
            type="button"
            aria-label="Open platform menu"
            aria-expanded={isMobileNavOpen}
            onClick={openPlatformNav}
          >
            <Menu aria-hidden="true" />
          </button>
          <strong className="platform-mobile-title">{APP_NAME}</strong>
          <div className="leader-user-actions">
            <button className="icon-button platform-topbar-refresh" type="button" onClick={refreshPlatform} aria-label="Refresh">
              <RefreshCw aria-hidden="true" />
            </button>
            <div className="leader-popover-anchor platform-user-menu" ref={userMenuRef}>
              <button
                className="leader-user-card leader-user-trigger"
                type="button"
                aria-label="Open account actions"
                aria-expanded={isUserMenuOpen}
                onClick={() => setIsUserMenuOpen(current => !current)}
              >
                <span className="leader-avatar">{platformUserInitial}</span>
                <div>
                  <strong>{platformUserName}</strong>
                  <span>Super administrator</span>
                </div>
                <ChevronDown aria-hidden="true" />
              </button>
              {isUserMenuOpen ? (
                <section className="leader-popover leader-user-menu platform-user-dropdown" aria-label="Account menu">
                  <div className="leader-profile-summary">
                    <span className="leader-avatar">{platformUserInitial}</span>
                    <div>
                      <span>Profile</span>
                      <strong>{platformUserName}</strong>
                      {platformUserEmail ? <small>{platformUserEmail}</small> : null}
                    </div>
                  </div>
                  <div className="leader-menu-actions">
                    <button type="button" onClick={() => {
                      refreshPlatform();
                      setIsUserMenuOpen(false);
                    }}>
                      <RefreshCw aria-hidden="true" />
                      <span>Refresh platform</span>
                    </button>
                    <button type="button" onClick={openAppLauncher}>
                      <LogIn aria-hidden="true" />
                      <span>App portal</span>
                    </button>
                    <button type="button" onClick={openSupportDetails}>
                      <RefreshCw aria-hidden="true" />
                      <span>Diagnostics</span>
                    </button>
                    <button type="button" onClick={copyDiagnosticsFromMenu}>
                      <Copy aria-hidden="true" />
                      <span>Copy diagnostics</span>
                    </button>
                    <button type="button" onClick={onLogout}>
                      <LogOut aria-hidden="true" />
                      <span>Sign out</span>
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
            <button className="btn btn-secondary btn-small platform-topbar-signout" type="button" onClick={onLogout}>
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
                <button className="btn btn-secondary desktop-secondary-action" type="button" onClick={openNewsletter}>
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
              {activeView === "dashboard" ? (
                <ResponsiveActionMenu className="mobile-secondary-actions">
                  <button type="button" onClick={openNewsletter}>
                    <MailPlus aria-hidden="true" />
                    <span>Newsletter</span>
                  </button>
                </ResponsiveActionMenu>
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
              </div>
            </>
          ) : null}

          {activeView === "platoons" ? (
            <>
              {renderStats()}
              <section className="platform-table-card">
                <div className="platform-table-toolbar">
                  <div className="platform-search" role="search">
                    <Search aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="Search platoons"
                      value={query}
                      placeholder="Search platoons by name or subdomain..."
                      onChange={event => setQuery(event.target.value)}
                    />
                    {query ? (
                      <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X aria-hidden="true" /></button>
                    ) : null}
                  </div>
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
                <div className="platform-search" role="search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search workspace access"
                    value={query}
                    placeholder="Search access by platoon or subdomain..."
                    onChange={event => setQuery(event.target.value)}
                  />
                  {query ? (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X aria-hidden="true" /></button>
                  ) : null}
                </div>
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
                    <span className="platform-domain" data-label="Admin group"><span className="mobile-field-label">Admin group</span><span>876en-platoon-admin</span></span>
                    <span className="platform-table-number" data-label="Members"><span className="mobile-field-label">Members</span><span>{tenant.memberCount || 0}</span></span>
                    <span className="platform-table-number" data-label="Admins"><span className="mobile-field-label">Admins</span><span>{tenant.adminCount || 0}</span></span>
                    <span className="platform-status-field" data-label="Status"><span className="mobile-field-label">Status</span><span className={`status-pill ${tenant.status}`}>{tenant.status}</span></span>
                    <div className="platform-actions" data-label="Actions">
                      <span className="mobile-field-label">Actions</span>
                      <a className="btn btn-secondary btn-small platform-open-link" href={tenantWorkspaceHref(tenant)} aria-label={`Open ${tenantHost(tenant)} workspace`}>
                        <span>Open workspace</span>
                      </a>
                      <button className="btn btn-secondary btn-small platform-copy-link desktop-secondary-action" type="button" onClick={() => copyTenantLink(tenant)}>
                        <Copy aria-hidden="true" />
                        <span>Copy link</span>
                      </button>
                      <ResponsiveActionMenu label="More" ariaLabel={`More actions for ${tenantDisplayName(tenant)}`} className="mobile-secondary-actions platform-row-action-menu">
                        <button type="button" onClick={() => copyTenantLink(tenant)}>
                          <Copy aria-hidden="true" />
                          <span>Copy link</span>
                        </button>
                      </ResponsiveActionMenu>
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
                  maxLength={63}
                  pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                  title="Use 1 to 63 lowercase letters, numbers, or hyphens. Start and end with a letter or number."
                  value={form.slug}
                  placeholder="1st"
                  onChange={e => updateForm("slug", e.target.value.toLowerCase())}
                />
                <span>.{appConfig.baseDomain}</span>
              </div>

              <label className="field-label" htmlFor="tenantAdminEmail">Platoon admin email</label>
              {!platformProvisioningAvailable ? (
                <p className="team-setup-unavailable" role="status">
                  Create the platoon now, then add its leader after permanent account setup is connected.
                </p>
              ) : null}
              <input
                id="tenantAdminEmail"
                className="input"
                type="email"
                disabled={!platformProvisioningAvailable || isSaving}
                value={form.adminEmail}
                placeholder="admin@example.com"
                onChange={e => updateForm("adminEmail", e.target.value)}
              />

              <label className="field-label" htmlFor="tenantAdminName">Platoon admin name</label>
              <input
                id="tenantAdminName"
                className="input"
                disabled={!platformProvisioningAvailable || isSaving}
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

function LeaderOverviewPanel({
  token,
  tenantSlug,
  me,
  query,
  onQueryChange = () => {},
  canManage,
  preferredSessionId,
  onSessionChange,
  onCreateSession,
  onOpenSessions,
  onOpenSession,
  onOpenUpload,
  onInviteCrew,
  onOpenReview
}) {
  const [sessions, setSessions] = useState([]);
  const [pendingItems, setPendingItems] = useState([]);
  const [assignmentList, setAssignmentList] = useState("available");
  const [submissions, setSubmissions] = useState([]);
  const [status, setStatus] = useState({ text: "Loading dashboard...", isError: false });
  const detailRequestRef = useRef(0);

  async function loadDashboard() {
    try {
      setStatus({ text: "Loading dashboard...", isError: false });
      const [sessionData, reviewData] = await Promise.all([
        apiRequest("/inventory/sessions", { token, tenantSlug }),
        canManage ? apiRequest("/inventory/review-queue", { token, tenantSlug }) : Promise.resolve({ submissions: [] })
      ]);
      const loadedSessions = sortSessionsByAttention(sessionData.sessions || []);
      setSessions(loadedSessions);
      setSubmissions(reviewData.submissions || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadDashboard();
  }, [tenantSlug, token, canManage]);

  const hasSearchQuery = searchTerms(query).length > 0;
  const openSessions = sessions.filter(session => session.status !== "closed");
  const activeSessions = sessions.filter(session => session.status === "active");
  const selectedSession = activeSessions.find(session => session.id === preferredSessionId) || activeSessions[0] || null;
  const reviewRowCount = openSessions.reduce((total, session) => total + Number(session.needsReviewCount || 0), 0);
  const totalRows = openSessions.reduce((total, session) => total + Number(session.itemCount || 0), 0);
  const foundRows = openSessions.reduce((total, session) => total + Number(session.foundCount || 0), 0);
  const overallProgress = totalRows ? Math.round((foundRows / totalRows) * 100) : 0;

  useEffect(() => {
    const sessionId = selectedSession?.id || "";
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setPendingItems([]);

    if (!sessionId) return undefined;
    if (preferredSessionId !== sessionId) onSessionChange?.(sessionId);

    let ignore = false;
    async function loadSelectedSession() {
      try {
        setStatus({ text: "Loading active inventory...", isError: false });
        const detail = await apiRequest(`/inventory/sessions/${sessionId}`, { token, tenantSlug });
        if (ignore || requestId !== detailRequestRef.current) return;
        const rowSession = detail.session || selectedSession;
        const rows = (detail.items || [])
          .filter(item => !sessionItemIsComplete(item))
          .sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b))
          .map(item => ({ ...item, session: rowSession }));
        setPendingItems(rows);
        setAssignmentList(
          rows.some(item => sessionItemAssignmentBucket(item, me) === "mine")
            ? "mine"
            : rows.some(item => sessionItemAssignmentBucket(item, me) === "available")
              ? "available"
              : rows.length ? "team" : "available"
        );
        setStatus({ text: "", isError: false });
      } catch (error) {
        if (!ignore && requestId === detailRequestRef.current) {
          setStatus({ text: getApiErrorMessage(error), isError: true });
        }
      }
    }

    loadSelectedSession();
    return () => {
      ignore = true;
    };
  }, [selectedSession?.id, tenantSlug, token, onSessionChange, me?.user?.id, me?.user?.email]);

  function itemTitle(item) {
    return item.inventoryItem?.commonName || item.inventoryItem?.title || item.packetLine || "Packet row";
  }

  function itemLocation(item) {
    return item.locationHint || item.inventoryItem?.currentLocation || "No location yet";
  }

  const assignmentListOptions = [
    ["available", "Unclaimed"],
    ["mine", "Mine"],
    ["team", "Others"]
  ];
  const assignmentCounts = {
    available: pendingItems.filter(item => sessionItemAssignmentBucket(item, me) === "available").length,
    mine: pendingItems.filter(item => sessionItemAssignmentBucket(item, me) === "mine").length,
    team: pendingItems.filter(item => sessionItemAssignmentBucket(item, me) === "team").length
  };
  const visiblePendingItems = pendingItems
    .filter(item => sessionItemAssignmentBucket(item, me) === assignmentList)
    .filter(item => matchesSearch([
      itemTitle(item),
      item.packetLine,
      itemLocation(item),
      item.inventoryItem?.armyName,
      item.inventoryItem?.lin,
      item.inventoryItem?.nsn,
      item.inventoryItem?.description,
      item.status,
      item.session?.name,
      assignedPerson(item)
    ], query))
    .slice(0, 5);
  const visibleSubmissions = submissions.filter(submission => matchesSearch([
    submission.sessionItem?.packetLine,
    submission.session?.name,
    submission.submittedByName,
    submission.submittedByEmail,
    submission.locationText,
    submission.serialNumber,
    submission.note,
    submission.reviewNote,
    (submission.history || []).flatMap(historyItem => [
      historyItem.locationText,
      historyItem.serialNumber,
      historyItem.note,
      historyItem.reviewNote,
      historyItem.submittedByName,
      historyItem.submittedByEmail
    ])
  ], query)).slice(0, 5);

  return (
    <div className="leader-dashboard">
      <div className="leader-page-heading">
        <div>
          <h1>{canManage ? "Leader Dashboard" : "Inventory Dashboard"}</h1>
          <p>{canManage ? "Manage active inventories and review submitted proof." : "Claim inventory work and submit proof from one place."}</p>
        </div>
        <div className="leader-page-actions">
          {canManage ? (
            <>
              <button className="btn btn-primary" type="button" onClick={onCreateSession}>
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

      <div className={`leader-metric-strip ${canManage ? "" : "contributor"}`} aria-label="Inventory overview">
        <div>
          <strong>{openSessions.length}</strong>
          <span>Open sessions</span>
        </div>
        <div>
          <strong>{pendingItems.length}</strong>
          <span>Open items</span>
        </div>
        {canManage ? (
          <div>
            <strong>{reviewRowCount}</strong>
            <span>Needs review</span>
          </div>
        ) : null}
        <div>
          <strong>{overallProgress}%</strong>
          <span>Found</span>
        </div>
      </div>

      <section className="leader-card leader-active-inventory" aria-label="Active inventory">
        <div className="leader-card-header">
          <span className="leader-card-icon">
            <ListChecks aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">Active inventory</p>
            {activeSessions.length > 1 ? (
              <select
                className="select leader-active-inventory-select"
                value={selectedSession?.id || ""}
                aria-label="Active inventory"
                onChange={event => onSessionChange?.(event.target.value)}
              >
                {activeSessions.map(session => (
                  <option value={session.id} key={session.id}>{session.name}</option>
                ))}
              </select>
            ) : (
              <h2>{selectedSession?.name || "No active inventory"}</h2>
            )}
            <p>{selectedSession
              ? `${countLabel(selectedSession.itemCount || 0, "item")} - ${sessionProgress(selectedSession)}% complete`
              : "Start an inventory session to put current work on the home page."}</p>
          </div>
          {selectedSession ? (
            <div className="leader-active-inventory-actions">
              {canManage && onInviteCrew ? (
                <button className="btn btn-primary" type="button" onClick={() => onInviteCrew(selectedSession)}>
                  <UserPlus aria-hidden="true" />
                  <span>Invite crew</span>
                </button>
              ) : null}
              <button className={canManage ? "btn btn-secondary" : "btn btn-primary"} type="button" onClick={() => onOpenSession(selectedSession.id)}>
                <span>Open session</span>
              </button>
            </div>
          ) : canManage ? (
            <button className="btn btn-primary" type="button" onClick={onCreateSession}>
              <Plus aria-hidden="true" />
              <span>Start inventory</span>
            </button>
          ) : null}
        </div>
      </section>

      <div className={`leader-dashboard-grid ${canManage ? "" : "single"}`}>
        <section className="leader-card" aria-label="Pending inventory results">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <Search aria-hidden="true" />
            </span>
            <div>
              <h2>Work queue</h2>
              <p>{selectedSession ? selectedSession.name : "No active inventory selected."}</p>
            </div>
            <button className="btn btn-secondary btn-small" type="button" onClick={() => selectedSession ? onOpenSession(selectedSession.id) : onOpenSessions()}>
              <span>Open session</span>
            </button>
          </div>

          {selectedSession ? (
            <div className="session-filter-strip leader-work-tabs" role="group" aria-label="Dashboard work assignment lists">
              {assignmentListOptions.map(([value, label]) => (
                <button className={assignmentList === value ? "active" : ""} type="button" key={value} aria-pressed={assignmentList === value} onClick={() => setAssignmentList(value)}>
                  <span>{label}</span>
                  <strong>{assignmentCounts[value]}</strong>
                </button>
              ))}
            </div>
          ) : null}

          <div className="leader-table">
            {visiblePendingItems.length ? visiblePendingItems.map(item => {
              const imageUrls = getInventoryItemImages(item.inventoryItem);
              const assignedName = assignedPerson(item);
              return (
                <article className="leader-table-row" key={item.id}>
                  <div className="leader-item-cell">
                    <span className="leader-thumb">
                      {imageUrls[0] ? <img src={imageUrls[0]} alt="" loading="lazy" /> : <FileText aria-hidden="true" />}
                    </span>
                    <div>
                      <strong>{itemTitle(item)}</strong>
                      <span>{item.session?.name || "Inventory session"}</span>
                      <small>{assignedName ? `Assigned to ${assignedName}` : "Unassigned"}</small>
                    </div>
                  </div>
                  <span>{itemLocation(item)}</span>
                  <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                  <button className="btn btn-secondary btn-small" type="button" onClick={() => onOpenSession(item.session?.id, item.id)}>
                    <span>Open item</span>
                  </button>
                </article>
              );
            }) : (
              <EmptyPanel
                title={hasSearchQuery
                  ? "No matching work"
                  : assignmentList === "available"
                    ? "Nothing unclaimed"
                    : assignmentList === "mine"
                      ? "Nothing assigned to you"
                      : "Nothing assigned to others"}
                body={hasSearchQuery
                  ? "Clear the dashboard search or try a different item or location."
                  : selectedSession
                    ? "Choose another assignment list or open the session to see completed items."
                    : "Start or reopen an inventory session to see current work."}
                action={hasSearchQuery ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={() => onQueryChange("")}>
                    <RefreshCw aria-hidden="true" />
                    <span>Reset dashboard search</span>
                  </button>
                ) : selectedSession ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={() => onOpenSession(selectedSession.id)}>
                    <span>Browse session work</span>
                  </button>
                ) : canManage ? (
                  <button className="btn btn-primary btn-small" type="button" onClick={onCreateSession}>
                    <Plus aria-hidden="true" />
                    <span>Start inventory</span>
                  </button>
                ) : null}
              />
            )}
          </div>
        </section>

        {canManage ? (
          <section className="leader-card" aria-label="Dashboard review results">
          <div className="leader-card-header">
            <span className="leader-card-icon">
              <ClipboardList aria-hidden="true" />
            </span>
            <div>
              <h2>Review</h2>
              <p>Leader approval required.</p>
            </div>
            <button className="btn btn-secondary btn-small" type="button" onClick={onOpenReview}>
              <span>Open review queue</span>
            </button>
          </div>

          <div className="leader-table">
            {visibleSubmissions.length ? visibleSubmissions.map(submission => {
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
                title={hasSearchQuery ? "No matching review work" : "No proof waiting"}
                body={hasSearchQuery ? "Clear the dashboard search or try a packet line, submitter, serial, or proof note." : "New submissions will appear here."}
                action={hasSearchQuery ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={() => onQueryChange("")}>
                    <RefreshCw aria-hidden="true" />
                    <span>Reset dashboard search</span>
                  </button>
                ) : (
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenReview}>
                    <span>Open review queue</span>
                  </button>
                )}
              />
            )}
          </div>
        </section>
        ) : null}
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

const tenantNotificationOptions = [
  { key: "proof_submitted", group: "inApp", label: "Proof submitted", copy: "Alert platoon admins when proof is waiting for review." },
  { key: "proof_requests", group: "inApp", label: "More proof requested", copy: "Alert the submitter when a platoon admin asks for more detail." },
  { key: "open_rows", group: "inApp", label: "Open rows", copy: "Show active sessions that still have unchecked work." },
  { key: "packet_imports", group: "inApp", label: "Packet imports", copy: "Show recent packet imports in the notification panel." },
  { key: "session_closed", group: "inApp", label: "Session closed", copy: "Show recently closed sessions that are ready for records." },
  { key: "email_proof_submitted", group: "email", label: "Email platoon admins", copy: "Email active platoon admins when new proof is submitted." },
  { key: "email_proof_requests", group: "email", label: "Email proof requests", copy: "Email the submitter when more proof is requested." }
];

function TenantSettingsPanel({ token, tenantSlug, onSaved }) {
  const [settingsData, setSettingsData] = useState(null);
  const [draft, setDraft] = useState({ displayName: "", notificationPreferences: {} });
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState({ text: "Loading settings...", isError: false });
  const settingsLoadSequence = useRef(0);

  function applySettings(settings) {
    const loaded = settings || {};
    setSettingsData(loaded);
    setDraft({
      displayName: loaded.displayName || "",
      notificationPreferences: { ...(loaded.notificationPreferences || {}) }
    });
  }

  async function loadSettings() {
    const loadSequence = ++settingsLoadSequence.current;
    try {
      setStatus({ text: "Loading settings...", isError: false });
      const data = await apiRequest("/tenant/settings", { token, tenantSlug });
      if (loadSequence !== settingsLoadSequence.current) return;
      applySettings(data.settings);
      setStatus({ text: "", isError: false });
    } catch (error) {
      if (loadSequence !== settingsLoadSequence.current) return;
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadSettings();
  }, [tenantSlug, token]);

  async function saveSettings(event) {
    event.preventDefault();
    try {
      settingsLoadSequence.current += 1;
      setIsSaving(true);
      setStatus({ text: "Saving workspace settings...", isError: false });
      const data = await apiRequest("/tenant/settings", {
        method: "PATCH",
        token,
        tenantSlug,
        body: {
          displayName: draft.displayName.trim(),
          notificationPreferences: draft.notificationPreferences
        }
      });
      applySettings(data.settings);
      setStatus({ text: "Workspace settings saved.", isError: false });
      onSaved?.(data.settings);
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsSaving(false);
    }
  }

  async function copyWorkspaceUrl() {
    const copied = await copyText(settingsData?.workspace?.url || "");
    setStatus({ text: copied ? "Workspace URL copied." : "Could not copy the workspace URL.", isError: !copied });
  }

  function renderPreferenceGroup(group, legend, copy) {
    return (
      <fieldset className="settings-preference-group">
        <legend>{legend}</legend>
        <p>{copy}</p>
        <div className="settings-toggle-list">
          {tenantNotificationOptions.filter(option => option.group === group).map(option => (
            <label className="settings-toggle" key={option.key}>
              <input
                type="checkbox"
                checked={draft.notificationPreferences[option.key] !== false}
                onChange={event => setDraft(current => ({
                  ...current,
                  notificationPreferences: {
                    ...current.notificationPreferences,
                    [option.key]: event.target.checked
                  }
                }))}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.copy}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <div className="leader-dashboard tenant-settings-page">
      <div className="leader-page-heading">
        <div>
          <h1>Workspace Settings</h1>
          <p>Manage the workspace name and workflow notifications.</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={loadSettings} disabled={isSaving}>
          <RefreshCw aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      <form className="settings-form" onSubmit={saveSettings}>
        <section className="leader-card settings-section">
          <div className="leader-card-header">
            <span className="leader-card-icon"><Settings aria-hidden="true" /></span>
            <div>
              <h2>Workspace profile</h2>
              <p>The name shown in navigation, invitations, and workflow email.</p>
            </div>
          </div>
          <label className="field-label" htmlFor="tenantDisplayName">Display name</label>
          <input
            id="tenantDisplayName"
            className="input"
            required
            minLength={2}
            maxLength={120}
            value={draft.displayName}
            onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))}
          />
          <div className="settings-workspace-link">
            <div>
              <span>Workspace link</span>
              <a href={settingsData?.workspace?.url || "#"}>{settingsData?.workspace?.url || "Loading..."}</a>
            </div>
            <button className="btn btn-secondary" type="button" onClick={copyWorkspaceUrl} disabled={!settingsData?.workspace?.url}>
              <Copy aria-hidden="true" />
              <span>Copy workspace URL</span>
            </button>
          </div>
        </section>

        <section className="leader-card settings-section">
          <div className="leader-card-header">
            <span className="leader-card-icon"><Bell aria-hidden="true" /></span>
            <div>
              <h2>Notification preferences</h2>
              <p>These tenant-wide defaults apply to every member in this workspace.</p>
            </div>
          </div>
          <div className="settings-preference-grid">
            {renderPreferenceGroup("inApp", "In-app alerts", "Choose which workflow events appear under the bell.")}
            {renderPreferenceGroup("email", "Email alerts", "Choose which proof events send workflow email when SMTP is configured.")}
          </div>
        </section>

        <div className="settings-save-bar">
          <StatusLine status={status} />
          <button className="btn btn-primary" type="submit" disabled={isSaving || !draft.displayName.trim()}>
            <CheckCircle2 aria-hidden="true" />
            <span>{isSaving ? "Saving..." : "Save settings"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ReportsPanel({ token, tenantSlug, query, onQueryChange = () => {} }) {
  const [sessions, setSessions] = useState([]);
  const [rows, setRows] = useState([]);
  const [sessionFilter, setSessionFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [isPrintTarget, setIsPrintTarget] = useState(false);
  const [status, setStatus] = useState({ text: "Loading reports...", isError: false });

  async function loadReports() {
    try {
      setStatus({ text: "Loading reports...", isError: false });
      const data = await apiRequest("/inventory/reports", { token, tenantSlug });
      setSessions(data.sessions || []);
      setRows(data.rows || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setSessions([]);
      setRows([]);
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    loadReports();
  }, [tenantSlug, token]);

  function resetReportFilters() {
    setSessionFilter("all");
    setLifecycleFilter("all");
    setResultFilter("all");
    onQueryChange("");
  }

  const scopedRows = useMemo(() => rows.filter(item => {
    if (sessionFilter !== "all" && item.sessionId !== sessionFilter) return false;
    if (lifecycleFilter === "open" && item.sessionStatus === "closed") return false;
    if (lifecycleFilter === "closed" && item.sessionStatus !== "closed") return false;
    const latest = latestSubmission(item);
    return matchesSearch([
      item.sessionName,
      itemDisplayName(item),
      item.packetLine,
      item.status,
      item.sessionStatus,
      item.inventoryItem?.armyName,
      item.inventoryItem?.lin,
      item.inventoryItem?.nsn,
      item.inventoryItem?.description,
      item.locationHint,
      item.inventoryItem?.currentLocation,
      item.assignedToName,
      item.assignedToEmail,
      latest?.status,
      latest?.reviewState,
      latest?.submittedByName,
      latest?.submittedByEmail,
      latest?.locationText,
      latest?.serialNumber,
      latest?.note,
      latest?.reviewNote
    ], query);
  }), [rows, sessionFilter, lifecycleFilter, query]);

  const resultCounts = useMemo(() => ({
    all: scopedRows.length,
    found: scopedRows.filter(item => reportItemOutcome(item) === "found").length,
    missing: scopedRows.filter(item => reportItemOutcome(item) === "not_found").length,
    proof: scopedRows.filter(item => ["pending", "request_more_info", "rejected"].includes(latestSubmission(item)?.reviewState)).length
  }), [scopedRows]);

  const visibleRows = useMemo(() => scopedRows.filter(item => {
    if (resultFilter === "found") return reportItemOutcome(item) === "found";
    if (resultFilter === "missing") return reportItemOutcome(item) === "not_found";
    if (resultFilter === "proof") return ["pending", "request_more_info", "rejected"].includes(latestSubmission(item)?.reviewState);
    return true;
  }), [scopedRows, resultFilter]);
  const summary = useMemo(() => reportSummary(visibleRows), [visibleRows]);
  const renderedRows = isPrintTarget ? visibleRows : visibleRows.slice(0, 250);

  function exportReportsCsv() {
    try {
      const selected = sessions.find(session => session.id === sessionFilter);
      const name = selected ? `${safeFileNamePart(selected.name)}-report.csv` : "shadow-tracer-reports.csv";
      downloadTextFile(name, buildReportsCsv(visibleRows), "text/csv;charset=utf-8");
      setStatus({ text: "Report CSV exported.", isError: false });
    } catch {
      setStatus({ text: "Could not export the report from this browser.", isError: true });
    }
  }

  function printSummary() {
    setIsPrintTarget(true);
    setStatus({ text: "Preparing report for print...", isError: false });
    window.setTimeout(() => {
      window.print();
      window.setTimeout(() => {
        setIsPrintTarget(false);
        setStatus(current => current.text === "Preparing report for print..." ? { text: "", isError: false } : current);
      }, 500);
    }, 0);
  }

  return (
    <div className={`leader-dashboard reports-page ${isPrintTarget ? "reports-print-target" : ""}`}>
      <div className="leader-page-heading reports-screen-only">
        <div>
          <h1>Reports</h1>
          <p>Review outcomes and proof status across inventory sessions.</p>
        </div>
        <div className="leader-page-actions">
          <button className="btn btn-primary" type="button" onClick={exportReportsCsv} disabled={!visibleRows.length}>
            <Download aria-hidden="true" /><span>Export CSV</span>
          </button>
          <button className="btn btn-secondary desktop-secondary-action" type="button" onClick={loadReports}>
            <RefreshCw aria-hidden="true" /><span>Refresh</span>
          </button>
          <button className="btn btn-secondary desktop-secondary-action" type="button" onClick={printSummary} disabled={!visibleRows.length}>
            <Printer aria-hidden="true" /><span>Print summary</span>
          </button>
          <ResponsiveActionMenu className="mobile-secondary-actions">
            <button type="button" onClick={loadReports}>
              <RefreshCw aria-hidden="true" /><span>Refresh report</span>
            </button>
            <button type="button" onClick={printSummary} disabled={!visibleRows.length}>
              <Printer aria-hidden="true" /><span>Print summary</span>
            </button>
          </ResponsiveActionMenu>
        </div>
      </div>

      <section className="leader-card reports-filter-card reports-screen-only" aria-label="Report filters">
        <div className="reports-filter-grid">
          <label>
            <span>Session</span>
            <select className="select" value={sessionFilter} onChange={event => setSessionFilter(event.target.value)}>
              <option value="all">All sessions</option>
              {sessions.map(session => <option value={session.id} key={session.id}>{session.name}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select className="select" value={lifecycleFilter} onChange={event => setLifecycleFilter(event.target.value)}>
              <option value="all">Any lifecycle</option>
              <option value="open">Open sessions</option>
              <option value="closed">Closed sessions</option>
            </select>
          </label>
        </div>
        <div className="reports-result-filters" role="group" aria-label="Proof status and outcome filters">
          {[
            ["all", "All"],
            ["found", "Found"],
            ["missing", "Missing"],
            ["proof", "Proof work"]
          ].map(([value, label]) => (
            <button className={resultFilter === value ? "active" : ""} type="button" key={value} aria-pressed={resultFilter === value} onClick={() => setResultFilter(value)}>
              <span>{label}</span><strong>{resultCounts[value]}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="reports-print-header">
        <strong>Shadow Tracer inventory report</strong>
        <span>{sessions.find(session => session.id === sessionFilter)?.name || "All sessions"}</span>
        <span>Generated {formatDate(new Date())}</span>
      </section>

      <div className="reports-summary-grid" role="region" aria-label="Report summary">
        <div><strong>{summary.total}</strong><span>Rows</span></div>
        <div><strong>{summary.resolved}</strong><span>Resolved</span><small>{summary.completion}%</small></div>
        <div><strong>{summary.found}</strong><span>Found</span></div>
        <div><strong>{summary.missing}</strong><span>Missing</span></div>
        <div><strong>{summary.proofWork}</strong><span>Proof work</span></div>
      </div>
      <div className="reports-breakdown">
        <span>{summary.mismatch} mismatch</span>
        <span>{summary.unchecked} unchecked/in review</span>
      </div>

      <section className="leader-card reports-results" aria-label="Report results">
        <div className="reports-table reports-table-header">
          <span>Session</span><span>Item</span><span>Outcome</span><span>Proof status</span><span>Location / serial</span>
        </div>
        {visibleRows.length ? renderedRows.map(item => {
          const latest = latestSubmission(item);
          const location = latest?.locationText || item.inventoryItem?.currentLocation || item.locationHint || "No location";
          const displayName = itemDisplayName(item);
          return (
            <article className="reports-table reports-table-row" key={item.id}>
              <div data-label="Session"><span className="mobile-field-label">Session</span><span className="reports-field-value"><strong>{item.sessionName}</strong><small>{formatItemStatus(item.sessionStatus)}</small></span></div>
              <div data-label="Item">
                <span className="mobile-field-label">Item</span>
                <span className="reports-field-value"><strong>{displayName}</strong>{item.packetLine && item.packetLine !== displayName ? <small>{item.packetLine}</small> : null}</span>
              </div>
              <div data-label="Outcome"><span className="mobile-field-label">Outcome</span><span className={`status-pill ${reportItemOutcome(item)}`}>{formatItemStatus(reportItemOutcome(item))}</span></div>
              <div data-label="Proof status"><span className="mobile-field-label">Proof status</span><span className={`status-pill ${latest?.reviewState || "unchecked"}`}>{latest?.reviewState ? formatReviewState(latest.reviewState) : "No proof"}</span></div>
              <div data-label="Location / serial"><span className="mobile-field-label">Location / serial</span><span className="reports-field-value"><span>{location}</span>{latest?.serialNumber ? <small>Serial: {latest.serialNumber}</small> : null}</span></div>
            </article>
          );
        }) : (
          <EmptyPanel
            title="No report rows"
            body="Adjust the session, status, proof, or workspace search filters."
            action={(
              <button className="btn btn-secondary btn-small" type="button" onClick={resetReportFilters}>
                <RefreshCw aria-hidden="true" />
                <span>Reset filters</span>
              </button>
            )}
          />
        )}
        {!isPrintTarget && visibleRows.length > renderedRows.length ? (
          <div className="reports-row-limit">Showing the first {renderedRows.length.toLocaleString()} rows. Export CSV or narrow the filters for the full result.</div>
        ) : null}
      </section>

      <StatusLine status={status} />
    </div>
  );
}

const ACTIVITY_DETAIL_LABELS = {
  count: "Rows",
  matchedCount: "Matched rows",
  sessionName: "Session",
  packetLine: "Packet row",
  expectedQty: "Expected quantity",
  locationHint: "Location hint",
  sourceName: "Source",
  status: "Status",
  decision: "Decision",
  role: "Role",
  email: "Email",
  displayName: "Name",
  assigneeName: "Assigned to",
  assigneeEmail: "Assignee email",
  locationText: "Location",
  serialNumber: "Serial number",
  requestedFields: "Requested fields",
  changedFields: "Changed fields",
  previousRole: "Previous role",
  previousStatus: "Previous status",
  assignedToEmail: "Assigned to",
  assignedToRole: "Assigned role",
  note: "Note",
  message: "Request",
  photoCount: "Photos",
  mediaUploadCount: "Attachments",
  length: "Characters",
  expiresAt: "Expires",
  purpose: "Purpose",
  mimeType: "File type",
  sizeBytes: "File size (bytes)",
  attachedToType: "Attached to",
  ownerOverride: "Admin override",
  adminEmail: "Initial admin",
  hostname: "Hostname",
  slug: "Slug"
};

function activityCategoryFor(event) {
  if (event?.category) return String(event.category).toLowerCase();
  const action = String(event?.action || "");
  if (action.startsWith("member.") || action.startsWith("invitation.")) return "access";
  if (action.startsWith("tenant.") || action.startsWith("tenant_")) return "workspace";
  if (action.startsWith("media_upload.")) return "files";
  return "workflow";
}

function activityCategoryLabel(value) {
  return {
    workflow: "Workflow",
    access: "Access",
    workspace: "Workspace",
    files: "Files / system",
    other: "Other"
  }[String(value || "").toLowerCase()] || formatRole(value || "Activity");
}

function activityActionLabel(action) {
  return String(action || "Activity")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, character => character.toUpperCase());
}

function activityActorName(event) {
  return event?.actor?.displayName || event?.actor?.email || "System";
}

function activityContextName(event) {
  return event?.context?.sessionName || event?.details?.sessionName || event?.details?.name || "the inventory session";
}

function activityPacketRow(event) {
  return event?.context?.packetLine || event?.details?.packetLine || "a packet row";
}

function activitySentence(event) {
  const actor = activityActorName(event);
  const details = event?.details || {};
  const sessionName = activityContextName(event);
  const packetRow = activityPacketRow(event);
  const action = event?.action;

  switch (action) {
    case "inventory_session.created":
      return `${actor} created ${sessionName}.`;
    case "inventory_session.updated":
      return `${actor} updated ${sessionName}${details.status ? ` to ${formatItemStatus(details.status)}` : ""}.`;
    case "inventory_session.deleted":
      return `${actor} deleted ${sessionName}.`;
    case "session_items.bulk_created":
      return `${actor} imported ${Number(details.count || 0).toLocaleString()} rows${details.sourceName ? ` from ${details.sourceName}` : ""} into ${sessionName}.`;
    case "session_item.created":
      return `${actor} added ${packetRow} to ${sessionName}.`;
    case "session_item.assigned":
      return `${actor} assigned ${packetRow}${details.assignedToEmail ? ` to ${details.assignedToEmail}` : ""}.`;
    case "session_item.assignment_cleared":
      return `${actor} cleared the assignment for ${packetRow}.`;
    case "session_item.direct_check":
      return `${actor} marked ${packetRow}${details.status ? ` ${formatItemStatus(details.status)}` : ""}.`;
    case "submission.created":
      return `${actor} submitted proof for ${packetRow}.`;
    case "submission.reviewed":
      if (details.decision === "approved") return `${actor} approved proof for ${packetRow}.`;
      if (details.decision === "rejected") return `${actor} rejected proof for ${packetRow}.`;
      if (details.decision === "request_more_info") return `${actor} requested more proof for ${packetRow}.`;
      return `${actor} reviewed proof for ${packetRow}.`;
    case "evidence_request.created":
      return `${actor} requested more proof for ${packetRow}.`;
    case "member.added":
      return `${actor} added ${details.displayName || details.email || "a member"}${details.role ? ` as ${formatRole(details.role)}` : ""}.`;
    case "member.provisioning_requested":
      return `${actor} started permanent account setup for ${details.displayName || details.email || "a teammate"}${details.role ? ` as ${formatTeamRole(details.role)}` : ""}.`;
    case "member.provisioning_retried":
      return `${actor} retried account setup for ${details.displayName || details.email || "a teammate"}.`;
    case "member.enrollment_resend_requested":
      return `${actor} requested another setup email for ${details.displayName || details.email || "a teammate"}.`;
    case "member.updated":
      return `${actor} updated access for ${details.displayName || details.email || "a member"}.`;
    case "member.disabled":
      return `${actor} disabled access for ${details.displayName || details.email || "a member"}.`;
    case "invitation.created":
      return `${actor} invited ${details.email || "a helper"}${details.role ? ` as ${formatRole(details.role)}` : ""}.`;
    case "invitation.resent":
      return `${actor} resent the invitation to ${details.email || "a helper"}.`;
    case "invitation.link_refreshed":
      return `${actor} refreshed the invitation link for ${details.email || "a helper"}.`;
    case "invitation.revoked":
      return `${actor} revoked the invitation for ${details.email || "a helper"}.`;
    case "invitation.accepted":
      return `${details.displayName || details.email || actor} accepted a workspace invitation.`;
    case "tenant.settings_updated":
      return `${actor} updated workspace settings.`;
    case "tenant_guidance.updated":
      return `${actor} updated inventory guidance.`;
    case "inventory_item.created":
      return `${actor} added an inventory item.`;
    default:
      return `${actor} recorded ${activityActionLabel(action).toLowerCase()}.`;
  }
}

function activityFilterValue(option) {
  if (typeof option === "string") return option;
  return option?.value || option?.id || option?.action || option?.entityType || "";
}

function activityFilterLabel(option) {
  if (typeof option === "string") return activityActionLabel(option);
  return option?.label || option?.displayName || option?.email || activityActionLabel(activityFilterValue(option));
}

function activityDateBoundary(value, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );
  return date.toISOString();
}

function TenantActivityPanel({ token, tenantSlug, onOpenSession, onOpenPeople, onOpenSettings }) {
  const emptyFilters = { category: "", actor: "", action: "", entityType: "", from: "", to: "" };
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [filterOptions, setFilterOptions] = useState({ actors: [], actions: [], entityTypes: [] });
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [status, setStatus] = useState({ text: "Loading activity...", isError: false });
  const requestRef = useRef(0);
  const hasFilters = Object.values(appliedFilters).some(Boolean);
  const categoryOptions = filterOptions.categories?.length ? filterOptions.categories : [
    { value: "workflow", label: "Workflow" },
    { value: "access", label: "Access" },
    { value: "workspace", label: "Workspace" },
    { value: "files", label: "Files / system" },
    { value: "other", label: "Other" }
  ];

  async function loadEvents({ append = false, cursor = "", filterValues = appliedFilters } = {}) {
    const requestId = ++requestRef.current;
    const params = new URLSearchParams({ limit: "40" });
    Object.entries(filterValues).forEach(([key, value]) => {
      if (!value) return;
      if (key === "from") {
        params.set(key, activityDateBoundary(value));
        return;
      }
      if (key === "to") {
        params.set(key, activityDateBoundary(value, true));
        return;
      }
      params.set(key, value);
    });
    if (cursor) params.set("cursor", cursor);

    try {
      setIsLoading(true);
      if (!append) {
        setEvents([]);
        setNextCursor("");
        setHasLoadedSuccessfully(false);
      }
      setStatus({ text: append ? "Loading older activity..." : "Loading activity...", isError: false });
      const data = await apiRequest(`/tenant/audit-events?${params.toString()}`, { token, tenantSlug });
      if (requestId !== requestRef.current) return;
      const loadedEvents = data.events || [];
      setEvents(current => append
        ? [...current, ...loadedEvents.filter(event => !current.some(existing => existing.id === event.id))]
        : loadedEvents);
      setNextCursor(data.nextCursor || "");
      setFilterOptions(data.filterOptions || { actors: [], actions: [], entityTypes: [] });
      setHasLoadedSuccessfully(true);
      setStatus({ text: "", isError: false });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      if (requestId === requestRef.current) setIsLoading(false);
    }
  }

  useEffect(() => {
    const initial = { ...emptyFilters };
    setFilters(initial);
    setAppliedFilters(initial);
    loadEvents({ filterValues: initial });
  }, [tenantSlug, token]);

  function applyFilters(event) {
    event.preventDefault();
    const next = { ...filters };
    setAppliedFilters(next);
    loadEvents({ filterValues: next });
  }

  function clearFilters() {
    const next = { ...emptyFilters };
    setFilters(next);
    setAppliedFilters(next);
    loadEvents({ filterValues: next });
  }

  function updateFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }));
  }

  return (
    <div className="activity-page">
      <div className="leader-page-heading activity-page-heading">
        <div>
          <h1>Activity Log</h1>
          <p>Review accountable workspace changes. Actor and related-record labels reflect their current workspace values.</p>
        </div>
        <button className="btn btn-secondary" type="button" disabled={isLoading} onClick={() => loadEvents({ filterValues: appliedFilters })}>
          <RefreshCw aria-hidden="true" />
          <span>{isLoading ? "Refreshing..." : "Refresh"}</span>
        </button>
      </div>

      <form className="leader-card activity-filters" aria-label="Activity filters" onSubmit={applyFilters}>
        <label>
          <span>Category</span>
          <select className="select" value={filters.category} onChange={event => updateFilter("category", event.target.value)}>
            <option value="">All categories</option>
            {categoryOptions.map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Actor</span>
          <select className="select" value={filters.actor} onChange={event => updateFilter("actor", event.target.value)}>
            <option value="">All actors</option>
            {(filterOptions.actors || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Action</span>
          <select className="select" value={filters.action} onChange={event => updateFilter("action", event.target.value)}>
            <option value="">All actions</option>
            {(filterOptions.actions || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Entity</span>
          <select className="select" value={filters.entityType} onChange={event => updateFilter("entityType", event.target.value)}>
            <option value="">All entities</option>
            {(filterOptions.entityTypes || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input className="input" type="date" value={filters.from} onChange={event => updateFilter("from", event.target.value)} />
        </label>
        <label>
          <span>Through</span>
          <input className="input" type="date" value={filters.to} onChange={event => updateFilter("to", event.target.value)} />
        </label>
        <div className="activity-filter-actions">
          <button className="btn btn-primary" type="submit" disabled={isLoading}>Apply filters</button>
          <button className="btn btn-secondary" type="button" disabled={isLoading || (!hasFilters && !Object.values(filters).some(Boolean))} onClick={clearFilters}>Clear filters</button>
        </div>
      </form>

      <StatusLine status={status} />

      <section className="activity-timeline" aria-label="Workspace activity">
        {events.length ? events.map(event => {
          const category = activityCategoryFor(event);
          const safeDetails = Object.entries(event.details || {}).filter(([key, value]) => (
            ACTIVITY_DETAIL_LABELS[key] && value !== "" && value !== null && value !== undefined
          ));
          return (
            <article className="leader-card activity-event" aria-labelledby={`activityEvent${event.id}`} key={event.id}>
              <span className={`activity-event-icon ${category}`}><History aria-hidden="true" /></span>
              <div className="activity-event-copy">
                <h2 className="activity-event-title" id={`activityEvent${event.id}`}>{activitySentence(event)}</h2>
                <div className="activity-event-meta">
                  <span>{activityActorName(event)}</span>
                  <time dateTime={event.createdAt}>{formatDate(event.createdAt)} - {formatRelativeTime(event.createdAt)}</time>
                </div>
                <div className="activity-event-tags">
                  <span>{activityCategoryLabel(category)}</span>
                  <span>{activityActionLabel(event.action)}</span>
                </div>
                {safeDetails.length ? (
                  <details className="activity-event-details">
                    <summary>Details</summary>
                    <dl>
                      {safeDetails.map(([key, value]) => (
                        <div key={key}>
                          <dt>{ACTIVITY_DETAIL_LABELS[key]}</dt>
                          <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ) : null}
              </div>
              <div className="activity-event-actions">
                {event.context?.sessionId ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={() => onOpenSession(event.context.sessionId)}>Open session</button>
                ) : null}
                {category === "access" ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenPeople}>Open people</button>
                ) : null}
                {category === "workspace" ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenSettings}>Open settings</button>
                ) : null}
              </div>
            </article>
          );
        }) : !isLoading && hasLoadedSuccessfully && !status.isError ? (
          <EmptyPanel
            title={hasFilters ? "No matching activity" : "No activity yet"}
            body={hasFilters ? "Clear or change the filters to review other workspace changes." : "Imports, reviews, assignments, invitations, and settings changes will appear here."}
            action={hasFilters ? <button className="btn btn-secondary btn-small" type="button" onClick={clearFilters}>Clear filters</button> : null}
          />
        ) : null}
      </section>

      {nextCursor ? (
        <button className="btn btn-secondary activity-load-more" type="button" disabled={isLoading} onClick={() => loadEvents({ append: true, cursor: nextCursor, filterValues: appliedFilters })}>
          <History aria-hidden="true" />
          <span>{isLoading ? "Loading..." : "Load older activity"}</span>
        </button>
      ) : null}
    </div>
  );
}

function TenantPeoplePanel({
  tenant,
  tenantSlug,
  members,
  invitations,
  query = "",
  onQueryChange,
  onClearSearch,
  onOpenSessions,
  memberForm,
  onMemberFormChange,
  onCreateMember,
  onUpdateMember,
  onDisableMember,
  onRetryMember,
  onResendEnrollment,
  onCopyInviteLink,
  onResendInvitation,
  onRevokeInvitation,
  inviteLinksById,
  inviteActionsById,
  memberActionId,
  lastInviteUrl,
  isSaving,
  provisioningAvailable
}) {
  const activeAdminCount = members.filter(member => member.role === "tenant_admin" && member.status === "active").length;
  const hasSearchQuery = searchTerms(query).length > 0;
  const visibleMembers = members.filter(member => matchesSearch([
    member.displayName,
    member.email,
    member.role,
    formatTeamRole(member.role),
    member.status,
    formatMemberStatus(member.status),
    memberAccountState(member, { provisioningAvailable }).label,
    member.provisioning?.safeError
  ], query));
  const visibleInvitations = invitations.filter(invite => matchesSearch([
    invite.displayName,
    invite.email,
    invite.role,
    formatRole(invite.role),
    invite.status,
    formatInviteStatus(invite.status)
  ], query));
  const addTeammateRef = useRef(null);
  const memberNameRef = useRef(null);

  function openAddTeammate() {
    if (!provisioningAvailable) {
      onOpenSessions?.();
      return;
    }
    if (addTeammateRef.current) addTeammateRef.current.open = true;
    window.requestAnimationFrame(() => memberNameRef.current?.focus());
  }

  function clearPeopleSearch() {
    if (onClearSearch) onClearSearch();
    else onQueryChange?.("");
  }

  return (
    <div className="people-panel">
      <section className="people-hero admin-card">
        <div className="admin-card-heading">
          <span className="admin-icon">
            <Users aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">{tenant?.name || `${tenantSlug} platoon`}</p>
            <h2>Team</h2>
            <p className="section-copy">Add leaders and teammates who need access between inventories.</p>
          </div>
        </div>
      </section>

      <div className="admin-grid people-grid">
        <details className="admin-card add-teammate-card" ref={addTeammateRef}>
          <summary className="add-teammate-summary">
            <span className="admin-icon">
              <MailPlus aria-hidden="true" />
            </span>
            <span className="add-teammate-summary-copy">
              <p className="eyebrow">Permanent access</p>
              <strong className="add-teammate-title">Add teammate</strong>
            </span>
            {!provisioningAvailable ? (
              <span className="status-pill pending">Not connected</span>
            ) : (
              <ChevronDown className="add-teammate-chevron" aria-hidden="true" />
            )}
          </summary>

          <div className="add-teammate-content">
            {!provisioningAvailable ? (
              <>
                <div className="team-setup-unavailable" role="status">
                  <AlertCircle aria-hidden="true" />
                  <span>Permanent account setup is not connected yet.</span>
                </div>
                <p className="team-email-note">For today&apos;s inventory, create temporary access from the active session.</p>
                <button className="btn btn-primary btn-full" type="button" onClick={onOpenSessions}>
                  <ListChecks aria-hidden="true" />
                  <span>Open inventory sessions</span>
                </button>
              </>
            ) : (
              <>
                <p className="team-email-note" id="permanentTeammateHelp">
                  New accounts receive a secure setup link. Existing accounts connect automatically.
                </p>

                <form className="admin-form team-member-form" onSubmit={onCreateMember}>
                  <label className="field-label" htmlFor="memberName">Name</label>
                  <input
                    id="memberName"
                    ref={memberNameRef}
                    className="input"
                    required
                    minLength={2}
                    maxLength={120}
                    autoComplete="name"
                    disabled={isSaving}
                    value={memberForm.displayName}
                    placeholder="Full name"
                    onChange={e => onMemberFormChange(current => ({ ...current, displayName: e.target.value }))}
                  />

                  <label className="field-label" htmlFor="memberEmail">Email</label>
                  <input
                    id="memberEmail"
                    className="input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    aria-describedby="permanentTeammateHelp"
                    disabled={isSaving}
                    value={memberForm.email}
                    placeholder="name@example.com"
                    onChange={e => onMemberFormChange(current => ({ ...current, email: e.target.value }))}
                  />

                  <label className="field-label" htmlFor="memberRole">Access</label>
                  <select
                    id="memberRole"
                    className="select"
                    disabled={isSaving}
                    value={memberForm.role}
                    onChange={e => onMemberFormChange(current => ({ ...current, role: e.target.value }))}
                  >
                    {permanentTeamRoleOptions.map(option => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>

                  <button className="btn btn-primary btn-full" type="submit" disabled={isSaving}>
                    <UserPlus aria-hidden="true" />
                    <span>{isSaving ? "Adding teammate..." : "Add teammate"}</span>
                  </button>
                </form>
              </>
            )}
          </div>
        </details>

        <section className="admin-card admin-card-wide" aria-label="People results">
          <div className="admin-card-heading">
            <span className="admin-icon">
              <UserPlus aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">Permanent access</p>
              <h2>Your team</h2>
            </div>
            <span className="team-count">{visibleMembers.length}</span>
          </div>

          {visibleMembers.length ? (
            <div className="admin-list people-member-list">
              {visibleMembers.map(member => {
                const isWorking = memberActionId === member.id;
                const isLastActiveAdmin = member.role === "tenant_admin" && member.status === "active" && activeAdminCount <= 1;
                const accountState = memberAccountState(member, { provisioningAvailable });
                const provisioning = member.provisioning || null;
                const canRetry = provisioningAvailable && accountState.label === "Needs attention";
                const canResendEnrollment = provisioningAvailable
                  && provisioning?.canResendEnrollment === true;

                return (
                  <article className="team-member-card" key={member.id}>
                    <div className="team-member-summary">
                      <div className="member-main">
                        <strong>{member.displayName || member.email}</strong>
                        <span>{member.email}</span>
                      </div>
                      <span className={`status-pill ${accountState.tone}`}>{accountState.label}</span>
                    </div>

                    <span className="team-member-role">{formatTeamRole(member.role)}</span>

                    {accountState.label === "Needs attention" ? (
                      <div className="member-provisioning-alert" role="status">
                        <AlertCircle aria-hidden="true" />
                        <span>{provisioning?.safeError || "Account setup did not finish. Try it again."}</span>
                        {canRetry ? (
                          <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onRetryMember(member)}>
                            <RefreshCw aria-hidden="true" />
                            <span>{isWorking ? "Retrying..." : "Retry"}</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    <details className="team-member-manage">
                      <summary>
                        <span>Manage</span>
                        <ChevronDown aria-hidden="true" />
                      </summary>
                      <div className="member-controls">
                        <label className="field-label" htmlFor={`memberRole-${member.id}`}>Access</label>
                        <select
                          id={`memberRole-${member.id}`}
                          className="select member-role-select"
                          value={member.role}
                          aria-label={`Access for ${member.displayName || member.email}`}
                          disabled={isWorking || isLastActiveAdmin}
                          title={isLastActiveAdmin ? "Add another active leader before changing this role." : "Change access"}
                          onChange={event => onUpdateMember(member, { role: event.target.value })}
                        >
                          {teamRoleOptions.map(option => (
                            <option value={option.value} key={option.value}>{option.label}</option>
                          ))}
                        </select>

                        <div className="team-member-action-row">
                          {canResendEnrollment ? (
                            <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onResendEnrollment(member)}>
                              <Send aria-hidden="true" />
                              <span>{isWorking ? "Sending..." : "Resend setup email"}</span>
                            </button>
                          ) : null}
                          <button
                            className={member.status === "disabled" ? "btn btn-secondary btn-small" : "btn btn-danger-soft btn-small"}
                            type="button"
                            disabled={isWorking || isLastActiveAdmin || (member.status === "disabled" && !provisioningAvailable)}
                            title={isLastActiveAdmin
                              ? "Add another active leader before disabling this member."
                              : member.status === "disabled" && !provisioningAvailable
                                ? "Permanent account setup must be connected before enabling access."
                                : ""}
                            onClick={() => {
                              if (member.status === "disabled") {
                                onUpdateMember(member, { status: "active" });
                              } else {
                                onDisableMember(member);
                              }
                            }}
                          >
                            <span>{isWorking ? "Saving..." : member.status === "disabled" ? "Enable access" : "Disable access"}</span>
                          </button>
                        </div>
                        {isLastActiveAdmin ? <p className="member-manage-note">Add another leader before changing this account.</p> : null}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyPanel
              title={hasSearchQuery ? "No matching teammates" : "No teammates yet"}
              body={hasSearchQuery ? "Try another name, email, role, or status." : "Add your first permanent teammate."}
              action={hasSearchQuery ? (
                <button className="btn btn-secondary btn-small" type="button" onClick={clearPeopleSearch}>Clear search</button>
              ) : (
                <button className="btn btn-primary btn-small" type="button" onClick={openAddTeammate}>
                  {provisioningAvailable ? "Add teammate" : "Open inventory sessions"}
                </button>
              )}
            />
          )}
        </section>
      </div>

      <details className="admin-card legacy-links-card">
        <summary className="legacy-links-summary">
          <span>
            <LogIn aria-hidden="true" />
            <strong>Legacy sign-in links</strong>
          </span>
          <span>{hasSearchQuery ? `${visibleInvitations.length} of ${invitations.length}` : invitations.length}</span>
        </summary>
        <div className="legacy-links-content">
          <p>Older links stay here until they are accepted, expire, or are revoked.</p>

          {lastInviteUrl ? (
            <div className="admin-copy-box">
              <span>Latest refreshed link</span>
              <a href={lastInviteUrl}>{lastInviteUrl}</a>
            </div>
          ) : null}

          {visibleInvitations.length ? (
            <div className="admin-list compact">
              {visibleInvitations.map(invite => {
                const inviteActionKind = inviteActionsById[invite.id] || "";
                const isWorking = Boolean(inviteActionKind);
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
                          <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onCopyInviteLink(invite)}>
                            <Copy aria-hidden="true" />
                            <span>{isWorking && inviteActionKind === "copy" ? "Refreshing..." : "Copy link"}</span>
                          </button>
                          <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onResendInvitation(invite)}>
                            <Send aria-hidden="true" />
                            <span>{isWorking && inviteActionKind === "resend" ? "Sending..." : "Resend"}</span>
                          </button>
                        </>
                      ) : null}
                      {inviteCanBeRevoked(invite) ? (
                        <button className="btn btn-danger-soft btn-small" type="button" disabled={isWorking} onClick={() => onRevokeInvitation(invite.id)}>
                          <Trash2 aria-hidden="true" />
                          <span>{isWorking && inviteActionKind === "revoke" ? "Revoking..." : "Revoke"}</span>
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyPanel
              title={hasSearchQuery ? "No matching links" : "No legacy links"}
              body={hasSearchQuery ? "Try another email, role, or status." : "Nothing to manage here."}
              action={hasSearchQuery ? (
                <button className="btn btn-secondary btn-small" type="button" onClick={clearPeopleSearch}>Clear search</button>
              ) : null}
            />
          )}
        </div>
      </details>
    </div>
  );
}

function TenantPanel({ token, tenantSlug, me, onRefresh, onLogout }) {
  const isMobileViewport = useMediaQuery("(max-width: 860px)");
  const isCrew = me?.authKind === "crew";
  const isTenantAdmin = Boolean(me?.isPlatformAdmin || me?.membership?.role === "tenant_admin");
  const canSubmitProof = Boolean(isCrew || isTenantAdmin || me?.membership?.role === "contributor");
  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "tasks", label: isCrew ? "Inventory" : "Inventory Sessions", icon: CalendarDays },
    ...(isTenantAdmin ? [{ id: "reports", label: "Reports", icon: BarChart3 }] : []),
    ...(isTenantAdmin ? [{ id: "review", label: "Review Queue", icon: ClipboardList }] : []),
    ...(isTenantAdmin ? [{ id: "people", label: "Team", icon: Users }] : []),
    ...(isTenantAdmin ? [{ id: "activity", label: "Activity Log", icon: History }] : []),
    ...(isTenantAdmin ? [{ id: "settings", label: "Workspace Settings", icon: Settings }] : [])
  ];
  const [activeTab, setActiveTab] = useState("dashboard");
  const [sessionIntent, setSessionIntent] = useState("");
  const [preferredSessionId, setPreferredSessionId] = useState(() => me?.crew?.sessionId || "");
  const [preferredSessionItemId, setPreferredSessionItemId] = useState("");
  const [isStartInventoryOpen, setIsStartInventoryOpen] = useState(false);
  const [startInventoryForm, setStartInventoryForm] = useState(() => ({
    name: defaultInventorySessionName(),
    source: "packet"
  }));
  const [startInventoryStatus, setStartInventoryStatus] = useState({ text: "", isError: false });
  const [leaderQuery, setLeaderQuery] = useState("");
  const [tenant, setTenant] = useState(() => isCrew ? me?.tenant || null : null);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [provisioningAvailable, setProvisioningAvailable] = useState(false);
  const [provisioningPollFailures, setProvisioningPollFailures] = useState(0);
  const [memberForm, setMemberForm] = useState({ email: "", displayName: "", role: "contributor" });
  const [status, setStatus] = useState({ text: "Loading tenant...", isError: false });
  const [lastInviteUrl, setLastInviteUrl] = useState("");
  const [inviteLinksById, setInviteLinksById] = useState({});
  const [inviteActionsById, setInviteActionsById] = useState({});
  const [memberActionId, setMemberActionId] = useState("");
  const [notifications, setNotifications] = useState([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationStatus, setNotificationStatus] = useState("");
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingInventory, setIsStartingInventory] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [crewDialogSession, setCrewDialogSession] = useState(null);
  const notificationsRef = useRef(null);
  const userMenuRef = useRef(null);
  const leaderSearchInputRef = useRef(null);
  const tenantSidebarRef = useRef(null);
  const tenantMobileNavToggleRef = useRef(null);
  const startInventoryActionRef = useRef(false);
  const userName = me?.user?.display_name || me?.user?.displayName || me?.user?.email || "Signed in";
  const userRole = isCrew ? "Crew member" : me?.membership?.role ? formatRole(me.membership.role) : isTenantAdmin ? "Platoon admin" : "Member";
  const userInitial = String(userName || "U").slice(0, 1).toUpperCase();
  const tenantSearch = {
    dashboard: {
      label: "Search dashboard",
      placeholder: "Search dashboard items, sessions, locations..."
    },
    tasks: {
      label: "Search current session rows",
      placeholder: "Search rows, serials, locations, packet text..."
    },
    reports: {
      label: "Search reports",
      placeholder: "Search reports by item, serial, location..."
    },
    review: {
      label: "Search review queue",
      placeholder: "Search proof, serials, submitters, notes..."
    },
    people: {
      label: "Search teammates",
      placeholder: "Search teammates, roles, status..."
    }
  }[activeTab] || null;
  const activeNavLabel = navItems.find(item => item.id === activeTab)?.label || "Workspace";

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      if (isSidebarOpen) closeTenantSidebar();
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
  }, [isSidebarOpen, isMobileViewport]);

  function openPlatformAdmin() {
    const port = window.location.port ? `:${window.location.port}` : "";
    const isLocalhost = window.location.hostname.endsWith("localhost");
    window.location.assign(isLocalhost
      ? `${window.location.protocol}//admin.localhost${port}/#/admin`
      : `https://admin.${appConfig.baseDomain}/#/admin`);
  }

  async function handleLogout() {
    setIsUserMenuOpen(false);
    try {
      await onLogout();
    } catch (error) {
      setStatus({ text: `${getApiErrorMessage(error)} Try leaving the inventory again.`, isError: true });
    }
  }

  function selectTenantTab(tabId) {
    if (tabId !== activeTab) setLeaderQuery("");
    setActiveTab(tabId);
    closeTenantSidebar(false);
    setIsNotificationsOpen(false);
    setIsUserMenuOpen(false);
  }

  function clearLeaderSearch() {
    setLeaderQuery("");
    window.requestAnimationFrame(() => leaderSearchInputRef.current?.focus());
  }

  function openTenantSidebar() {
    setIsSidebarOpen(true);
    window.requestAnimationFrame(() => {
      const target = tenantSidebarRef.current?.querySelector(".leader-nav button.active")
        || tenantSidebarRef.current?.querySelector(".leader-nav button");
      target?.focus?.();
    });
  }

  function closeTenantSidebar(restoreFocus = true) {
    setIsSidebarOpen(false);
    if (restoreFocus && isMobileViewport) {
      window.requestAnimationFrame(() => tenantMobileNavToggleRef.current?.focus());
    }
  }

  async function loadTenant({ silent = false } = {}) {
    if (isCrew) {
      setTenant(me?.tenant || null);
      setMembers([]);
      setInvitations([]);
      setProvisioningAvailable(false);
      setProvisioningPollFailures(0);
      if (!silent) setStatus({ text: "", isError: false });
      return;
    }

    try {
      if (!silent) setStatus({ text: "Loading tenant...", isError: false });
      const tenantData = await apiRequest("/tenant", { token, tenantSlug });
      setTenant(tenantData.tenant);

      if (isTenantAdmin) {
        const [memberData, inviteData] = await Promise.all([
          apiRequest("/tenant/members", { token, tenantSlug }),
          apiRequest("/tenant/invitations", { token, tenantSlug })
        ]);
        setMembers(memberData.members || []);
        setInvitations(inviteData.invitations || []);
        setProvisioningAvailable(memberData.provisioningAvailable === true);
        setProvisioningPollFailures(0);
      } else {
        setMembers([]);
        setInvitations([]);
        setProvisioningAvailable(false);
        setProvisioningPollFailures(0);
      }

      if (!silent) setStatus({ text: "", isError: false });
    } catch (error) {
      if (silent) {
        setProvisioningPollFailures(current => Math.min(current + 1, 5));
      } else {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
    }
  }

  async function loadNotifications() {
    if (isCrew || !tenantSlug || !token) return;

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
  }, [tenantSlug, token, isTenantAdmin, isCrew, me?.tenant?.id]);

  const provisioningBasePollDelay = provisioningAvailable
    ? members.reduce((shortestDelay, member) => {
      const provisioning = member.provisioning || null;
      const provisioningStatus = String(provisioning?.status || "").toLowerCase();
      if (!provisioningWorkStatuses.has(provisioningStatus)) return shortestDelay;

      let delay = 2500;
      if (provisioningStatus === "retry_wait") {
        const nextAttemptAt = new Date(provisioning?.nextAttemptAt || "").getTime();
        delay = Number.isFinite(nextAttemptAt)
          ? Math.max(2500, nextAttemptAt - Date.now() + 1500)
          : 30000;
      }
      return shortestDelay === null ? delay : Math.min(shortestDelay, delay);
    }, null)
    : null;
  const provisioningPollDelay = provisioningBasePollDelay === null
    ? null
    : Math.max(
      provisioningBasePollDelay,
      Math.min(60_000, 2500 * (2 ** provisioningPollFailures))
    );

  useEffect(() => {
    if (!isTenantAdmin || !tenantSlug || !token || provisioningPollDelay === null || memberActionId) return undefined;

    const timeoutId = window.setTimeout(() => {
      loadTenant({ silent: true });
    }, provisioningPollDelay);

    return () => window.clearTimeout(timeoutId);
  }, [provisioningPollDelay, isTenantAdmin, tenantSlug, token, memberActionId, members, provisioningPollFailures]);

  useEffect(() => {
    if (isCrew && me?.crew?.sessionId) setPreferredSessionId(me.crew.sessionId);
  }, [isCrew, me?.crew?.sessionId]);

  async function createPermanentMember(e) {
    e.preventDefault();
    if (!provisioningAvailable) {
      setStatus({ text: "Permanent account setup is not connected yet.", isError: true });
      return;
    }
    setIsSaving(true);
    try {
      const data = await apiRequest("/tenant/members", {
        method: "POST",
        token,
        tenantSlug,
        body: {
          email: memberForm.email.trim(),
          displayName: memberForm.displayName.trim(),
          role: memberForm.role
        }
      });
      setMemberForm({ email: "", displayName: "", role: "contributor" });
      if (data.member) {
        setMembers(current => {
          const withoutCurrent = current.filter(member => member.id !== data.member.id);
          return [data.member, ...withoutCurrent];
        });
      }
      setStatus({ text: "Teammate added. We will keep setup status updated here.", isError: false });
      await loadTenant({ silent: true });
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
        ? "Access updated"
        : patch.status === "active"
          ? "Access restoration started"
          : "Teammate updated";
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
      setStatus({ text: "Access disabled", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  async function retryMemberProvisioning(member) {
    setMemberActionId(member.id);
    try {
      const data = await apiRequest(`/tenant/members/${member.id}/retry`, {
        method: "POST",
        token,
        tenantSlug
      });
      if (data.member) {
        setMembers(current => current.map(item => item.id === data.member.id ? data.member : item));
      }
      setStatus({ text: "Account setup restarted", isError: false });
      await loadTenant({ silent: true });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  async function resendMemberEnrollment(member) {
    setMemberActionId(member.id);
    try {
      const data = await apiRequest(`/tenant/members/${member.id}/resend-enrollment`, {
        method: "POST",
        token,
        tenantSlug
      });
      if (data.member) {
        setMembers(current => current.map(item => item.id === data.member.id ? data.member : item));
      }
      setStatus({ text: "Setup email queued", isError: false });
      await loadTenant({ silent: true });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  async function refreshInvitation(invite, { sendEmail, actionKind }) {
    setInviteActionsById(current => ({ ...current, [invite.id]: actionKind }));
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
      setInviteActionsById(current => {
        if (current[invite.id] !== actionKind) return current;
        const next = { ...current };
        delete next[invite.id];
        return next;
      });
    }
  }

  async function copyInviteLink(invite) {
    const data = await refreshInvitation(invite, { sendEmail: false, actionKind: "copy" });
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
    const data = await refreshInvitation(invite, { sendEmail: true, actionKind: "resend" });
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
    setInviteActionsById(current => ({ ...current, [invitationId]: "revoke" }));
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
      setInviteActionsById(current => {
        if (current[invitationId] !== "revoke") return current;
        const next = { ...current };
        delete next[invitationId];
        return next;
      });
    }
  }

  function openSessions(intent = "") {
    setPreferredSessionItemId("");
    setSessionIntent(intent);
    selectTenantTab("tasks");
  }

  function openActivitySession(sessionId, sessionItemId = "") {
    setPreferredSessionId(sessionId || "");
    setPreferredSessionItemId(sessionItemId || "");
    setSessionIntent("");
    selectTenantTab("tasks");
  }

  function openStartInventoryWizard(source = "packet") {
    setStartInventoryForm(current => ({
      name: current.name.trim() ? current.name : defaultInventorySessionName(),
      source
    }));
    setStartInventoryStatus({ text: "", isError: false });
    setIsStartInventoryOpen(true);
    setIsSidebarOpen(false);
    setIsNotificationsOpen(false);
    setIsUserMenuOpen(false);
  }

  function closeStartInventoryWizard() {
    if (startInventoryActionRef.current) return;
    setIsStartInventoryOpen(false);
    setStartInventoryStatus({ text: "", isError: false });
  }

  async function startInventory(e) {
    e.preventDefault();
    if (startInventoryActionRef.current) return;
    const name = startInventoryForm.name.trim();
    if (!name) {
      setStartInventoryStatus({ text: "Name the inventory session first.", isError: true });
      return;
    }

    try {
      startInventoryActionRef.current = true;
      setIsStartingInventory(true);
      setStartInventoryStatus({ text: "Starting inventory...", isError: false });
      const data = await apiRequest("/inventory/sessions", {
        method: "POST",
        token,
        tenantSlug,
        body: { name, status: "active" }
      });
      const sessionId = data.session?.id || "";
      setPreferredSessionId(sessionId);
      setPreferredSessionItemId("");
      setSessionIntent(startInventoryForm.source === "packet" ? "packet" : "");
      setStartInventoryForm({ name: defaultInventorySessionName(), source: startInventoryForm.source });
      setIsStartInventoryOpen(false);
      selectTenantTab("tasks");
      setStatus({ text: `Started ${data.session?.name || name}`, isError: false });
    } catch (error) {
      setStartInventoryStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      startInventoryActionRef.current = false;
      setIsStartingInventory(false);
    }
  }

  function openNotification(notification) {
    const action = notification?.action || {};
    const tab = action.tab;
    if (tab === "review" && isTenantAdmin) {
      selectTenantTab("review");
      return;
    }

    const sessionId = action.sessionId || notification?.sessionId || "";
    const sessionItemId = action.sessionItemId || notification?.sessionItemId || "";
    if (sessionId) {
      openActivitySession(sessionId, sessionItemId);
      return;
    }

    selectTenantTab("tasks");
  }

  function refreshTenantWorkspace() {
    loadTenant();
    loadNotifications();
    onRefresh?.();
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
      <button className="leader-sidebar-backdrop" type="button" aria-label="Close menu" onClick={() => closeTenantSidebar()} />
      <aside ref={tenantSidebarRef} className="leader-sidebar" aria-hidden={isMobileViewport && !isSidebarOpen ? "true" : undefined} inert={isMobileViewport && !isSidebarOpen ? true : undefined}>
        <div className="leader-brand">
          <button
            className="leader-menu-button"
            type="button"
            aria-label={isSidebarOpen ? "Close menu" : isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              if (isSidebarOpen) {
                closeTenantSidebar();
                return;
              }
              setIsSidebarCollapsed(current => !current);
            }}
          >
            <Menu aria-hidden="true" />
          </button>
          <strong>{APP_NAME}</strong>
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
        <header className={`leader-topbar ${tenantSearch ? "has-search" : "without-search"}`}>
          <button
            ref={tenantMobileNavToggleRef}
            className="leader-mobile-nav-toggle"
            type="button"
            aria-label="Open workspace menu"
            aria-expanded={isSidebarOpen}
            onClick={openTenantSidebar}
          >
            <Menu aria-hidden="true" />
          </button>
          {tenantSearch ? (
            <div className="leader-search" role="search">
              <Search aria-hidden="true" />
              <input
                ref={leaderSearchInputRef}
                type="search"
                value={leaderQuery}
                aria-label={tenantSearch.label}
                placeholder={tenantSearch.placeholder}
                onChange={e => setLeaderQuery(e.target.value)}
                onKeyDown={event => {
                  if (event.key === "Escape" && leaderQuery) {
                    event.preventDefault();
                    clearLeaderSearch();
                  }
                }}
              />
              {leaderQuery ? (
                <button type="button" aria-label="Clear search" onClick={clearLeaderSearch}>
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : (
            <div className="leader-topbar-context" aria-label="Current workspace section">{activeNavLabel}</div>
          )}
          <div className="leader-user-actions">
            <button
              className="icon-button leader-topbar-refresh"
              type="button"
              onClick={refreshTenantWorkspace}
              aria-label="Refresh"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            {!isCrew ? <div className="leader-popover-anchor" ref={notificationsRef}>
              <button
                className="icon-button leader-notification-button"
                type="button"
                aria-label={notificationUnreadCount ? `Notifications, ${notificationUnreadCount} unread` : "Notifications"}
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
            </div> : null}
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
                    <button type="button" onClick={() => {
                      refreshTenantWorkspace();
                      setIsUserMenuOpen(false);
                    }}>
                      <RefreshCw aria-hidden="true" />
                      <span>Refresh workspace</span>
                    </button>
                    <button type="button" onClick={() => selectTenantTab("dashboard")}>
                      <Home aria-hidden="true" />
                      <span>Workspace home</span>
                    </button>
                    {!isCrew ? <button type="button" onClick={() => window.location.assign("/#/launch")}>
                      <Users aria-hidden="true" />
                      <span>Switch workspace</span>
                    </button> : null}
                    {me?.isPlatformAdmin ? (
                      <button type="button" onClick={openPlatformAdmin}>
                        <Building2 aria-hidden="true" />
                        <span>Platform admin</span>
                      </button>
                    ) : null}
                    {!isCrew ? <details className="leader-menu-details">
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
                    </details> : (
                      <div className="crew-access-menu-note">
                        <ShieldCheck aria-hidden="true" />
                        <span>Temporary access to this inventory only.</span>
                      </div>
                    )}
                    <button type="button" onClick={handleLogout}>
                      <LogOut aria-hidden="true" />
                      <span>{isCrew ? "Leave inventory" : "Sign out"}</span>
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
              me={me}
              query={leaderQuery}
              onQueryChange={setLeaderQuery}
              canManage={isTenantAdmin}
              preferredSessionId={preferredSessionId}
              onSessionChange={setPreferredSessionId}
              onCreateSession={() => openStartInventoryWizard("packet")}
              onOpenSessions={() => openSessions()}
              onOpenSession={openActivitySession}
              onOpenUpload={() => openSessions("packet")}
              onInviteCrew={session => setCrewDialogSession(session)}
              onOpenReview={() => selectTenantTab("review")}
            />
          ) : null}

          {activeTab === "tasks" ? (
            <SessionPanel
              token={token}
              tenantSlug={tenantSlug}
              me={me}
              members={members}
              canManage={isTenantAdmin}
              canSubmit={canSubmitProof}
              query={leaderQuery}
              onQueryChange={setLeaderQuery}
              uploadIntent={sessionIntent}
              preferredSessionId={preferredSessionId}
              preferredSessionItemId={preferredSessionItemId}
              onUploadIntentHandled={() => setSessionIntent("")}
              onPreferredSessionItemHandled={() => setPreferredSessionItemId("")}
              onSessionChange={setPreferredSessionId}
              onInviteCrew={session => setCrewDialogSession(session)}
              onOpenReview={() => selectTenantTab("review")}
            />
          ) : null}

          {activeTab === "reports" && isTenantAdmin ? (
            <ReportsPanel token={token} tenantSlug={tenantSlug} query={leaderQuery} onQueryChange={setLeaderQuery} />
          ) : null}

          {activeTab === "review" && isTenantAdmin ? (
            <ReviewPanel
              token={token}
              tenantSlug={tenantSlug}
              query={leaderQuery}
              onQueryChange={setLeaderQuery}
              onClearSearch={clearLeaderSearch}
              onOpenSessions={() => openSessions()}
            />
          ) : null}

          {activeTab === "people" && isTenantAdmin ? (
            <TenantPeoplePanel
              tenant={tenant}
              tenantSlug={tenantSlug}
              members={members}
              invitations={invitations}
              query={leaderQuery}
              onQueryChange={setLeaderQuery}
              onClearSearch={clearLeaderSearch}
              onOpenSessions={() => openSessions()}
              memberForm={memberForm}
              onMemberFormChange={setMemberForm}
              onCreateMember={createPermanentMember}
              onUpdateMember={updateMember}
              onDisableMember={disableMember}
              onRetryMember={retryMemberProvisioning}
              onResendEnrollment={resendMemberEnrollment}
              onCopyInviteLink={copyInviteLink}
              onResendInvitation={resendInvitation}
              onRevokeInvitation={revokeInvitation}
              inviteLinksById={inviteLinksById}
              inviteActionsById={inviteActionsById}
              memberActionId={memberActionId}
              lastInviteUrl={lastInviteUrl}
              isSaving={isSaving}
              provisioningAvailable={provisioningAvailable}
            />
          ) : null}

          {activeTab === "activity" && isTenantAdmin ? (
            <TenantActivityPanel
              token={token}
              tenantSlug={tenantSlug}
              onOpenSession={openActivitySession}
              onOpenPeople={() => selectTenantTab("people")}
              onOpenSettings={() => selectTenantTab("settings")}
            />
          ) : null}

          {activeTab === "settings" && isTenantAdmin ? (
            <TenantSettingsPanel
              token={token}
              tenantSlug={tenantSlug}
              onSaved={saved => setTenant(current => current ? { ...current, name: saved?.displayName || current.name } : current)}
            />
          ) : null}
        </div>
      </main>

      {crewDialogSession ? (
        <CrewAccessDialog
          session={crewDialogSession}
          tenant={tenant}
          token={token}
          tenantSlug={tenantSlug}
          onClose={() => setCrewDialogSession(null)}
        />
      ) : null}

      {isStartInventoryOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-panel start-inventory-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="startInventoryTitle"
            onSubmit={startInventory}
          >
            <div className="modal-stack">
              <div className="modal-heading">
                <span className="modal-icon">
                  <ListChecks aria-hidden="true" />
                </span>
                <div>
                  <p className="eyebrow">Inventory tasking</p>
                  <h2 className="modal-title" id="startInventoryTitle">Start inventory</h2>
                  <p className="modal-copy">Create the session, then decide whether to upload the packet now or build it later.</p>
                </div>
              </div>

              <label className="field-label" htmlFor="startInventoryName">Session name</label>
              <input
                id="startInventoryName"
                className="input"
                value={startInventoryForm.name}
                disabled={isStartingInventory}
                placeholder="July sensitive items"
                onChange={e => setStartInventoryForm(current => ({ ...current, name: e.target.value }))}
                autoFocus
              />

              <fieldset className="start-inventory-options">
                <legend>Packet source</legend>
                <label className={`start-inventory-choice ${startInventoryForm.source === "packet" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="startInventorySource"
                    value="packet"
                    checked={startInventoryForm.source === "packet"}
                    disabled={isStartingInventory}
                    onChange={() => setStartInventoryForm(current => ({ ...current, source: "packet" }))}
                  />
                  <span>
                    <strong>Upload packet now</strong>
                    <small>Open the packet import flow after the session is created.</small>
                  </span>
                </label>
                <label className={`start-inventory-choice ${startInventoryForm.source === "blank" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="startInventorySource"
                    value="blank"
                    checked={startInventoryForm.source === "blank"}
                    disabled={isStartingInventory}
                    onChange={() => setStartInventoryForm(current => ({ ...current, source: "blank" }))}
                  />
                  <span>
                    <strong>Create blank session</strong>
                    <small>Start the workspace and add packet rows later.</small>
                  </span>
                </label>
              </fieldset>

              <StatusLine status={startInventoryStatus} />

              <div className="button-row start-inventory-actions">
                <button className="btn btn-primary" type="submit" disabled={isStartingInventory}>
                  <Plus aria-hidden="true" />
                  <span>{isStartingInventory ? "Starting..." : "Start session"}</span>
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeStartInventoryWizard} disabled={isStartingInventory}>
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
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

  function endCrewAccess(message = "This inventory access has ended.", notice = "ended") {
    clearAuthSession();
    clearQaIdentity();
    setSession(null);
    setMe(null);
    try {
      sessionStorage.setItem("inventory.crew.notice", message);
    } catch {
      // Session storage is best-effort only.
    }
    window.location.replace(`/#/join?notice=${encodeURIComponent(notice)}`);
  }

  async function loadMe(activeToken = token, { silent = false } = {}) {
    try {
      if (!silent) setStatus({ text: "Checking access...", isError: false });
      const data = await apiRequest("/me", { token: activeToken, tenantSlug });
      setMe(data);
      setStatus({ text: "", isError: false });
      return data;
    } catch (error) {
      if (error?.code === "crew_access_ended" || error?.details?.code === "crew_access_ended") {
        endCrewAccess();
        return null;
      }
      setMe(null);
      if (!silent) setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
      return null;
    }
  }

  useEffect(() => {
    async function handleInvalidatedSession() {
      setSession(null);
      setMe(null);

      if (appConfig.enableQaAuth) {
        setStatus({ text: "Your sign-in expired. Try again.", isError: true });
        return;
      }

      try {
        setStatus({ text: "Your sign-in expired. Redirecting to Authentik...", isError: false });
        await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
      } catch (error) {
        setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
      }
    }

    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidatedSession);
    return () => window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidatedSession);
  }, []);

  useEffect(() => {
    const handleCrewAccessEnded = () => endCrewAccess();
    window.addEventListener(CREW_ACCESS_ENDED_EVENT, handleCrewAccessEnded);
    return () => window.removeEventListener(CREW_ACCESS_ENDED_EVENT, handleCrewAccessEnded);
  }, []);

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
        if (!ignore) setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
      }

      if (token && !callbackFailed) {
        if (!ignore) await loadMe(token);
        return;
      }

      if (tenantSlug && !callbackFailed) {
        try {
          if (!ignore) setStatus({ text: "Checking access...", isError: false });
          const data = await apiRequest("/me", { tenantSlug });
          if (ignore) return;
          if (data?.authKind === "crew") {
            setMe(data);
            setStatus({ text: "", isError: false });
            return;
          }
          setMe(null);
        } catch (error) {
          if (error?.code === "crew_access_ended" || error?.details?.code === "crew_access_ended") {
            if (!ignore) endCrewAccess();
            return;
          }
          if (!ignore) setMe(null);
        }
      }

      if (!callbackFailed && !appConfig.enableQaAuth) {
        try {
          setStatus({ text: "Redirecting to Authentik...", isError: false });
          await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
          return;
        } catch (error) {
          if (!ignore) setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
          return;
        }
      }

      if (!ignore && !callbackFailed) setStatus({ text: "", isError: false });
    }

    handleRedirect();
    return () => {
      ignore = true;
    };
  }, []);

  async function logout() {
    const wasCrew = me?.authKind === "crew";
    if (wasCrew) {
      try {
        await apiRequest("/crew/logout", { method: "POST", tenantSlug });
      } catch (error) {
        throw error;
      }
    }
    clearAuthSession();
    clearQaIdentity();
    setSession(null);
    setMe(null);
    setStatus({ text: "", isError: false });
    if (wasCrew) endCrewAccess("You left the inventory. Open a new private invite to join again.", "left");
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
    tenantSlug && (me?.authKind === "crew" || me?.isPlatformAdmin || ["tenant_admin", "contributor", "crew", "viewer"].includes(me?.membership?.role))
  );
  const isTenantDashboard = Boolean(me && !isPlatformPage && canUseTenant);
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

      {!me ? (
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
