import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Bell,
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
  Info,
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
import ProtectedMediaImage, { MediaAuthProvider } from "./ProtectedMediaImage.jsx";
import { apiRequest, clearQaIdentity, CREW_ACCESS_ENDED_EVENT, getApiErrorMessage, readLastApiRequestId, saveQaIdentity } from "../lib/api.js";
import { matchesSearch, metadataSearchText, searchTerms } from "../lib/search.js";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  AUTH_SESSION_REFRESH_EVENT,
  authSessionCanRefresh,
  beginOidcLogin,
  clearAuthSession,
  completeOidcRedirect,
  endOidcSession,
  getSessionAccessToken,
  readAuthSession,
  refreshAuthSession,
  saveAuthSession
} from "../lib/auth.js";
import { packetFileReadErrorMessage, readPacketFileText } from "../lib/ocr.js";
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

function ResponsiveActionMenu({ label = "More actions", ariaLabel = label, children, className = "", disabled = false }) {
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
        disabled={disabled}
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

function AdminHeader({ me, tenantSlug, mode = "", authAction = "", onRefresh, onLogout }) {
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
        <button className="btn btn-secondary" type="button" disabled={Boolean(authAction)} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          <span>{authAction === "refresh" ? "Refreshing..." : "Refresh"}</span>
        </button>
        {me ? (
          <button className="btn btn-secondary" type="button" disabled={Boolean(authAction)} onClick={onLogout}>
            <LogOut aria-hidden="true" />
            <span>{authAction === "logout" ? "Signing out..." : "Sign out"}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

function AuthPanel({ status, authAction = "", manualToken, onManualTokenChange, onManualTokenSave, onSignIn, onUseQaIdentity }) {
  const showQaUsers = appConfig.enableQaAuth;
  const showManualToken = appConfig.enableManualTokenAuth;
  const isWorking = Boolean(authAction);

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
        <button className="btn btn-primary" type="button" disabled={isWorking} onClick={onSignIn}>
          <LogIn aria-hidden="true" />
          <span>{authAction === "signIn" ? "Opening secure sign-in..." : "Continue to secure sign-in"}</span>
        </button>
      </div>

      {showQaUsers ? (
        <details className="disclosure">
          <summary className="btn btn-secondary">
            <span>QA users</span>
          </summary>
          <div className="disclosure-panel qa-persona-grid">
            <button className="btn btn-secondary" type="button" disabled={isWorking} onClick={() => onUseQaIdentity("root")}>
              <span>{authAction === "qa:root" ? "Signing in..." : "Root admin"}</span>
            </button>
            <button className="btn btn-secondary" type="button" disabled={isWorking} onClick={() => onUseQaIdentity("lead")}>
              <span>{authAction === "qa:lead" ? "Signing in..." : "Platoon admin"}</span>
            </button>
            <button className="btn btn-secondary" type="button" disabled={isWorking} onClick={() => onUseQaIdentity("frg")}>
              <span>{authAction === "qa:frg" ? "Signing in..." : "Newsletter admin"}</span>
            </button>
            <button className="btn btn-secondary" type="button" disabled={isWorking} onClick={() => onUseQaIdentity("nco")}>
              <span>{authAction === "qa:nco" ? "Signing in..." : "NCO"}</span>
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
              disabled={isWorking}
              placeholder="Paste bearer token..."
              onChange={e => onManualTokenChange(e.target.value)}
            />
            <button className="btn btn-secondary" type="button" disabled={isWorking || !manualToken.trim()} onClick={onManualTokenSave}>
              <ShieldCheck aria-hidden="true" />
              <span>{authAction === "token" ? "Checking token..." : "Use token"}</span>
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

const platformViewHashes = {
  dashboard: "/admin",
  users: "/admin/users",
  settings: "/admin/settings",
  support: "/admin/support"
};

const newsletterSectionHashes = {
  overview: "/newsletter",
  issues: "/newsletter/issues",
  subscribers: "/newsletter/subscribers",
  analytics: "/newsletter/analytics"
};

const tenantTabHashes = {
  dashboard: "/admin",
  equipment: "/admin/equipment",
  reports: "/admin/reports",
  people: "/admin/team",
  activity: "/admin/activity",
  settings: "/admin/settings"
};

function currentHashParts() {
  return String(window.location.hash || "")
    .replace(/^#\/?/, "")
    .split("?")[0]
    .split("/")
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
}

function platformViewFromLocation() {
  const [root, section] = currentHashParts();
  if (root !== "admin") return "dashboard";
  return ({ users: "users", settings: "settings", support: "support" })[section] || "dashboard";
}

function newsletterSectionFromLocation() {
  const [root, section] = currentHashParts();
  if (root !== "newsletter") return "overview";
  return ({ issues: "issues", subscribers: "subscribers", analytics: "analytics" })[section] || "overview";
}

function tenantRouteFromLocation() {
  const [root, section] = currentHashParts();
  if (root !== "admin") return { tab: "dashboard", panel: "" };
  if (section === "sessions") return { tab: "dashboard", panel: "sessions" };
  if (section === "review") return { tab: "dashboard", panel: "review" };
  return {
    tab: ({ equipment: "equipment", reports: "reports", team: "people", activity: "activity", settings: "settings" })[section] || "dashboard",
    panel: ""
  };
}

function navigateAppHash(hashPath, { replace = false } = {}) {
  const normalizedHash = `#${String(hashPath || "/admin").startsWith("/") ? hashPath : `/${hashPath}`}`;
  if (window.location.hash === normalizedHash) return;
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = normalizedHash.slice(1);
  window.history[replace ? "replaceState" : "pushState"]({}, "", nextUrl.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function getMissingTenantRedirectUrl(profile) {
  const hostname = String(window.location.hostname || "").toLowerCase();
  const isLocal = appConfig.baseDomain === "localhost"
    || hostname === "localhost"
    || hostname.endsWith(".localhost");
  const destination = profile?.isPlatformAdmin ? "admin" : "";

  if (isLocal) {
    const port = window.location.port ? `:${window.location.port}` : "";
    const targetHost = destination ? `${destination}.localhost` : "localhost";
    const hash = destination ? "/#/admin" : "/#/launch";
    return `${window.location.protocol}//${targetHost}${port}${hash}`;
  }

  const targetHost = destination
    ? `${destination}.${appConfig.baseDomain}`
    : appConfig.baseDomain;
  const hash = destination ? "/#/admin" : "/#/launch";
  return `https://${targetHost}${hash}`;
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

function getPriorInventorySnapshot(item) {
  const history = item?.priorInventoryHistory || null;
  const savedItem = item?.inventoryItem || null;
  const lastFound = history?.lastFound || (
    history?.status === "found"
      ? {
          locationText: history.locationText || "",
          sessionName: history.sessionName || "",
          sessionStatus: history.sessionStatus || "",
          inventoriedAt: history.inventoriedAt || "",
          expectedQty: history.expectedQty ?? null
        }
      : null
  );
  const historyPhotos = getInventoryItemPhotos({ photos: history?.photos || [] });
  const savedPhotos = getInventoryItemPhotos(savedItem);
  const photos = history ? (historyPhotos.length ? historyPhotos : savedPhotos) : savedPhotos;
  const historyPhotoKeys = new Set(historyPhotos.map(photo => photo.mediaUploadId || photo.url));
  const additionalSavedPhotos = history && historyPhotos.length
    ? savedPhotos.filter(photo => !historyPhotoKeys.has(photo.mediaUploadId || photo.url))
    : [];
  const location = history ? (lastFound?.locationText || "") : (savedItem?.currentLocation || "");
  const inventoriedAt = history ? (lastFound?.inventoriedAt || "") : (savedItem?.lastVerifiedAt || "");
  const sessionName = history ? (lastFound?.sessionName || "") : "";
  const historyCount = Math.max(0, Number(history?.historyCount || 0));

  if (!history && !photos.length && !location && !inventoriedAt && !sessionName) return null;

  return {
    history,
    lastFound,
    photos,
    location,
    inventoriedAt,
    sessionName,
    historyCount,
    status: history?.status || "",
    expectedQty: lastFound?.expectedQty ?? null,
    sessionStatus: history?.sessionStatus || "",
    photoContext: historyPhotos.length ? (history?.photoContext || history) : {
      sessionName: "Saved item record",
      status: "",
      locationText: savedItem?.currentLocation || "",
      inventoriedAt: savedItem?.lastVerifiedAt || ""
    },
    additionalSavedPhotos,
    savedItem
  };
}

function PriorInventorySnapshot({ item, onOpenPhoto }) {
  const snapshot = getPriorInventorySnapshot(item);
  if (!snapshot) return null;

  const title = itemDisplayName(item);
  const countCopy = snapshot.history
    ? snapshot.sessionStatus && snapshot.sessionStatus !== "closed"
      ? "Approved in another open inventory"
      : snapshot.historyCount > 1
        ? `${snapshot.historyCount} earlier records`
        : "Earlier hand-receipt record"
    : "Saved item record";
  const photoContext = snapshot.photoContext || snapshot.history;
  const displayedFoundContext = snapshot.lastFound || snapshot.history;
  const latestUsesDifferentRecord = Boolean(
    snapshot.history
    && (
      !snapshot.lastFound
      || snapshot.history.sessionName !== snapshot.lastFound.sessionName
      || snapshot.history.inventoriedAt !== snapshot.lastFound.inventoriedAt
    )
  );
  const photosUseDifferentRecord = Boolean(
    snapshot.history
    && photoContext
    && (
      photoContext.sessionName !== displayedFoundContext?.sessionName
      || photoContext.inventoriedAt !== displayedFoundContext?.inventoriedAt
    )
  );
  const savedDetails = snapshot.history && snapshot.savedItem ? [
    snapshot.savedItem.armyName,
    snapshot.savedItem.description,
    snapshot.savedItem.currentLocation && snapshot.savedItem.currentLocation !== snapshot.location
      ? `Current saved location: ${snapshot.savedItem.currentLocation}`
      : ""
  ].filter(Boolean) : [];

  return (
    <section className="prior-inventory-snapshot" aria-label={`Previous inventory for ${title}`}>
      <div className="prior-inventory-heading">
        <History aria-hidden="true" />
        <div>
          <strong>Previous inventory</strong>
          <span>{countCopy}</span>
        </div>
      </div>

      {snapshot.location || snapshot.sessionName || snapshot.inventoriedAt || snapshot.history?.status ? (
        <div className="prior-inventory-facts">
          {snapshot.location ? (
            <div className="prior-inventory-location">
              <span>Last found at</span>
              <strong>{snapshot.location}</strong>
            </div>
          ) : null}
          {snapshot.sessionName || snapshot.inventoriedAt ? (
            <div>
              <span>Found in</span>
              {snapshot.sessionName ? <strong>{snapshot.sessionName}</strong> : null}
              {snapshot.inventoriedAt ? <time dateTime={snapshot.inventoriedAt}>{formatDate(snapshot.inventoriedAt)}</time> : null}
            </div>
          ) : null}
          {snapshot.status ? (
            <div>
              <span>Latest approved result</span>
              <strong>{formatItemStatus(snapshot.status)}</strong>
              {latestUsesDifferentRecord && snapshot.history?.sessionName ? <small>{snapshot.history.sessionName}</small> : null}
              {latestUsesDifferentRecord && snapshot.history?.inventoriedAt ? (
                <time dateTime={snapshot.history.inventoriedAt}>{formatDate(snapshot.history.inventoriedAt)}</time>
              ) : null}
            </div>
          ) : null}
          {snapshot.expectedQty != null ? (
            <div>
              <span>Quantity on record</span>
              <strong>{snapshot.expectedQty}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {snapshot.photos.length ? (
        <div className="prior-inventory-photo-block">
          {photosUseDifferentRecord ? (
            <small className="prior-inventory-photo-source">
              Photos from {photoContext.sessionName || "an earlier inventory"}
              {photoContext.inventoriedAt ? ` - ${formatDate(photoContext.inventoriedAt)}` : ""}
            </small>
          ) : null}
          <div className="prior-inventory-photos" aria-label={`Previous inventory photos for ${title}`}>
            {snapshot.photos.slice(0, 3).map((photo, index) => (
              onOpenPhoto ? (
                <button
                  type="button"
                  key={photo.id || photo.url}
                  aria-label={`View previous inventory photo ${index + 1}`}
                  onClick={() => onOpenPhoto(index, snapshot)}
                >
                  <ProtectedMediaImage src={photo.url} alt={photo.caption || `Previous inventory photo ${index + 1}`} loading="lazy" />
                </button>
              ) : (
                <span className="prior-inventory-photo" key={photo.id || photo.url}>
                  <ProtectedMediaImage src={photo.url} alt={photo.caption || `Previous inventory photo ${index + 1}`} loading="lazy" />
                </span>
              )
            ))}
          </div>
        </div>
      ) : null}
      {snapshot.additionalSavedPhotos.length ? (
        <div className="prior-inventory-photo-block">
          <small className="prior-inventory-photo-source">Saved reference photos</small>
          <div className="prior-inventory-photos" aria-label={`Saved reference photos for ${title}`}>
            {snapshot.additionalSavedPhotos.slice(0, 3).map((photo, index) => (
              onOpenPhoto ? (
                <button
                  type="button"
                  key={photo.id || photo.url}
                  aria-label={`View saved reference photo ${index + 1}`}
                  onClick={() => onOpenPhoto(index, {
                    ...snapshot,
                    photos: snapshot.additionalSavedPhotos,
                    photoContext: {
                      sessionName: "Saved item record",
                      locationText: snapshot.savedItem?.currentLocation || "",
                      inventoriedAt: snapshot.savedItem?.lastVerifiedAt || ""
                    }
                  })}
                >
                  <ProtectedMediaImage src={photo.url} alt={photo.caption || `Saved reference photo ${index + 1}`} loading="lazy" />
                </button>
              ) : (
                <span className="prior-inventory-photo" key={photo.id || photo.url}>
                  <ProtectedMediaImage src={photo.url} alt={photo.caption || `Saved reference photo ${index + 1}`} loading="lazy" />
                </span>
              )
            ))}
          </div>
        </div>
      ) : null}
      {savedDetails.length ? (
        <p className="prior-inventory-saved-details"><strong>Saved item details:</strong> {savedDetails.join(" - ")}</p>
      ) : null}
    </section>
  );
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
  return ["request_more_info", "rejected"].includes(latestSubmission(item)?.reviewState);
}

function itemHasPendingProof(item) {
  return latestSubmission(item)?.reviewState === "pending";
}

function sessionItemNeedsAction(item) {
  const latest = latestSubmission(item);
  const directlyResolved = Boolean(item?.directVerifiedBy) && ["found", "not_found", "mismatch"].includes(item?.status);
  return !["approved", "found", "not_found", "mismatch"].includes(item?.status)
    || (!directlyResolved && ["pending", "request_more_info", "rejected"].includes(latest?.reviewState));
}

function sessionItemNeedsReview(item) {
  return item?.status === "needs_review" || latestSubmission(item)?.reviewState === "pending";
}

function sessionItemHasProblem(item) {
  const latest = latestSubmission(item);
  return ["not_found", "mismatch"].includes(item?.status) || latest?.reviewState === "rejected";
}

function sessionItemIsComplete(item) {
  const directlyResolved = Boolean(item?.directVerifiedBy) && ["found", "not_found", "mismatch"].includes(item?.status);
  return ["approved", "found", "not_found", "mismatch"].includes(item?.status)
    && (directlyResolved || !["pending", "request_more_info", "rejected"].includes(latestSubmission(item)?.reviewState));
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
    withdrawn: "Withdrawn",
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
  return ["approved", "found", "not_found", "mismatch"].includes(item?.status);
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
        hasMeaningfulSerial(latest?.serialNumber) ? `SN: ${latest.serialNumber}` : "",
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
      hasMeaningfulSerial(latest?.serialNumber) ? latest.serialNumber : "",
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
    "Reported By",
    "Updated"
  ];
  const values = (rows || []).map(item => {
    const wasDirectlyVerified = Boolean(item.directVerifiedBy || item.directVerifiedByName || item.directVerifiedByEmail);
    const latest = wasDirectlyVerified ? null : latestSubmission(item);
    const reportedBy = item.directVerifiedByName
      || item.directVerifiedByEmail
      || (latest ? submissionPerson(latest) : "");
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
      wasDirectlyVerified ? "Direct check" : latest?.reviewState ? formatReviewState(latest.reviewState) : "No proof",
      latest?.locationText || item.inventoryItem?.currentLocation || item.locationHint || "",
      hasMeaningfulSerial(latest?.serialNumber) ? latest.serialNumber : "",
      latest?.note || latest?.reviewNote || "",
      reportedBy,
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
  { value: "serial_photo", label: "Item photo" },
  { value: "wide_photo", label: "Location / context photo" },
  { value: "location", label: "Location" },
  { value: "damage", label: "Condition / damage" }
];

const proofPhotoKindLabels = {
  general: "Item photo",
  serial: "Item photo",
  location: "Location photo",
  damage: "Condition photo"
};

const MAX_EVIDENCE_PHOTOS = 10;
const MIN_ACCOUNTABILITY_NOTE_LENGTH = 12;
const emptySerialValues = new Set(["na", "n/a", "none", "not applicable", "not serialized", "unserialized"]);

function hasMeaningfulSerial(value) {
  const serial = String(value || "").trim();
  return Boolean(serial) && !emptySerialValues.has(serial.toLowerCase());
}

function hasMeaningfulAccountabilityNote(value) {
  return String(value || "").trim().length >= MIN_ACCOUNTABILITY_NOTE_LENGTH;
}

function isAccountabilityNoteEvidence(submission) {
  return !(submission?.photos || []).length && hasMeaningfulAccountabilityNote(submission?.note);
}

function proofPhotoLabel(photo) {
  return proofPhotoKindLabels[photo?.kind] || "Item photo";
}

function proofPhotoCaption(photo) {
  const caption = String(photo?.caption || "").trim();
  if (!caption || /^serial(?: number)? photo$/i.test(caption)) return proofPhotoLabel(photo);
  return caption;
}

function proofPhotoAlt(photo) {
  const label = proofPhotoLabel(photo);
  const caption = proofPhotoCaption(photo);
  return caption !== label ? `${label}: ${caption}` : label;
}

function applicableProofRequest(history = [], evidence = null) {
  if (["request_more_info", "rejected"].includes(evidence?.reviewState) && evidence?.reviewNote) {
    return evidence.reviewNote;
  }
  const evidenceCreatedAt = Date.parse(evidence?.createdAt || "") || Number.POSITIVE_INFINITY;
  return history.find(historyItem => (
    historyItem.id !== evidence?.id &&
    ["request_more_info", "rejected", "superseded"].includes(historyItem.reviewState) &&
    historyItem.reviewNote &&
    (Date.parse(historyItem.createdAt || "") || 0) <= evidenceCreatedAt
  ))?.reviewNote || "";
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

function tenantHost(tenant) {
  return tenant?.hostname || `${tenant.slug}.${appConfig.baseDomain}`;
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
  const [submitProgress, setSubmitProgress] = useState("");
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

    const accountabilityNote = form.note.trim();
    if (!form.photoFiles.length && !hasMeaningfulAccountabilityNote(accountabilityNote)) {
      onStatus({
        text: "Add an item photo, or explain who verified the item and why it is accounted for.",
        isError: true
      });
      return;
    }

    const action = "submit";
    if (!beginAction(action)) return;
    try {
      onStatus({ text: "Submitting proof...", isError: false });
      const photos = [];

      for (const [photoIndex, photoFile] of form.photoFiles.entries()) {
        setSubmitProgress(`Uploading photo ${photoIndex + 1} of ${form.photoFiles.length}...`);
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
              kind: "general"
            }
          });
          uploadedPhotosRef.current.set(photoFile, uploaded);
        }
        photos.push(uploaded.photo);
      }

      setSubmitProgress("Sending evidence...");
      await apiRequest(`/session-items/${item.id}/submissions`, {
        method: "POST",
        token,
        tenantSlug,
        body: {
          status: form.status,
          locationText: form.locationText.trim() || undefined,
          note: accountabilityNote || undefined,
          serialNumber: hasMeaningfulSerial(form.serialNumber) ? form.serialNumber.trim() : undefined,
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
      setSubmitProgress("");
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
                  <ProtectedMediaImage src={photo.url} alt="" loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <label className="field-label" htmlFor={`proofResult-${item.id}`}>Inventory result</label>
      <select
        id={`proofResult-${item.id}`}
        className="select proof-result-select"
        value={form.status}
        disabled={isSaving}
        autoFocus
        onChange={event => setForm(current => ({ ...current, status: event.target.value }))}
      >
        <option value="found">Found / accounted for</option>
        <option value="not_found">Not found</option>
        <option value="mismatch">Mismatch</option>
      </select>

      <details className={`proof-requirement-help ${form.photoFiles.length || hasMeaningfulAccountabilityNote(form.note) ? "satisfied" : ""}`}>
        <summary>
          <Info aria-hidden="true" />
          <span>What counts as proof?</span>
        </summary>
        <p>Use a photo when available. If the item is signed out, in maintenance, or confirmed elsewhere, write who verified it and its status.</p>
      </details>

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
        <span>Serial number (if serialized)</span>
        <input
          className="input"
          disabled={isSaving}
          value={form.serialNumber}
          placeholder="Leave blank when the item is not serialized"
          onChange={e => setForm(current => ({ ...current, serialNumber: e.target.value }))}
        />
      </label>
      <label className="proof-field">
        <span>{requestNote ? "Response note" : "Note"}</span>
        <textarea
          className="input proof-note"
          disabled={isSaving}
          value={form.note}
          placeholder={requestNote ? "Explain how this answers the request" : "Example: Verified with supply; signed out to SGT Smith"}
          onChange={e => setForm(current => ({ ...current, note: e.target.value }))}
        />
        <small className="proof-field-help">No photo available? Record who confirmed the item and why it is accounted for.</small>
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
      <label className={`photo-picker ${form.photoFiles.length >= MAX_EVIDENCE_PHOTOS || isSaving ? "disabled" : ""}`}>
        <Camera aria-hidden="true" />
        <span>{pendingAction.startsWith("remove:")
          ? "Removing photo..."
          : form.photoFiles.length
            ? `Add another item photo (${form.photoFiles.length}/${MAX_EVIDENCE_PHOTOS})`
            : `Add item photos (up to ${MAX_EVIDENCE_PHOTOS})`}</span>
        <input
          className="photo-picker-input"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          disabled={form.photoFiles.length >= MAX_EVIDENCE_PHOTOS || isSaving}
          aria-label={form.photoFiles.length ? "Add another item photo" : "Add item photos"}
          onChange={event => {
            const selectedFiles = [...(event.target.files || [])];
            event.target.value = "";
            if (!selectedFiles.length) return;
            if (form.photoFiles.length + selectedFiles.length > MAX_EVIDENCE_PHOTOS) {
              onStatus({ text: `You can submit up to ${MAX_EVIDENCE_PHOTOS} photos for review.`, isError: true });
            }
            setForm(current => ({
              ...current,
              photoFiles: [...current.photoFiles, ...selectedFiles].slice(0, MAX_EVIDENCE_PHOTOS)
            }));
          }}
        />
      </label>

      <div className="button-row">
        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          <Send aria-hidden="true" />
          <span>{pendingAction === "submit" ? submitProgress || "Submitting..." : requestNote ? "Send response" : "Submit proof"}</span>
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

function AuthBootPanel({ status }) {
  return (
    <section className="admin-card admin-auth-card auth-boot-panel" aria-label="Opening Shadow Tracer">
      <RefreshCw className="auth-boot-spinner" aria-hidden="true" />
      <div>
        <h2>Opening Shadow Tracer</h2>
        <p>{status?.text || "Checking secure access..."}</p>
      </div>
    </section>
  );
}

function PossiblePriorMatchCard({ item, action = "", onConfirm, onDismiss }) {
  const candidate = item?.suggestedInventoryItem;
  if (!candidate) return null;

  const isSaving = Boolean(action);
  const photos = getInventoryItemPhotos(candidate);
  const identifiers = [
    candidate.lin ? `LIN ${candidate.lin}` : "",
    candidate.nsn ? `NSN ${candidate.nsn}` : "",
    hasMeaningfulSerial(candidate.serialNumber) ? `SN ${candidate.serialNumber}` : ""
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
              <ProtectedMediaImage src={photo.url} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      <p className="prior-match-copy">Is this the same physical item?</p>
      <div className="prior-match-actions">
        <button className="btn btn-primary" type="button" disabled={isSaving} onClick={onConfirm}>
          <CheckCircle2 aria-hidden="true" />
          <span>{action === "confirm" ? "Linking record..." : "Use this record"}</span>
        </button>
        <button className="btn btn-secondary" type="button" disabled={isSaving} onClick={onDismiss}>
          <XCircle aria-hidden="true" />
          <span>{action === "dismiss" ? "Removing match..." : "Not the same item"}</span>
        </button>
      </div>
    </section>
  );
}

function SessionItemInlineContext({
  item,
  importBatch,
  canManage,
  isClosed,
  assignmentAction,
  directCheckAction,
  matchAction,
  assignableMembers,
  assignedMemberId,
  onAssign,
  onDirectCheck,
  onResolveMatch,
  onOpenPriorPhoto,
  onOpenSavedPhoto,
  onOpenProofPhoto
}) {
  const title = itemDisplayName(item);
  const savedRecord = item.inventoryItem || null;
  const savedPhotos = getInventoryItemPhotos(savedRecord);
  const submissions = item.submissions || [];
  const isAssignmentPending = Boolean(assignmentAction);
  const isDirectCheckPending = Boolean(directCheckAction);
  const hasSavedFacts = Boolean(savedRecord && (
    savedRecord.commonName
    || savedRecord.title
    || savedRecord.armyName
    || savedRecord.lin
    || savedRecord.nsn
    || savedRecord.currentLocation
    || savedRecord.description
  ));

  return (
    <div className="session-item-context-stack">
      {item.priorInventoryHistory ? <PriorInventorySnapshot item={item} onOpenPhoto={onOpenPriorPhoto} /> : null}

      {canManage && !isClosed && item.suggestedInventoryItem ? (
        <PossiblePriorMatchCard
          item={item}
          action={matchAction}
          onConfirm={() => onResolveMatch("confirm")}
          onDismiss={() => onResolveMatch("dismiss")}
        />
      ) : null}

      {!item.priorInventoryHistory && savedRecord && (hasSavedFacts || savedPhotos.length) ? (
        <section className="session-item-context session-item-saved-record" aria-label={`Saved record for ${title}`}>
          <div className="session-item-context-heading">
            <h3>Saved record</h3>
            <span>Matched from previous inventory</span>
          </div>
          {hasSavedFacts ? (
            <dl className="session-item-context-facts">
              {savedRecord.commonName || savedRecord.title ? <div><dt>Common name</dt><dd>{savedRecord.commonName || savedRecord.title}</dd></div> : null}
              {savedRecord.armyName ? <div><dt>Army name</dt><dd>{savedRecord.armyName}</dd></div> : null}
              {savedRecord.lin ? <div><dt>LIN</dt><dd>{savedRecord.lin}</dd></div> : null}
              {savedRecord.nsn ? <div><dt>NSN</dt><dd>{savedRecord.nsn}</dd></div> : null}
              {savedRecord.currentLocation ? <div><dt>Last location</dt><dd>{savedRecord.currentLocation}</dd></div> : null}
              {savedRecord.description ? <div><dt>Description</dt><dd>{savedRecord.description}</dd></div> : null}
            </dl>
          ) : null}
          <ProofPhotoStrip
            photos={savedPhotos}
            compact
            label={`Saved record photos for ${title}`}
            onOpen={onOpenSavedPhoto}
          />
        </section>
      ) : null}

      {submissions.length ? (
        <section className="session-item-context session-item-proof-history" aria-label={`Proof history for ${title}`}>
          <div className="session-item-context-heading">
            <h3>Proof history</h3>
            <span>{countLabel(submissions.length, "submission")}</span>
          </div>
          <div className="session-item-proof-list">
            {submissions.map(submission => (
              <article className="session-item-proof-entry" key={submission.id}>
                <div className="session-item-proof-heading">
                  <div>
                    <strong>{formatReviewState(submission.reviewState)}</strong>
                    <span>{submissionPerson(submission)} - {formatDate(submission.createdAt)}</span>
                  </div>
                  <span className={`status-pill ${submission.status}`}>{formatItemStatus(submission.status)}</span>
                </div>
                {submission.locationText || hasMeaningfulSerial(submission.serialNumber) ? (
                  <div className="session-item-proof-facts">
                    {submission.locationText ? <span>Location: {submission.locationText}</span> : null}
                    {hasMeaningfulSerial(submission.serialNumber) ? <span>Serial: {submission.serialNumber}</span> : null}
                  </div>
                ) : null}
                {submission.note ? <p>{submission.note}</p> : null}
                {submission.reviewNote ? (
                  <p className={submission.reviewState === "request_more_info" || submission.reviewState === "rejected" ? "session-proof-request" : ""}>
                    {submission.reviewState === "request_more_info" ? "Requested" : submission.reviewState === "rejected" ? "Rejected" : "Review note"}: {submission.reviewNote}
                  </p>
                ) : null}
                <ProofPhotoStrip
                  photos={submission.photos}
                  compact
                  label={`Evidence from ${submissionPerson(submission)}`}
                  onOpen={index => onOpenProofPhoto(submission, index)}
                />
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {canManage && importBatch ? (
        <p className="session-item-provenance">
          Imported from <strong>{importBatch.sourceName || "an uploaded packet"}</strong>
          {importBatch.createdAt ? ` on ${formatDate(importBatch.createdAt)}` : ""}
          {importBatch.createdByName || importBatch.createdByEmail ? ` by ${importBatch.createdByName || importBatch.createdByEmail}` : ""}.
        </p>
      ) : null}

      {canManage && !isClosed ? (
        <section className="session-item-context session-item-inline-manage" aria-label={`Manage ${title}`}>
          <div className="session-item-context-heading"><h3>Leader controls</h3></div>
          <div className="session-item-inline-controls">
            <label className="session-assignment-control">
              <span>Assign to</span>
              <select value={assignedMemberId} disabled={isAssignmentPending || isDirectCheckPending} onChange={event => onAssign(event.target.value)}>
                <option value="">Unassigned</option>
                {assignableMembers.map(member => (
                  <option value={member.id} key={member.id}>
                    {member.displayName || member.email || formatRole(member.role)}
                  </option>
                ))}
              </select>
            </label>
            <label className="session-assignment-control">
              <span>Set result</span>
              <select value="" disabled={isAssignmentPending || isDirectCheckPending} onChange={event => {
                if (event.target.value) onDirectCheck(event.target.value);
              }}>
                <option value="">{isDirectCheckPending ? "Saving result..." : "Choose a result"}</option>
                <option value="found">Found / accounted for</option>
                <option value="not_found">Not found</option>
              </select>
            </label>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SessionProofDialog({
  item,
  session,
  status,
  token,
  tenantSlug,
  onCancel,
  onSaved,
  onStatus
}) {
  if (!item) return null;

  const title = itemDisplayName(item);
  const latest = latestSubmission(item);
  const isRejectedProof = latest?.reviewState === "rejected";
  const needsMoreProof = latest?.reviewState === "request_more_info" || isRejectedProof;

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const focusable = [...event.currentTarget.querySelectorAll(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
      className="session-proof-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <aside
        className="session-proof-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessionProofDialogTitle"
        aria-describedby="sessionProofDialogItem"
        onKeyDown={handleKeyDown}
      >
        <header className="session-proof-dialog-heading">
          <div>
            <p className="eyebrow">{session?.name || "Inventory session"}</p>
            <h2 id="sessionProofDialogTitle">{needsMoreProof ? `Respond with proof for ${title}` : `Add proof for ${title}`}</h2>
            <p id="sessionProofDialogItem">Record the result, location, notes, and photos that apply.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close proof form" onClick={onCancel} autoFocus>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="session-proof-dialog-body">
          <StatusLine status={status} />
          <section className="session-detail-proof-form" aria-label="Submit proof">
            <ProofForm
              key={item.id}
              item={item}
              token={token}
              tenantSlug={tenantSlug}
              requestNote={needsMoreProof ? latest.reviewNote : applicableProofRequest(item.submissions, latest)}
              onCancel={onCancel}
              onSaved={onSaved}
              onStatus={onStatus}
            />
          </section>
        </div>
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
  onUploadIntentHandled,
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
  const [withdrawingSubmissionId, setWithdrawingSubmissionId] = useState("");
  const [printReportId, setPrintReportId] = useState("");
  const [closedSessionLimit, setClosedSessionLimit] = useState(20);
  const [packetWizardModeTouched, setPacketWizardModeTouched] = useState(false);
  const packetFileInputRef = useRef(null);
  const packetTextareaRef = useRef(null);
  const detailPhotoTriggerRef = useRef(null);
  const proofTriggerRef = useRef(null);
  const packetWizardCurrentRef = useRef({ mode: "existing", sessionId: "", sessionName: "" });
  const packetActionRef = useRef("");
  const sessionCreateActionRef = useRef(false);
  const sessionListRequestRef = useRef(0);
  const sessionDetailRequestRef = useRef(0);
  const sessionLoadContextRef = useRef({ tenantSlug: null, token: null });
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

  async function loadSessionDetail(
    sessionId = selectedSessionId,
    showStatus = true,
    sessionListRequestId = null,
    reportErrors = true
  ) {
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
        if (!reportErrors) return false;
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
    const previousContext = sessionLoadContextRef.current;
    const contextChanged = previousContext.tenantSlug !== tenantSlug || previousContext.token !== token;
    sessionLoadContextRef.current = { tenantSlug, token };
    if (!contextChanged && preferredSessionId && preferredSessionId === selectedSessionId) return;
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
        void loadSessionDetail(sessionId, false, null, false);
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

    setStatus({
      text: analysis.ignoredCount
        ? `${rows.length} item rows ready. ${analysis.ignoredCount} lines of headers or page text were skipped.`
        : `${rows.length} item rows ready.`,
      isError: false
    });
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
      setStatus({ text: packetFileReadErrorMessage(error, file), isError: true });
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
      const savedItemCount = Array.isArray(data.sessionItems) ? data.sessionItems.length : 0;
      if (savedItemCount !== items.length) {
        await loadSessions(targetSessionId);
        setStatus({
          text: savedItemCount
            ? `We could confirm only ${savedItemCount} of ${items.length} packet rows. Your reviewed rows and location hints are still here, and the session was refreshed. Check the list before trying again.`
            : "We couldn't confirm that any packet rows were saved. Your reviewed rows and location hints are still here, and the session was refreshed. Check the list before trying again.",
          isError: true
        });
        return null;
      }
      const possibleMatchCount = Number(
        data.possibleMatchCount
        ?? (data.sessionItems || []).filter(item => item.suggestedInventoryItemId || item.suggested_inventory_item_id).length
        ?? 0
      );
      await loadSessions(targetSessionId);
      clearPacketImport();
      setStatus({
        text: possibleMatchCount
          ? `Added ${savedItemCount} packet rows. ${possibleMatchCount} possible previous ${possibleMatchCount === 1 ? "record needs" : "records need"} review.`
          : `Added ${savedItemCount} packet rows.`,
        isError: false
      });
      return { count: savedItemCount, sourceName, sessionId: targetSessionId, possibleMatchCount };
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

  async function withdrawSubmission(submission) {
    if (!submission?.id || withdrawingSubmissionId) return;
    setWithdrawingSubmissionId(submission.id);
    setStatus({ text: "Withdrawing proof...", isError: false });
    try {
      await apiRequest(`/submissions/${submission.id}/withdraw`, {
        method: "POST",
        token,
        tenantSlug
      });
      await loadSessions(selectedSessionId);
      setStatus({ text: "Submission withdrawn. You can update the proof and submit it again.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      await loadSessions(selectedSessionId);
    } finally {
      setWithdrawingSubmissionId("");
    }
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
      setStatus({
        text: remainingCandidates.length
          ? `${action === "confirm" ? "Saved record linked." : "Suggestion removed."} ${remainingCandidates.length} possible ${remainingCandidates.length === 1 ? "match remains" : "matches remain"}.`
          : action === "confirm" ? "Saved record linked." : "Suggestion removed.",
        isError: false
      });
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
        text: claim ? "Item claimed. It is now in Mine." : memberId ? "Row assigned." : "Row assignment cleared.",
        isError: false
      });
      await loadSessionDetail(selectedSessionId, false);
      if (claim) {
        setSessionItemFilter("mine");
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
  const alternateSessionItemFilter = sessionItemFilter === "available"
    ? (sessionItemFilterCounts.mine ? ["mine", "Show mine"] : ["team", "Show others"])
    : sessionItemFilter === "mine"
      ? (sessionItemFilterCounts.available ? ["available", "Show unclaimed"] : ["team", "Show others"])
      : (sessionItemFilterCounts.available ? ["available", "Show unclaimed"] : ["mine", "Show mine"]);
  const sessionReport = useMemo(
    () => selectedSession ? buildSessionReport(selectedSession, detail?.items || []) : null,
    [selectedSession, detail?.items]
  );
  const importBatches = detail?.importBatches || [];
  const importBatchById = useMemo(
    () => new Map(importBatches.map(batch => [batch.id, batch])),
    [importBatches]
  );
  const proofItem = detailItems.find(item => item.id === proofItemId) || null;

  useEffect(() => {
    if (proofItemId && !proofItem) setProofItemId("");
  }, [proofItemId, proofItem]);

  useEffect(() => {
    if (!proofItem && !detailPhotoViewer) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [Boolean(proofItem), Boolean(detailPhotoViewer)]);

  function openFirstPossibleMatch() {
    const first = possibleMatchItems[0];
    if (!first) return;
    if (packetWizardOpen) closePacketWizard();
    setSessionItemFilter(sessionItemAssignmentBucket(first, me));
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-session-item-id="${first.id}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }

  function openProof(itemId) {
    proofTriggerRef.current = document.activeElement;
    setProofItemId(itemId);
  }

  function closeProof() {
    setProofItemId("");
    window.requestAnimationFrame(() => proofTriggerRef.current?.focus?.());
  }

  function openItemPhotoViewer(item, photos, index, submission = null) {
    if (!item || !photos?.length) return;
    detailPhotoTriggerRef.current = document.activeElement;
    setDetailPhotoViewer({
      photos,
      index,
      isZoomed: false,
      packetLine: item.packetLine || itemDisplayName(item),
      sessionName: submission?.sessionName || selectedSession?.name || "Inventory session",
      submittedBy: submission
        ? (submission.submittedByName || submission.submittedByEmail ? submissionPerson(submission) : "Previous inventory")
        : "Saved inventory record",
      createdAt: submission?.createdAt || submission?.inventoriedAt,
      locationText: submission?.locationText || item.inventoryItem?.currentLocation || "",
      serialNumber: submission?.serialNumber || "",
      note: submission?.note || "",
      requestedProof: submission?.reviewState ? applicableProofRequest(item.submissions, submission) : ""
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
  const visibleClosedSessions = closedSessions.slice(0, closedSessionLimit);
  const openCount = openSessions.length;
  const reviewRowCount = openSessions.reduce((total, session) => total + Number(session.needsReviewCount || 0), 0);
  const totalRows = openSessions.reduce((total, session) => total + Number(session.itemCount || 0), 0);
  const resolvedRows = openSessions.reduce((total, session) => total + Number(session.completedCount ?? session.foundCount ?? 0), 0);
  const overallProgress = totalRows ? Math.round((resolvedRows / totalRows) * 100) : 0;

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
              <span>Open rows</span>
            </div>
            <div>
              <strong>{reviewRowCount}</strong>
              <span>Needs review</span>
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
                      {visibleClosedSessions.map(renderSessionButton)}
                      {closedSessions.length > visibleClosedSessions.length ? (
                        <button
                          className="btn btn-secondary btn-small session-archive-more"
                          type="button"
                          onClick={() => setClosedSessionLimit(current => current + 20)}
                        >
                          <span>Show {Math.min(20, closedSessions.length - visibleClosedSessions.length)} more closed sessions</span>
                        </button>
                      ) : null}
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
                  <span className="badge">{selectedSession.foundCount || 0} resolved</span>
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
                            {batch.createdByName || batch.createdByEmail ? ` - uploaded by ${batch.createdByName || batch.createdByEmail}` : ""}
                          </span>
                        </div>
                        <div className="packet-import-history-actions">
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
                  const isRejectedProof = submission?.reviewState === "rejected";
                  const needsMoreProof = submission?.reviewState === "request_more_info" || isRejectedProof;
                  const pendingProof = submission?.reviewState === "pending";
                  const currentUserEmail = String(me?.user?.email || "").trim().toLowerCase();
                  const canWithdrawProof = Boolean(pendingProof && submission && (
                    submission.submittedBy === me?.user?.id
                    || (currentUserEmail && String(submission.submittedByEmail || "").trim().toLowerCase() === currentUserEmail)
                  ));
                  const knownLocation = item.inventoryItem?.currentLocation || "";
                  const assignedName = assignedPerson(item);
                  const assignedToCurrentUser = sessionItemAssignedToUser(item, me);
                  const canClaim = Boolean(canSubmit && !pendingProof && !item.assignedTo && !item.assignedToEmail && !selectedSessionIsClosed);
                  const canSubmitItemProof = Boolean(canSubmit && assignedToCurrentUser);
                  const directCheckAction = directCheckActions.get(item.id) || "";
                  const assignmentAction = assignmentActions.get(item.id) || "";
                  const matchAction = matchActions.get(item.id) || "";
                  const assignedMemberId = item.assignedTo ? assignedMemberIdByUserId.get(item.assignedTo) || "" : "";
                  const importBatch = item.importBatchId ? importBatchById.get(item.importBatchId) || null : null;
                  const priorSnapshot = getPriorInventorySnapshot(item);
                  const leadingPhoto = priorSnapshot?.photos[0] || getInventoryItemPhotos(item.inventoryItem)[0] || null;
                  const isDirectCheckPending = Boolean(directCheckAction);
                  const isAssignmentPending = Boolean(assignmentAction);
                  return (
                    <article className={`session-item ${needsMoreProof ? "needs-response" : ""}`} data-session-item-id={item.id} key={item.id}>
                      <div className="session-item-main">
                        <span className="session-item-leading-thumb">
                          {leadingPhoto ? <ProtectedMediaImage src={leadingPhoto.url} alt="" loading="lazy" /> : <FileText aria-hidden="true" />}
                        </span>
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
                            <small className="session-proof-request">{isRejectedProof ? "Rejected" : "Requested"}: {submission.reviewNote}</small>
                          ) : null}
                          <small className={`session-assignment-summary ${assignedName ? "assigned" : ""}`}>
                            {assignedName ? `Assigned to ${assignedName}` : "Unassigned"}
                          </small>
                        </div>
                      </div>
                      <div className="session-item-actions">
                        <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
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
                        {canWithdrawProof && !selectedSessionIsClosed ? (
                          <button className="btn btn-secondary btn-small session-row-primary-action" type="button" disabled={withdrawingSubmissionId === submission.id} onClick={() => withdrawSubmission(submission)}>
                            <X aria-hidden="true" />
                            <span>{withdrawingSubmissionId === submission.id ? "Withdrawing..." : "Withdraw submission"}</span>
                          </button>
                        ) : pendingProof && canManage && onOpenReview && !selectedSessionIsClosed ? (
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
                      <SessionItemInlineContext
                        item={item}
                        importBatch={importBatch}
                        canManage={canManage}
                        isClosed={selectedSessionIsClosed}
                        assignmentAction={assignmentAction}
                        directCheckAction={directCheckAction}
                        matchAction={matchAction}
                        assignableMembers={assignmentOptions}
                        assignedMemberId={assignedMemberId}
                        onAssign={memberId => updateSessionItemAssignment(item.id, memberId)}
                        onDirectCheck={nextStatus => updateDirectCheck(item.id, nextStatus)}
                        onResolveMatch={action => resolvePriorMatch(item.id, action)}
                        onOpenPriorPhoto={(index, snapshot) => openItemPhotoViewer(item, snapshot.photos, index, snapshot.photoContext || snapshot.history)}
                        onOpenSavedPhoto={index => openItemPhotoViewer(item, getInventoryItemPhotos(item.inventoryItem), index)}
                        onOpenProofPhoto={(proofSubmission, index) => openItemPhotoViewer(item, proofSubmission.photos, index, proofSubmission)}
                      />
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
                    action={query.trim() ? (
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => onQueryChange("")}>Clear search</button>
                    ) : (
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => setSessionItemFilter(alternateSessionItemFilter[0])}>
                        {alternateSessionItemFilter[1]}
                      </button>
                    )}
                  />
                ) : detailItems.length ? null : (
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
                <details className="session-completed-items" open={Boolean(!actionableDetailItems.length || (query.trim() && visibleCompletedItems.length))}>
                  <summary>
                    <span>Completed</span>
                    <strong>{completedDetailItems.length}</strong>
                  </summary>
                  <div className="session-completed-list">
                    {visibleCompletedItems.length ? visibleCompletedItems.map(item => {
                      const importBatch = item.importBatchId ? importBatchById.get(item.importBatchId) || null : null;
                      return (
                      <article className="session-completed-item" key={item.id}>
                        <span>
                          <strong>{itemDisplayName(item)}</strong>
                          <small>{assignedPerson(item) ? `Completed by ${assignedPerson(item)}` : "Completed"}</small>
                        </span>
                        <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                        <SessionItemInlineContext
                          item={item}
                          importBatch={importBatch}
                          canManage={canManage}
                          isClosed
                          assignmentAction=""
                          directCheckAction=""
                          matchAction=""
                          assignableMembers={assignmentOptions}
                          assignedMemberId=""
                          onAssign={() => {}}
                          onDirectCheck={() => {}}
                          onResolveMatch={() => {}}
                          onOpenPriorPhoto={(index, snapshot) => openItemPhotoViewer(item, snapshot.photos, index, snapshot.photoContext || snapshot.history)}
                          onOpenSavedPhoto={index => openItemPhotoViewer(item, getInventoryItemPhotos(item.inventoryItem), index)}
                          onOpenProofPhoto={(proofSubmission, index) => openItemPhotoViewer(item, proofSubmission.photos, index, proofSubmission)}
                        />
                      </article>
                      );
                    }) : (
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

      <SessionProofDialog
        item={proofItem}
        session={selectedSession}
        status={status}
        token={token}
        tenantSlug={tenantSlug}
        onCancel={closeProof}
        onSaved={() => {
          closeProof();
          loadSessions(selectedSessionId);
        }}
        onStatus={setStatus}
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
                        <span>Skipped page text</span>
                        <strong>{packetParseSummary.ignoredCount || 0}</strong>
                        <small>headers and page noise kept out</small>
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
                              <span className="packet-row-number" aria-label={`Packet row ${index + 1}`}>{index + 1}</span>
                              <span
                                className={`packet-confidence ${row.confidence}`}
                                title={`${row.confidence === "high" ? "High" : row.confidence === "medium" ? "Medium" : "Low"} parser confidence. Review the packet text and quantity before importing.`}
                                aria-label={`${row.confidence} parser confidence`}
                              >
                                {row.confidence}
                                <Info aria-hidden="true" />
                              </span>
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
                  resolved
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
          <ProtectedMediaImage src={photo.url} alt="" loading="lazy" />
          <span className="proof-photo-thumbnail-copy">
            <strong>{proofPhotoLabel(photo)}</strong>
            {proofPhotoCaption(photo) !== proofPhotoLabel(photo) ? <small>{proofPhotoCaption(photo)}</small> : null}
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
            <h2 id="proofViewerTitle">{viewer.title || "Evidence photo"}</h2>
            <p id="proofViewerContext">{viewer.packetLine || "Inventory proof"}</p>
          </div>
          <button className="proof-viewer-icon-button" type="button" aria-label="Close evidence viewer" onClick={onClose} autoFocus>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="proof-viewer-content">
          <div className="proof-viewer-stage">
            <div className={`proof-viewer-image-scroll ${viewer.isZoomed ? "zoomed" : ""}`}>
              <ProtectedMediaImage src={photo.url} alt={`${proofPhotoAlt(photo)} for ${viewer.packetLine || "inventory proof"}`} />
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
              <strong>{proofPhotoCaption(photo)}</strong>
            </div>

            <dl className="proof-viewer-facts">
              <div>
                <dt>{viewer.personLabel || "Submitted by"}</dt>
                <dd className={viewer.sourceContextLabel ? "proof-viewer-source-line" : undefined}>
                  <span>{viewer.submittedBy || "Unknown"}</span>
                  {viewer.sourceContextLabel ? <span className="equipment-open-inventory">{viewer.sourceContextLabel}</span> : null}
                </dd>
              </div>
              {viewer.createdAt ? (
                <div>
                  <dt>{viewer.dateLabel || "Submitted"}</dt>
                  <dd>{formatDate(viewer.createdAt)}</dd>
                </div>
              ) : null}
              {viewer.locationText ? (
                <div>
                  <dt>Location</dt>
                  <dd>{viewer.locationText}</dd>
                </div>
              ) : null}
              {hasMeaningfulSerial(viewer.serialNumber) ? (
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
                key={item.id || item.storageKey || item.url || index}
                aria-label={`Show ${proofPhotoAlt(item)}`}
                aria-current={index === viewer.index ? "true" : undefined}
                onClick={() => onSelect(index)}
              >
                <ProtectedMediaImage src={item.url} alt="" loading="lazy" />
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
    .map(photo => ({ ...photo, source: "saved", sourceLabel: "Previous" }));
  const current = (submission?.photos || [])
    .filter(photo => photo.mediaUploadId)
    .map(photo => ({ ...photo, source: "submission", sourceLabel: "This submission" }));
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
  return savedEvidenceChoices(submission)
    .slice(0, 3)
    .map(photo => photo.mediaUploadId);
}

function SavedEvidencePicker({
  submission,
  enabled = false,
  disabled = false,
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
          <small>Reference record</small>
          <strong>Choose photos for next time</strong>
        </span>
        <span className="saved-evidence-count">{enabled ? `${selectedIds.length}/3 selected` : "Optional"}</span>
      </summary>
      <div className="saved-evidence-picker-body">
        <label className="saved-evidence-enable">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={event => onEnabledChange(event.target.checked)}
          />
          <span>
            <strong>Update this item&apos;s reference record</strong>
            <small>Save its approved location, serial when applicable, and zero to three photos teammates should recognize next time.</small>
          </span>
        </label>
        {enabled ? (
          <>
            <div className="saved-evidence-instruction">
              <strong>Select 0 to 3 reference photos</strong>
              <span>Photo selection is optional. Choose only the clearest views you want teammates to recognize in a future inventory.</span>
            </div>
            {choices.length ? (
              <div className="saved-evidence-options" role="group" aria-label="Photos saved for next inventory">
                {choices.map((photo, index) => {
                  const selected = selectedIds.includes(photo.mediaUploadId);
                  return (
                    <label className={`saved-evidence-option ${selected ? "selected" : ""}`} key={photo.mediaUploadId}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        aria-label={`${selected ? "Remove" : "Save"} ${photo.sourceLabel.toLowerCase()} photo ${index + 1}`}
                        onChange={() => onToggle(photo.mediaUploadId)}
                      />
                      <ProtectedMediaImage src={photo.url} alt="" loading="lazy" />
                      <span>{selected ? `Keep - ${photo.sourceLabel}` : photo.sourceLabel}</span>
                      {selected ? <CheckCircle2 aria-hidden="true" /> : null}
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="saved-evidence-empty">No item photos are available. The approved location and serial, when applicable, can still be carried forward.</p>
            )}
            <small>{savedCount ? `${savedCount} previous selected` : "No previous photos selected"}{newCount ? ` - ${newCount} from this submission` : ""}</small>
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
  const [keepRejectedAssignment, setKeepRejectedAssignment] = useState(true);
  const [reviewActions, setReviewActions] = useState(() => new Map());
  const [savedEvidenceBySubmission, setSavedEvidenceBySubmission] = useState({});
  const [saveItemBySubmission, setSaveItemBySubmission] = useState({});
  const [photoViewer, setPhotoViewer] = useState(null);
  const photoViewerTriggerRef = useRef(null);
  const reviewActionRef = useRef(new Map());
  const reviewQueueRequestRef = useRef(0);
  const proofRequestOpenRef = useRef("");
  const hasSearchQuery = searchTerms(query).length > 0;
  const isAnyProofRequestPending = [...reviewActions.values()].includes("reject");
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

  function beginReviewAction(submissionId, action) {
    if (!submissionId || reviewActionRef.current.has(submissionId)) return false;
    reviewActionRef.current.set(submissionId, action);
    setReviewActions(current => {
      const next = new Map(current);
      next.set(submissionId, action);
      return next;
    });
    return true;
  }

  function finishReviewAction(submissionId, action) {
    if (reviewActionRef.current.get(submissionId) !== action) return;
    reviewActionRef.current.delete(submissionId);
    setReviewActions(current => {
      const next = new Map(current);
      if (next.get(submissionId) === action) next.delete(submissionId);
      return next;
    });
  }

  async function loadQueue() {
    const requestId = reviewQueueRequestRef.current + 1;
    reviewQueueRequestRef.current = requestId;
    try {
      setStatus({ text: "Loading review queue...", isError: false });
      const data = await apiRequest("/inventory/review-queue", { token, tenantSlug });
      if (requestId !== reviewQueueRequestRef.current) return false;
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
          const canSaveReference = submission.status === "found"
            && (submission.sessionItem?.expectedQty == null || Number(submission.sessionItem.expectedQty) === 1)
            && !submission.sessionItem?.suggestedInventoryItem;
          next[submission.id] = Object.prototype.hasOwnProperty.call(current, submission.id)
            ? Boolean(current[submission.id])
            : canSaveReference;
        });
        return next;
      });
      setStatus({ text: "", isError: false });
      return true;
    } catch (error) {
      if (requestId === reviewQueueRequestRef.current) {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
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

  async function review(submissionId, decision, note = "", returnAssignment = "unassigned") {
    if (proofRequestOpenRef.current === submissionId && decision !== "rejected") return;
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
    const action = decision === "approved" ? "approve" : "reject";
    if (!beginReviewAction(submissionId, action)) return;
    try {
      setStatus({ text: `${actionLabel === "Approved" ? "Approving" : "Rejecting"} ${packetLine}...`, isError: false });
      await apiRequest(`/submissions/${submissionId}/review`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: {
          decision,
          note,
          ...(decision === "rejected" ? { returnAssignment } : {}),
          saveItem: shouldSaveItem,
          savedMediaUploadIds: shouldSaveItem ? (savedEvidenceBySubmission[submissionId] || []) : undefined
        }
      });
      await loadQueue();
      setStatus({ text: `${actionLabel} proof for ${packetLine}.`, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishReviewAction(submissionId, action);
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
    const submissionId = submission?.id;
    const pendingAction = `match-${action}`;
    if (!sessionItemId || proofRequestOpenRef.current === submissionId || !beginReviewAction(submissionId, pendingAction)) return;
    try {
      setStatus({ text: action === "confirm" ? "Linking the saved record..." : "Removing the suggested match...", isError: false });
      await apiRequest(`/session-items/${sessionItemId}/inventory-match`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { action }
      });
      setSavedEvidenceBySubmission(current => {
        const next = { ...current };
        delete next[submissionId];
        return next;
      });
      await loadQueue();
      setStatus({ text: action === "confirm" ? "Saved record linked. Review can continue." : "Suggestion removed. Review can continue.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishReviewAction(submissionId, pendingAction);
    }
  }

  function openProofRequest(submission) {
    if (proofRequestOpenRef.current || [...reviewActionRef.current.values()].includes("reject") || reviewActionRef.current.has(submission.id)) return;
    proofRequestOpenRef.current = submission.id;
    setRequestingSubmissionId(submission.id);
    setProofRequestFields([]);
    setProofRequestMessage("");
    setKeepRejectedAssignment(true);
  }

  async function sendProofRequest(e) {
    e.preventDefault();
    const submissionId = requestingSubmissionId;
    const message = proofRequestMessage.trim();
    if (!submissionId || message.length < 2) {
      setStatus({ text: "Add a short reason so the submitter knows what to fix.", isError: true });
      return;
    }
    proofRequestOpenRef.current = "";
    setRequestingSubmissionId("");
    setProofRequestMessage("");
    setProofRequestFields([]);
    await review(submissionId, "rejected", message, keepRejectedAssignment ? "submitter" : "unassigned");
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
          <article className={`review-card ${isAccountabilityNoteEvidence(submission) ? "accountability-note-only" : ""}`} key={submission.id}>
            <div className="review-card-main">
              <strong>{submission.sessionItem?.packetLine || "Packet row"}</strong>
              <span>{submission.session?.name} - {submission.submittedByName || submission.submittedByEmail}</span>
              {submission.locationText ? <small>Location: {submission.locationText}</small> : null}
              {hasMeaningfulSerial(submission.serialNumber) ? <small>Serial: {submission.serialNumber}</small> : null}
              {submission.note ? <small>{submission.note}</small> : null}
              {submission.reviewState === "request_more_info" && submission.reviewNote ? (
                <small className="review-request-note">Requested: {submission.reviewNote}</small>
              ) : null}
            </div>

            {isAccountabilityNoteEvidence(submission) ? (
              <div className="accountability-evidence-label" role="note">
                <ShieldCheck aria-hidden="true" />
                <span><strong>Accountability note</strong>No photo was available; review the verifier and status above.</span>
              </div>
            ) : null}

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
                          {hasMeaningfulSerial(historyItem.serialNumber) ? <span>SN {historyItem.serialNumber}</span> : null}
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
                action={requestingSubmissionId === submission.id
                  ? "request-open"
                  : String(reviewActions.get(submission.id) || "").replace(/^match-/, "")}
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
                  disabled={Boolean(reviewActions.get(submission.id)) || requestingSubmissionId === submission.id}
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
                disabled={Boolean(reviewActions.get(submission.id)) || requestingSubmissionId === submission.id || Boolean(submission.sessionItem?.suggestedInventoryItem)}
                onClick={() => review(submission.id, "approved")}
              >
                <CheckCircle2 aria-hidden="true" />
                <span>{reviewActions.get(submission.id) === "approve" ? "Approving..." : submission.sessionItem?.suggestedInventoryItem ? "Check match first" : "Approve"}</span>
              </button>
              <button
                className="btn btn-danger-soft btn-small"
                type="button"
                disabled={Boolean(reviewActions.get(submission.id)) || Boolean(requestingSubmissionId) || isAnyProofRequestPending}
                onClick={() => openProofRequest(submission)}
              >
                <XCircle aria-hidden="true" />
                <span>{requestingSubmissionId === submission.id ? "Reason open" : "Reject"}</span>
              </button>
            </div>

            {requestingSubmissionId === submission.id ? (
              <form className="proof-request-form" onSubmit={sendProofRequest}>
                <label className="field-label" htmlFor={`proofRequest-${submission.id}`}>Reason for rejection</label>
                <textarea
                  id={`proofRequest-${submission.id}`}
                  className="input proof-request-note"
                  value={proofRequestMessage}
                  placeholder="Explain what is wrong or what evidence should be resubmitted."
                  disabled={reviewActions.get(submission.id) === "reject"}
                  onChange={e => setProofRequestMessage(e.target.value)}
                />
                <label className="proof-return-assignment">
                  <input type="checkbox" checked={keepRejectedAssignment} disabled={reviewActions.get(submission.id) === "reject"} onChange={event => setKeepRejectedAssignment(event.target.checked)} />
                  <span>
                    <strong>Keep assigned to the submitter</strong>
                    <small>Turn this off to return the item to the unclaimed queue.</small>
                  </span>
                </label>
                <div className="button-row">
                  <button className="btn btn-danger-soft btn-small" type="submit" disabled={reviewActions.get(submission.id) === "reject"}>
                    <XCircle aria-hidden="true" />
                    <span>{reviewActions.get(submission.id) === "reject" ? "Rejecting..." : "Reject with reason"}</span>
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    type="button"
                    disabled={reviewActions.get(submission.id) === "reject"}
                    onClick={() => {
                      if (reviewActionRef.current.has(submission.id)) return;
                      proofRequestOpenRef.current = "";
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
  const isMobileViewport = useMediaQuery("(max-width: 860px)");
  const [issues, setIssues] = useState([]);
  const [contentBlocks, setContentBlocks] = useState([]);
  const [subscribers, setSubscribers] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [subscriberStats, setSubscriberStats] = useState({ pending: 0, active: 0, rejected: 0, unsubscribed: 0, total: 0 });
  const [deliverySettings, setDeliverySettings] = useState({ emailConfigured: false });
  const [activeSection, setActiveSection] = useState(() => newsletterSectionFromLocation());
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedContentBlockId, setSelectedContentBlockId] = useState("");
  const [isContentEditorOpen, setIsContentEditorOpen] = useState(false);
  const [isIssueEditorOpen, setIsIssueEditorOpen] = useState(false);
  const [selectedSubscriberId, setSelectedSubscriberId] = useState("");
  const [form, setForm] = useState(() => newsletterIssueForm());
  const [contentForm, setContentForm] = useState(() => frgContentForm());
  const [testEmail, setTestEmail] = useState(() => {
    const candidate = String(me?.identity?.email || me?.user?.email || "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
  });
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [contentTypeFilter, setContentTypeFilter] = useState("all");
  const [subscriberQuery, setSubscriberQuery] = useState("");
  const [subscriberStatusFilter, setSubscriberStatusFilter] = useState("pending");
  const [reviewNotes, setReviewNotes] = useState({});
  const [status, setStatus] = useState({ text: "Loading newsletter...", isError: false });
  const [newsletterLoadState, setNewsletterLoadState] = useState("loading");
  const [actionStatus, setActionStatus] = useState({ scope: "", text: "", isError: false });
  const [newsletterActions, setNewsletterActions] = useState(() => new Map());
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const newsletterActionRef = useRef(new Map());
  const newsletterLoadRequestRef = useRef(0);
  const contentTitleRef = useRef(null);
  const issueTitleRef = useRef(null);
  const mobileNavToggleRef = useRef(null);
  const mobileNavCloseRef = useRef(null);
  const roleLabel = me?.isPlatformAdmin ? "Super administrator" : "Newsletter admin";
  const selectedIssue = issues.find(issue => issue.id === selectedIssueId) || null;
  const selectedContentBlock = contentBlocks.find(block => block.id === selectedContentBlockId) || null;
  const selectedSubscriber = subscribers.find(subscriber => subscriber.id === selectedSubscriberId) || null;
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
  const contentAction = newsletterActions.get("content") || "";
  const issueAction = newsletterActions.get("issue") || "";
  const refreshAction = newsletterActions.get("refresh") || "";
  const hasNewsletterAction = newsletterActions.size > 0;
  const hasContentFilters = Boolean(contentQuery.trim()) || contentTypeFilter !== "all";
  const hasIssueSearch = Boolean(query.trim());
  const hasSubscriberFilters = Boolean(subscriberQuery.trim()) || subscriberStatusFilter !== "all";

  function beginNewsletterAction(scope, action) {
    if (!scope || newsletterActionRef.current.has(scope)) return false;
    if (scope === "refresh" && newsletterActionRef.current.size) return false;
    if (scope !== "refresh" && newsletterActionRef.current.has("refresh")) return false;
    newsletterActionRef.current.set(scope, action);
    setNewsletterActions(current => {
      const next = new Map(current);
      next.set(scope, action);
      return next;
    });
    return true;
  }

  function finishNewsletterAction(scope, action) {
    if (newsletterActionRef.current.get(scope) !== action) return;
    newsletterActionRef.current.delete(scope);
    setNewsletterActions(current => {
      const next = new Map(current);
      if (next.get(scope) === action) next.delete(scope);
      return next;
    });
  }

  function showActionStatus(scope, text, isError = false) {
    setActionStatus({ scope, text, isError });
  }

  async function loadNewsletter({
    quiet = false,
    preferredContentBlockId = selectedContentBlockId,
    preferredIssueId = selectedIssueId
  } = {}) {
    const requestId = newsletterLoadRequestRef.current + 1;
    newsletterLoadRequestRef.current = requestId;
    try {
      if (!quiet) {
        setNewsletterLoadState(current => current === "ready" ? current : "loading");
        setStatus({ text: "Loading newsletter...", isError: false });
      }
      const data = await apiRequest("/newsletter/admin", { token });
      if (requestId !== newsletterLoadRequestRef.current) return { ok: false, stale: true };
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
      setNewsletterLoadState("ready");

      const hasSelectedContentBlock = preferredContentBlockId && nextContentBlocks.some(block => block.id === preferredContentBlockId);
      if (!hasSelectedContentBlock) {
        const firstBlock = nextContentBlocks[0] || null;
        setSelectedContentBlockId(firstBlock?.id || "");
        setContentForm(frgContentForm(firstBlock || frgContentTemplate));
      } else if (preferredContentBlockId !== selectedContentBlockId) {
        setSelectedContentBlockId(preferredContentBlockId);
      }

      const hasSelectedIssue = preferredIssueId && nextIssues.some(issue => issue.id === preferredIssueId);
      if (!hasSelectedIssue) {
        const firstIssue = nextIssues[0] || null;
        setSelectedIssueId(firstIssue?.id || "");
        setForm(newsletterIssueForm(firstIssue || newsletterDraftTemplate));
      } else if (preferredIssueId !== selectedIssueId) {
        setSelectedIssueId(preferredIssueId);
      }

      if (!quiet) setStatus({ text: "", isError: false });
      return { ok: true };
    } catch (error) {
      if (requestId !== newsletterLoadRequestRef.current) return { ok: false, stale: true };
      if (!quiet) {
        setNewsletterLoadState(current => current === "ready" ? current : "error");
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return { ok: false, error };
    }
  }

  useEffect(() => {
    loadNewsletter({ quiet: newsletterLoadState === "ready" });
  }, [token]);

  useEffect(() => {
    const syncSectionFromLocation = () => setActiveSection(newsletterSectionFromLocation());
    window.addEventListener("hashchange", syncSectionFromLocation);
    window.addEventListener("popstate", syncSectionFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncSectionFromLocation);
      window.removeEventListener("popstate", syncSectionFromLocation);
    };
  }, []);

  useEffect(() => {
    if (!isMobileNavOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeNewsletterNav();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobileNavOpen, isMobileViewport]);

  useEffect(() => {
    if (!isContentEditorOpen && !isIssueEditorOpen && !selectedSubscriberId) return undefined;

    function handleDialogKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (isContentEditorOpen) closeContentEditor();
      if (isIssueEditorOpen) closeIssueEditor();
      if (selectedSubscriberId) closeSubscriberDetails();
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDialogKeyDown);
  }, [isContentEditorOpen, isIssueEditorOpen, selectedSubscriberId, contentAction, issueAction, newsletterActions]);

  function updateForm(key, value) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function updateContentForm(key, value) {
    setContentForm(current => ({ ...current, [key]: value }));
  }

  function selectNewsletterSection(section) {
    if (newsletterActionRef.current.size) return;
    setActiveSection(section);
    navigateAppHash(newsletterSectionHashes[section] || newsletterSectionHashes.overview);
    setActionStatus({ scope: "", text: "", isError: false });
    setStatus({ text: "", isError: false });
    closeNewsletterNav();
  }

  function openNewsletterNav() {
    setIsMobileNavOpen(true);
    window.requestAnimationFrame(() => mobileNavCloseRef.current?.focus());
  }

  function closeNewsletterNav(restoreFocus = true) {
    setIsMobileNavOpen(false);
    if (restoreFocus && isMobileViewport) {
      window.requestAnimationFrame(() => mobileNavToggleRef.current?.focus());
    }
  }

  function selectContentBlock(block) {
    if (newsletterActionRef.current.size) return;
    setSelectedContentBlockId(block.id);
    setContentForm(frgContentForm(block));
    setIsContentEditorOpen(true);
    setActionStatus(current => current.scope === "content" ? { scope: "", text: "", isError: false } : current);
    setStatus({ text: "", isError: false });
    if (isMobileViewport) {
      window.requestAnimationFrame(() => contentTitleRef.current?.focus());
    }
  }

  function startNewContentBlock() {
    if (newsletterActionRef.current.size) return;
    setSelectedContentBlockId("");
    setContentForm(frgContentForm());
    setIsContentEditorOpen(true);
    setActionStatus(current => current.scope === "content" ? { scope: "", text: "", isError: false } : current);
    setStatus({ text: "New homepage update ready.", isError: false });
    window.requestAnimationFrame(() => contentTitleRef.current?.focus());
  }

  function selectIssue(issue) {
    if (newsletterActionRef.current.size) return;
    setSelectedIssueId(issue.id);
    setForm(newsletterIssueForm(issue));
    setIsIssueEditorOpen(true);
    setActionStatus(current => current.scope === "issue" ? { scope: "", text: "", isError: false } : current);
    setStatus({ text: "", isError: false });
    if (isMobileViewport) {
      window.requestAnimationFrame(() => issueTitleRef.current?.focus());
    }
  }

  function startNewDraft() {
    if (newsletterActionRef.current.size) return;
    setSelectedIssueId("");
    setForm(newsletterIssueForm());
    setIsIssueEditorOpen(true);
    setActionStatus(current => current.scope === "issue" ? { scope: "", text: "", isError: false } : current);
    setStatus({ text: "New newsletter draft ready.", isError: false });
    window.requestAnimationFrame(() => issueTitleRef.current?.focus());
  }

  function clearContentFilters() {
    setContentQuery("");
    setContentTypeFilter("all");
  }

  function clearIssueSearch() {
    setQuery("");
  }

  function clearSubscriberFilters() {
    setSubscriberQuery("");
    setSubscriberStatusFilter("all");
  }

  function showSubscribers(statusFilter = "all") {
    if (newsletterActionRef.current.size) return;
    setSubscriberStatusFilter(statusFilter);
    setSubscriberQuery("");
    setActiveSection("subscribers");
    navigateAppHash(newsletterSectionHashes.subscribers);
    closeNewsletterNav();
  }

  function closeContentEditor() {
    if (contentAction) return;
    setIsContentEditorOpen(false);
  }

  function closeIssueEditor() {
    if (issueAction) return;
    setIsIssueEditorOpen(false);
  }

  function closeSubscriberDetails() {
    if (selectedSubscriberId && newsletterActions.get(`subscriber:${selectedSubscriberId}`)) return;
    setSelectedSubscriberId("");
  }

  async function saveContentBlock(event) {
    event.preventDefault();
    const scope = "content";
    const action = "save";
    if (!beginNewsletterAction(scope, action)) return;
    const contentBlockId = selectedContentBlockId;
    showActionStatus(scope, contentBlockId ? "Saving homepage update..." : "Creating homepage update...");
    setStatus({ text: "", isError: false });
    try {
      const payload = frgContentPayload(contentForm);
      const data = await apiRequest(
        contentBlockId ? `/newsletter/admin/content-blocks/${contentBlockId}` : "/newsletter/admin/content-blocks",
        {
          method: contentBlockId ? "PATCH" : "POST",
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
      const refreshed = await loadNewsletter({ quiet: true, preferredContentBlockId: savedBlock.id });
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus(scope, `${savedBlock.status === "published" ? "Published" : "Saved"}, but the latest list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus(scope, savedBlock.status === "published" ? "Public content published." : "Public content saved.");
      }
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  async function deleteContentBlock() {
    if (!selectedContentBlockId) return;
    const scope = "content";
    const action = "delete";
    if (!beginNewsletterAction(scope, action)) return;
    const contentBlockId = selectedContentBlockId;
    showActionStatus(scope, "Removing homepage update...");
    setStatus({ text: "", isError: false });
    try {
      await apiRequest(`/newsletter/admin/content-blocks/${contentBlockId}`, {
        method: "DELETE",
        token
      });
      setContentBlocks(current => current.filter(block => block.id !== contentBlockId));
      setSelectedContentBlockId("");
      setContentForm(frgContentForm());
      setIsContentEditorOpen(false);
      const refreshed = await loadNewsletter({ quiet: true, preferredContentBlockId: "" });
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus(scope, `Homepage update removed, but the latest list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus(scope, "Public content removed.");
      }
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
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
    const scope = "issue";
    const action = "save";
    if (!beginNewsletterAction(scope, action)) return;
    const issueId = selectedIssueId;
    showActionStatus(scope, issueId ? "Saving issue..." : "Creating draft...");
    setStatus({ text: "", isError: false });
    try {
      const payload = newsletterPayload(form);
      const data = await apiRequest(
        issueId ? `/newsletter/admin/issues/${issueId}` : "/newsletter/admin/issues",
        {
          method: issueId ? "PATCH" : "POST",
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
      showActionStatus(scope, issueId ? "Newsletter issue saved." : "Draft created.");
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  async function publishIssue() {
    if (!selectedIssueId) {
      showActionStatus("issue", "Save the draft before publishing.", true);
      return;
    }
    if (selectedIssue?.status === "published") {
      showActionStatus("issue", "This issue is already published. No additional email was sent.");
      return;
    }

    const scope = "issue";
    const action = "publish";
    if (!beginNewsletterAction(scope, action)) return;
    const issueId = selectedIssueId;
    showActionStatus(scope, "Publishing issue...");
    setStatus({ text: "", isError: false });
    try {
      const data = await apiRequest(`/newsletter/admin/issues/${issueId}/publish`, {
        method: "POST",
        token
      });
      const publishedIssue = data.issue;
      const delivery = data.delivery || {};
      setIssues(current => current.map(issue => issue.id === publishedIssue.id ? publishedIssue : issue));
      setForm(newsletterIssueForm(publishedIssue));
      const refreshed = await loadNewsletter({ quiet: true, preferredIssueId: publishedIssue.id });
      const resultText = data.alreadyPublished
        ? "This issue was already published. No additional email was sent."
        : `Published. Delivered ${delivery.sent || 0}, skipped ${delivery.skipped || 0}, failed ${delivery.failed || 0}.`;
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus(scope, `${resultText} The latest delivery list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus(scope, resultText);
      }
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  async function deleteIssue() {
    if (!selectedIssueId) return;
    const scope = "issue";
    const action = "delete";
    if (!beginNewsletterAction(scope, action)) return;
    const issueId = selectedIssueId;
    showActionStatus(scope, "Deleting newsletter issue...");
    setStatus({ text: "", isError: false });
    try {
      const data = await apiRequest(`/newsletter/admin/issues/${issueId}`, {
        method: "DELETE",
        token
      });
      setIssues(current => current.filter(issue => issue.id !== issueId));
      setDeliveries(current => current.filter(delivery => delivery.issueId !== issueId));
      setSelectedIssueId("");
      setForm(newsletterIssueForm());
      setIsIssueEditorOpen(false);
      const refreshed = await loadNewsletter({ quiet: true, preferredIssueId: "" });
      const deliveryText = data.deletedDeliveries
        ? ` ${data.deletedDeliveries} delivery record${data.deletedDeliveries === 1 ? "" : "s"} removed.`
        : "";
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus(scope, `Newsletter issue deleted.${deliveryText} The latest list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus(scope, `Newsletter issue deleted.${deliveryText}`);
      }
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  async function sendTestIssue() {
    if (!selectedIssueId) {
      showActionStatus("issue", "Save the issue before sending a test.", true);
      return;
    }

    const email = testEmail.trim();
    if (!email) {
      showActionStatus("issue", "Enter a test email address.", true);
      return;
    }

    const scope = "issue";
    const action = "test";
    if (!beginNewsletterAction(scope, action)) return;
    const issueId = selectedIssueId;
    showActionStatus(scope, "Sending test email...");
    setStatus({ text: "", isError: false });
    try {
      const data = await apiRequest(`/newsletter/admin/issues/${issueId}/test-send`, {
        method: "POST",
        token,
        body: { email }
      });
      const result = data.testSend || {};
      showActionStatus(
        scope,
        result.sent
          ? `Test email sent to ${data.email || email}.`
          : `Test email was not sent: ${result.reason || result.error || "delivery unavailable"}.`,
        !result.sent && result.reason !== "smtp_not_configured"
      );
    } catch (error) {
      showActionStatus(scope, getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
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
    const scope = `subscriber:${subscriberId}`;
    if (!beginNewsletterAction(scope, decision)) return;
    const subscriber = subscribers.find(item => item.id === subscriberId);
    const subscriberLabel = subscriber?.displayName || subscriber?.email || "Subscriber";
    showActionStatus("subscribers", `${decision === "approved" ? "Approving" : "Rejecting"} ${subscriberLabel}...`);
    setStatus({ text: "", isError: false });
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
      const refreshed = await loadNewsletter({ quiet: true });
      const resultText = `${subscriberLabel} ${decision === "approved" ? "was approved for newsletter delivery." : "was rejected."}${notificationStatusText(data.notification)}`;
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus("subscribers", `${resultText} The latest subscriber list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus("subscribers", resultText);
      }
    } catch (error) {
      showActionStatus("subscribers", getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, decision);
    }
  }

  async function removeSubscriber(subscriberId) {
    const scope = `subscriber:${subscriberId}`;
    const action = "remove";
    if (!beginNewsletterAction(scope, action)) return;
    const subscriber = subscribers.find(item => item.id === subscriberId);
    const subscriberLabel = subscriber?.displayName || subscriber?.email || "Subscriber";
    showActionStatus("subscribers", `Removing ${subscriberLabel} from newsletter delivery...`);
    setStatus({ text: "", isError: false });
    try {
      const data = await apiRequest(`/newsletter/admin/subscribers/${subscriberId}/remove`, {
        method: "POST",
        token
      });
      if (data.subscriber) {
        setSubscribers(current => current.map(item => item.id === subscriberId ? data.subscriber : item));
      }
      const refreshed = await loadNewsletter({ quiet: true });
      if (!refreshed.ok && !refreshed.stale) {
        showActionStatus("subscribers", `${subscriberLabel} was removed from delivery, but the latest list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, true);
      } else {
        showActionStatus("subscribers", `${subscriberLabel} was removed from newsletter delivery. Their audit history was kept.`);
      }
    } catch (error) {
      showActionStatus("subscribers", getApiErrorMessage(error), true);
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  async function refreshNewsletter() {
    const scope = "refresh";
    const action = "refresh";
    if (!beginNewsletterAction(scope, action)) return;
    setActionStatus({ scope: "", text: "", isError: false });
    try {
      const result = await loadNewsletter();
      if (result.ok) {
        setStatus({ text: "Newsletter refreshed.", isError: false });
        onRefresh?.();
      }
    } finally {
      finishNewsletterAction(scope, action);
    }
  }

  const sectionMeta = {
    overview: {
      title: "Newsletter",
      copy: "Choose what you want to manage: the public homepage, newsletter issues, or subscribers."
    },
    issues: {
      title: "Newsletter issues",
      copy: "Create, review, and publish Black Shadow Company updates."
    },
    subscribers: {
      title: "Subscribers",
      copy: "Review signup requests and manage the approved audience."
    },
    analytics: {
      title: "Delivery analytics",
      copy: "Review delivery results and export the newsletter delivery record."
    }
  };
  const activeMeta = sectionMeta[activeSection] || sectionMeta.overview;
  const publishedContentCount = contentBlocks.filter(block => block.status === "published").length;
  const isEmailConfigured = Boolean(deliverySettings.emailConfigured);
  const subscriberEmptyTitle = subscribers.length
    ? !subscriberQuery.trim() && subscriberStatusFilter === "pending"
      ? "No pending requests"
      : "No matching subscribers"
    : "No subscribers yet";
  const subscriberEmptyBody = subscribers.length
    ? !subscriberQuery.trim() && subscriberStatusFilter === "pending"
      ? "There are no signup requests waiting for review."
      : "Clear the search and status filter to see every subscriber."
    : "People can request newsletter access from the public signup form.";

  return (
    <div className={`platform-shell newsletter-shell ${isMobileNavOpen ? "platform-nav-open" : ""}`}>
      <button className="platform-sidebar-backdrop" type="button" aria-label="Close newsletter menu" onClick={() => closeNewsletterNav()} />
      <aside className="platform-sidebar newsletter-sidebar" aria-hidden={isMobileViewport && !isMobileNavOpen ? "true" : undefined} inert={isMobileViewport && !isMobileNavOpen ? true : undefined}>
        <div className="platform-brand">
          <MailPlus aria-hidden="true" />
          <strong>FRG Newsletter</strong>
          <button ref={mobileNavCloseRef} className="platform-mobile-nav-close" type="button" aria-label="Close newsletter menu" onClick={() => closeNewsletterNav()}>
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="platform-nav" aria-label="Newsletter admin">
          <button className={activeSection === "overview" ? "active" : ""} type="button" disabled={hasNewsletterAction} onClick={() => selectNewsletterSection("overview")}>
            <Home aria-hidden="true" />
            <span>Overview</span>
          </button>
          <button className={activeSection === "issues" ? "active" : ""} type="button" disabled={hasNewsletterAction} onClick={() => selectNewsletterSection("issues")}>
            <FileText aria-hidden="true" />
            <span>Issues</span>
          </button>
          <button className={activeSection === "subscribers" ? "active" : ""} type="button" disabled={hasNewsletterAction} onClick={() => selectNewsletterSection("subscribers")}>
            <Users aria-hidden="true" />
            <span>Subscribers</span>
          </button>
          <button className={activeSection === "analytics" ? "active" : ""} type="button" disabled={hasNewsletterAction} onClick={() => selectNewsletterSection("analytics")}>
            <BarChart3 aria-hidden="true" />
            <span>Analytics</span>
          </button>
          {me?.isPlatformAdmin ? (
            <button type="button" onClick={() => navigateAppHash(platformViewHashes.dashboard)}>
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
          <button type="button" disabled={hasNewsletterAction} onClick={refreshNewsletter}>
            <RefreshCw aria-hidden="true" />
            <span>{refreshAction ? "Refreshing..." : "Refresh"}</span>
          </button>
          <button type="button" onClick={onLogout}>
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="platform-main">
        <header className="platform-topbar">
          <div className="newsletter-topbar-leading">
            <button
              ref={mobileNavToggleRef}
              className="platform-mobile-nav-toggle"
              type="button"
              aria-label="Open newsletter menu"
              aria-expanded={isMobileNavOpen}
              onClick={openNewsletterNav}
            >
              <Menu aria-hidden="true" />
            </button>
            <strong className="platform-mobile-title">FRG Newsletter</strong>
          </div>
          <div className="leader-user-actions">
            <button className="icon-button platform-topbar-refresh" type="button" disabled={hasNewsletterAction} onClick={refreshNewsletter} aria-label={refreshAction ? "Refreshing newsletter" : "Refresh newsletter"}>
              <RefreshCw aria-hidden="true" />
            </button>
            {isMobileViewport ? (
              <button
                className="leader-user-card leader-user-trigger newsletter-user-card"
                type="button"
                aria-label="Open newsletter account actions"
                aria-expanded={isMobileNavOpen}
                onClick={openNewsletterNav}
              >
                <span className="leader-avatar">{String(me?.user?.display_name || me?.user?.email || "N").slice(0, 1).toUpperCase()}</span>
              </button>
            ) : (
              <div className="leader-user-card newsletter-user-card">
                <span className="leader-avatar">{String(me?.user?.display_name || me?.user?.email || "N").slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{me?.user?.display_name || me?.user?.email || "Newsletter user"}</strong>
                  <span>{roleLabel}</span>
                </div>
              </div>
            )}
            <button className="btn btn-secondary btn-small platform-topbar-signout" type="button" onClick={onLogout}>
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
              {activeSection !== "overview" ? (
                <span className={`newsletter-delivery-status ${isEmailConfigured ? "ready" : "offline"}`} title={isEmailConfigured ? "Newsletter email delivery is configured." : "Newsletter email delivery is not configured in this environment."}>
                  <MailPlus aria-hidden="true" />
                  <span>{isEmailConfigured ? "Email ready" : "Email offline"}</span>
                </span>
              ) : null}
              {activeSection === "overview" ? (
                <a className="btn btn-secondary" href={`https://${appConfig.baseDomain}/`} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  <span>Preview homepage</span>
                </a>
              ) : null}
              {activeSection === "issues" ? (
                <button className="btn btn-primary" type="button" disabled={newsletterLoadState !== "ready" || Boolean(issueAction)} onClick={startNewDraft}>
                  <Plus aria-hidden="true" />
                  <span>Create issue</span>
                </button>
              ) : null}
              {activeSection === "subscribers" ? (
                <button className="btn btn-secondary" type="button" onClick={exportSubscribers} disabled={!subscribers.length}>
                  <Download aria-hidden="true" />
                  <span>Export subscribers</span>
                </button>
              ) : null}
              {activeSection === "analytics" ? (
                <button className="btn btn-secondary" type="button" onClick={exportDeliveries} disabled={!deliveries.length}>
                  <Download aria-hidden="true" />
                  <span>Export deliveries</span>
                </button>
              ) : null}
            </div>
          </div>

          <StatusLine status={status} />

          {newsletterLoadState !== "ready" ? (
            <section className="platform-table-card newsletter-load-card" aria-live="polite">
              <EmptyPanel
                title={newsletterLoadState === "error" ? "Newsletter could not load" : "Loading newsletter"}
                body={newsletterLoadState === "error"
                  ? "Try again before editing content, issues, or subscriber requests."
                  : "Fetching the latest content, issues, subscribers, and delivery history."}
                action={newsletterLoadState === "error" ? (
                  <button className="btn btn-primary" type="button" disabled={hasNewsletterAction} onClick={refreshNewsletter}>
                    <RefreshCw aria-hidden="true" />
                    <span>Try again</span>
                  </button>
                ) : null}
              />
            </section>
          ) : null}

          {newsletterLoadState === "ready" && activeSection === "issues" && !isEmailConfigured ? (
            <div className="newsletter-delivery-note newsletter-delivery-note-inline" role="note">
              <MailPlus aria-hidden="true" />
              <span>Email delivery is not configured in this environment. You can still write, test the layout, and save issues; live sending will be skipped.</span>
            </div>
          ) : null}

          {newsletterLoadState === "ready" && (activeSection === "overview" || activeSection === "issues") ? (
            <section className="platform-stat-grid newsletter-stat-grid newsletter-subscriber-summary" aria-label="Subscriber requests">
              <button className="platform-stat-card newsletter-stat-link" type="button" onClick={() => showSubscribers("pending")}>
                <span className="platform-stat-icon blue"><ShieldCheck aria-hidden="true" /></span>
                <div>
                  <strong>{subscriberStats.pending || 0}</strong>
                  <span>Pending requests</span>
                </div>
                <ArrowRight aria-hidden="true" />
              </button>
              <button className="platform-stat-card newsletter-stat-link" type="button" onClick={() => showSubscribers("active")}>
                <span className="platform-stat-icon green"><Users aria-hidden="true" /></span>
                <div>
                  <strong>{subscriberStats.active || 0}</strong>
                  <span>Approved subscribers</span>
                </div>
                <ArrowRight aria-hidden="true" />
              </button>
            </section>
          ) : null}

          {newsletterLoadState === "ready" && activeSection === "overview" ? (
            <section className="newsletter-overview-grid" aria-label="Newsletter management">
              <article className="platform-table-card newsletter-overview-card">
                <span className="newsletter-overview-icon blue"><Megaphone aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">Public homepage</p>
                  <h2>Homepage updates</h2>
                  <p>Preview what visitors see or update the announcements, events, and resources shown on the public site.</p>
                </div>
                <dl className="newsletter-overview-facts">
                  <div><dt>Published</dt><dd>{publishedContentCount}</dd></div>
                  <div><dt>Drafts</dt><dd>{Math.max(0, contentBlocks.length - publishedContentCount)}</dd></div>
                </dl>
                <div className="button-row">
                  <a className="btn btn-secondary" href={`https://${appConfig.baseDomain}/`} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    <span>Preview homepage</span>
                  </a>
                  <button className="btn btn-primary" type="button" onClick={() => selectedContentBlock ? selectContentBlock(selectedContentBlock) : startNewContentBlock()}>
                    <FileText aria-hidden="true" />
                    <span>Update homepage</span>
                  </button>
                </div>
              </article>

              <article className="platform-table-card newsletter-overview-card">
                <span className="newsletter-overview-icon green"><MailPlus aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">Email newsletter</p>
                  <h2>Newsletter issues</h2>
                  <p>Manage previous issues, prepare the next update, and publish it to approved subscribers.</p>
                </div>
                <dl className="newsletter-overview-facts">
                  <div><dt>Total issues</dt><dd>{issues.length}</dd></div>
                  <div><dt>Published</dt><dd>{issues.filter(issue => issue.status === "published").length}</dd></div>
                </dl>
                <div className="button-row">
                  <button className="btn btn-secondary" type="button" onClick={() => selectNewsletterSection("issues")}>
                    <ListChecks aria-hidden="true" />
                    <span>Manage issues</span>
                  </button>
                  <button className="btn btn-primary" type="button" onClick={startNewDraft}>
                    <Plus aria-hidden="true" />
                    <span>Create issue</span>
                  </button>
                </div>
              </article>

              <article className="platform-table-card newsletter-overview-card newsletter-overview-card-wide">
                <span className="newsletter-overview-icon purple"><Users aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow">Audience</p>
                  <h2>Subscribers</h2>
                  <p>Review pending signup requests and audit the people currently approved to receive issues.</p>
                </div>
                <dl className="newsletter-overview-facts">
                  <div><dt>Pending</dt><dd>{subscriberStats.pending || 0}</dd></div>
                  <div><dt>Approved</dt><dd>{subscriberStats.active || 0}</dd></div>
                </dl>
                <div className="button-row">
                  <button className="btn btn-primary" type="button" onClick={() => showSubscribers("all")}>
                    <Users aria-hidden="true" />
                    <span>Manage subscribers</span>
                  </button>
                </div>
              </article>
            </section>
          ) : null}

          {newsletterLoadState === "ready" && isContentEditorOpen ? (
            <div className="modal-backdrop newsletter-modal-backdrop" role="presentation" onMouseDown={event => {
              if (event.target === event.currentTarget) closeContentEditor();
            }}>
              <div className="modal-panel newsletter-management-modal" role="dialog" aria-modal="true" aria-labelledby="homepageEditorTitle">
                <div className="newsletter-modal-heading">
                  <div>
                    <p className="eyebrow">Public homepage</p>
                    <h2 id="homepageEditorTitle">Manage homepage updates</h2>
                  </div>
                  <button className="icon-button" type="button" aria-label="Close homepage editor" disabled={Boolean(contentAction)} onClick={closeContentEditor}>
                    <X aria-hidden="true" />
                  </button>
                </div>
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
                  <button className="btn btn-primary btn-small" type="button" disabled={Boolean(contentAction)} onClick={startNewContentBlock}>
                    <Plus aria-hidden="true" />
                    <span>New update</span>
                  </button>
                </div>

                <div className="newsletter-issue-list frg-content-list">
                  {filteredContentBlocks.length ? filteredContentBlocks.map(block => (
                    <button
                      className={block.id === selectedContentBlockId ? "newsletter-issue-button active" : "newsletter-issue-button"}
                      type="button"
                      key={block.id}
                      disabled={Boolean(contentAction)}
                      onClick={() => selectContentBlock(block)}
                    >
                      <span>
                        <strong>{block.title}</strong>
                        <small>{contentTypeLabel(block.blockType)} · {formatShortDate(block.updatedAt)}</small>
                      </span>
                      <span className={`status-pill ${block.status}`}>{block.status}</span>
                    </button>
                  )) : (
                    <EmptyPanel
                      title={hasContentFilters ? "No matching homepage updates" : "No homepage updates yet"}
                      body={hasContentFilters ? "Clear the search and type filter to see every update." : "Add an announcement, event, or resource to the public homepage."}
                      action={hasContentFilters ? (
                        <button className="btn btn-secondary btn-small" type="button" onClick={clearContentFilters}>Clear filters</button>
                      ) : (
                        <button className="btn btn-primary btn-small" type="button" onClick={startNewContentBlock}>Add homepage update</button>
                      )}
                    />
                  )}
                </div>
              </section>

              <section className="platform-table-card newsletter-editor-card">
                <div className="newsletter-editor-layout">
                  <form className="newsletter-editor-form" onSubmit={saveContentBlock} aria-busy={Boolean(contentAction)}>
                    <div className="newsletter-editor-heading">
                      <div>
                        <p className="eyebrow">{selectedContentBlock ? contentTypeLabel(selectedContentBlock.blockType) : "Public content"}</p>
                        <h2>{selectedContentBlockId ? "Edit homepage update" : "New homepage update"}</h2>
                      </div>
                      {selectedContentBlock ? <span className={`status-pill ${selectedContentBlock.status}`}>{selectedContentBlock.status}</span> : null}
                    </div>

                    <StatusLine status={actionStatus.scope === "content" ? actionStatus : { text: "", isError: false }} />

                    <fieldset className="newsletter-editor-fieldset" disabled={Boolean(contentAction)}>

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
                      ref={contentTitleRef}
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
                      <button className="btn btn-primary" type="submit">
                        <FileText aria-hidden="true" />
                        <span>{contentAction === "save" ? (selectedContentBlockId ? "Saving homepage update..." : "Creating homepage update...") : selectedContentBlockId ? "Save homepage update" : "Create homepage update"}</span>
                      </button>
                      {selectedContentBlockId ? (
                        <button className="btn btn-danger-soft" type="button" onClick={deleteContentBlock}>
                          <Trash2 aria-hidden="true" />
                          <span>{contentAction === "delete" ? "Removing homepage update..." : "Remove update"}</span>
                        </button>
                      ) : null}
                    </div>
                    </fieldset>
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
              </div>
            </div>
          ) : null}

          {newsletterLoadState === "ready" && activeSection === "issues" ? (
          <div className="newsletter-issues-management">
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

              {filteredIssues.length ? (
                <div className="newsletter-management-table" role="table" aria-label="Newsletter issues">
                  <div className="newsletter-management-table-head newsletter-issue-table-row" role="row">
                    <span role="columnheader">Issue</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Published / updated</span>
                    <span role="columnheader">Recipients</span>
                    <span role="columnheader"><span className="sr-only">Actions</span></span>
                  </div>
                  {filteredIssues.map(issue => (
                    <div className="newsletter-management-table-row newsletter-issue-table-row" role="row" key={issue.id}>
                      <div role="cell">
                        <strong>{issue.title}</strong>
                        {issue.editionLabel ? <small>{issue.editionLabel}</small> : null}
                      </div>
                      <div role="cell"><span className={`status-pill ${issue.status}`}>{issue.status}</span></div>
                      <span role="cell">{formatShortDate(issue.publishedAt || issue.updatedAt || issue.createdAt)}</span>
                      <span role="cell">{issue.status === "published" ? countLabel(Number(issue.sentCount || 0), "delivery") : "Not sent"}</span>
                      <div role="cell">
                        <button className="btn btn-secondary btn-small" type="button" disabled={Boolean(issueAction)} onClick={() => selectIssue(issue)}>
                          <FileText aria-hidden="true" />
                          <span>{issue.status === "published" ? "View" : "Edit"}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                  <EmptyPanel
                    title={hasIssueSearch ? "No matching newsletters" : "No newsletters yet"}
                    body={hasIssueSearch ? "Clear the search to see every newsletter." : "Write the first newsletter and save it as a draft before publishing."}
                    action={hasIssueSearch ? (
                      <button className="btn btn-secondary btn-small" type="button" onClick={clearIssueSearch}>Clear search</button>
                    ) : (
                      <button className="btn btn-primary btn-small" type="button" onClick={startNewDraft}>Write first newsletter</button>
                    )}
                  />
              )}
            </section>

            {isIssueEditorOpen ? (
              <div className="modal-backdrop newsletter-modal-backdrop" role="presentation" onMouseDown={event => {
                if (event.target === event.currentTarget) closeIssueEditor();
              }}>
                <div className="modal-panel newsletter-management-modal newsletter-issue-modal" role="dialog" aria-modal="true" aria-labelledby="newsletterIssueEditorTitle">
                  <div className="newsletter-modal-heading">
                    <div>
                      <p className="eyebrow">Newsletter issue</p>
                      <h2 id="newsletterIssueEditorTitle">{selectedIssueId ? (selectedIssue?.status === "published" ? "View issue" : "Edit issue") : "Create issue"}</h2>
                    </div>
                    <button className="icon-button" type="button" aria-label="Close issue editor" disabled={Boolean(issueAction)} onClick={closeIssueEditor}>
                      <X aria-hidden="true" />
                    </button>
                  </div>
                  <section className="platform-table-card newsletter-editor-card">
                    <div className="newsletter-editor-layout">
                      <form className="newsletter-editor-form" onSubmit={saveIssue} aria-busy={Boolean(issueAction)}>
                  <div className="newsletter-editor-heading">
                    <div>
                      <p className="eyebrow">{selectedIssue?.status || "Draft"}</p>
                      <h2>{selectedIssueId ? "Edit newsletter" : "New newsletter"}</h2>
                    </div>
                    {selectedIssue ? <span className={`status-pill ${selectedIssue.status}`}>{selectedIssue.status}</span> : null}
                  </div>

                  <StatusLine status={actionStatus.scope === "issue" ? actionStatus : { text: "", isError: false }} />

                  {selectedIssue?.status === "published" ? (
                    <p className="muted-copy">Published issues are read-only. Create a new issue for the next update.</p>
                  ) : null}

                  <fieldset className="newsletter-editor-fieldset" disabled={Boolean(issueAction)}>

                  <label className="field-label" htmlFor="newsletterTitle">Title</label>
                  <input
                    id="newsletterTitle"
                    ref={issueTitleRef}
                    className="input"
                    value={form.title}
                    placeholder="Company newsletter title"
                    disabled={selectedIssue?.status === "published"}
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
                        disabled={selectedIssue?.status === "published"}
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
                        disabled={selectedIssue?.status === "published"}
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
                    disabled={selectedIssue?.status === "published"}
                    onChange={event => updateForm("body", event.target.value)}
                    required
                  />

                  <div className="button-row">
                    <button className="btn btn-secondary" type="submit" disabled={selectedIssue?.status === "published"}>
                      <FileText aria-hidden="true" />
                      <span>{issueAction === "save" ? (selectedIssueId ? "Saving issue..." : "Creating draft...") : selectedIssueId ? "Save issue" : "Create draft"}</span>
                    </button>
                    <button className="btn btn-primary" type="button" onClick={publishIssue} disabled={!selectedIssueId || selectedIssue?.status === "published"}>
                      <Send aria-hidden="true" />
                      <span>{issueAction === "publish" ? "Publishing..." : selectedIssue?.status === "published" ? "Published" : "Publish"}</span>
                    </button>
                    {selectedIssueId ? (
                      <button className="btn btn-danger-soft" type="button" onClick={deleteIssue}>
                        <Trash2 aria-hidden="true" />
                        <span>{issueAction === "delete" ? "Deleting..." : "Delete issue"}</span>
                      </button>
                    ) : null}
                  </div>

                  <div className="newsletter-test-send">
                    <label className="field-label" htmlFor="newsletterTestEmail">Send test</label>
                    <div className="newsletter-test-send-row">
                      <input
                        id="newsletterTestEmail"
                        className="input"
                        type="text"
                        inputMode="email"
                        autoComplete="email"
                        value={testEmail}
                        placeholder="name@example.com"
                        onChange={event => setTestEmail(event.target.value)}
                      />
                      <button className="btn btn-secondary" type="button" onClick={sendTestIssue} disabled={!selectedIssueId}>
                        <MailPlus aria-hidden="true" />
                        <span>{issueAction === "test" ? "Sending test..." : "Send test"}</span>
                      </button>
                    </div>
                    <small>Send one proof email before publishing. This does not publish the issue or add delivery records.</small>
                  </div>
                  </fieldset>
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
              </div>
            ) : null}
          </div>
          ) : null}

          {newsletterLoadState === "ready" && activeSection === "subscribers" ? (
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

            <StatusLine status={actionStatus.scope === "subscribers" ? actionStatus : { text: "", isError: false }} />

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
              <div className="newsletter-management-table newsletter-subscriber-table" role="table" aria-label="Newsletter subscribers">
                <div className="newsletter-management-table-head newsletter-subscriber-table-row" role="row">
                  <span role="columnheader">Name</span>
                  <span role="columnheader">Platoon</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Requested</span>
                  <span role="columnheader"><span className="sr-only">Actions</span></span>
                </div>
                {filteredSubscribers.map(subscriber => (
                  <div className="newsletter-management-table-row newsletter-subscriber-table-row" role="row" key={subscriber.id}>
                    <div role="cell">
                      <strong>{subscriber.displayName || "Subscriber request"}</strong>
                      {subscriber.supervisorName ? <small>Unit contact: {subscriber.supervisorName}</small> : null}
                    </div>
                    <span role="cell">{subscriber.platoon || "—"}</span>
                    <div role="cell"><span className={`status-pill ${subscriber.status}`}>{subscriber.status === "active" ? "approved" : subscriber.status}</span></div>
                    <span role="cell">{formatShortDate(subscriber.lastSubscribedAt || subscriber.createdAt)}</span>
                    <div role="cell">
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => setSelectedSubscriberId(subscriber.id)}>
                        <Users aria-hidden="true" />
                        <span>View details</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyPanel
                title={subscriberEmptyTitle}
                body={subscriberEmptyBody}
                action={subscribers.length && hasSubscriberFilters ? (
                  <button className="btn btn-secondary btn-small" type="button" onClick={clearSubscriberFilters}>
                    {!subscriberQuery.trim() && subscriberStatusFilter === "pending" ? "Show all subscribers" : "Clear filters"}
                  </button>
                ) : !subscribers.length ? (
                  <a className="btn btn-secondary btn-small" href={`https://${appConfig.baseDomain}/`} target="_blank" rel="noreferrer">View signup page</a>
                ) : null}
              />
            )}
          </section>
          ) : null}

          {newsletterLoadState === "ready" && activeSection === "analytics" ? (
            <div className="newsletter-analytics-layout">
              <section className="platform-stat-grid newsletter-stat-grid" aria-label="Delivery totals">
                <div className="platform-stat-card">
                  <span className="platform-stat-icon blue"><Send aria-hidden="true" /></span>
                  <div><strong>{deliveries.length}</strong><span>Delivery records</span></div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon green"><CheckCircle2 aria-hidden="true" /></span>
                  <div><strong>{deliveries.filter(delivery => delivery.status === "sent").length}</strong><span>Delivered</span></div>
                </div>
                <div className="platform-stat-card">
                  <span className="platform-stat-icon amber"><AlertCircle aria-hidden="true" /></span>
                  <div><strong>{deliveries.filter(delivery => delivery.status !== "sent").length}</strong><span>Skipped or failed</span></div>
                </div>
              </section>

              <section className="platform-table-card newsletter-delivery-analytics-card">
                <div className="newsletter-subscriber-heading">
                  <div>
                    <h2>Delivery records</h2>
                    <p>Each attempted recipient delivery is kept here for audit and troubleshooting.</p>
                  </div>
                  <button className="btn btn-secondary btn-small" type="button" onClick={exportDeliveries} disabled={!deliveries.length}>
                    <Download aria-hidden="true" />
                    <span>Export CSV</span>
                  </button>
                </div>
                {deliveries.length ? (
                  <div className="newsletter-management-table newsletter-delivery-table" role="table" aria-label="Newsletter delivery records">
                    <div className="newsletter-management-table-head newsletter-delivery-table-row" role="row">
                      <span role="columnheader">Issue</span>
                      <span role="columnheader">Subscriber</span>
                      <span role="columnheader">Status</span>
                      <span role="columnheader">Recorded</span>
                    </div>
                    {deliveries.map(delivery => (
                      <div className="newsletter-management-table-row newsletter-delivery-table-row" role="row" key={delivery.id}>
                        <div role="cell"><strong>{delivery.issueTitle || "Newsletter issue"}</strong></div>
                        <div role="cell">
                          <strong>{delivery.subscriberName || "Subscriber"}</strong>
                          {delivery.error ? <small>{delivery.error}</small> : null}
                        </div>
                        <div role="cell"><span className={`status-pill ${delivery.status}`}>{deliveryStatusLabel(delivery.status)}</span></div>
                        <span role="cell">{delivery.sentAt ? formatDate(delivery.sentAt) : formatDate(delivery.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyPanel title="No delivery records yet" body="Delivery records will appear here after an issue is published." />
                )}
              </section>
            </div>
          ) : null}

          {selectedSubscriber ? (
            <div className="modal-backdrop newsletter-modal-backdrop" role="presentation" onMouseDown={event => {
              if (event.target === event.currentTarget) closeSubscriberDetails();
            }}>
              <div className="modal-panel newsletter-subscriber-modal" role="dialog" aria-modal="true" aria-labelledby="subscriberDetailsTitle">
                <div className="newsletter-modal-heading">
                  <div>
                    <p className="eyebrow">Subscriber details</p>
                    <h2 id="subscriberDetailsTitle">{selectedSubscriber.displayName || "Subscriber request"}</h2>
                  </div>
                  <button className="icon-button" type="button" aria-label="Close subscriber details" disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))} onClick={closeSubscriberDetails}>
                    <X aria-hidden="true" />
                  </button>
                </div>

                <StatusLine status={actionStatus.scope === "subscribers" ? actionStatus : { text: "", isError: false }} />

                <dl className="newsletter-subscriber-detail-list">
                  <div><dt>Status</dt><dd><span className={`status-pill ${selectedSubscriber.status}`}>{selectedSubscriber.status === "active" ? "approved" : selectedSubscriber.status}</span></dd></div>
                  <div><dt>Email</dt><dd>{selectedSubscriber.email}</dd></div>
                  {selectedSubscriber.platoon ? <div><dt>Platoon</dt><dd>{selectedSubscriber.platoon}</dd></div> : null}
                  {selectedSubscriber.supervisorName ? <div><dt>Unit contact</dt><dd>{selectedSubscriber.supervisorName}</dd></div> : null}
                  <div><dt>Requested</dt><dd>{formatDate(selectedSubscriber.lastSubscribedAt || selectedSubscriber.createdAt)}</dd></div>
                  {selectedSubscriber.reviewedAt ? <div><dt>Reviewed</dt><dd>{formatDate(selectedSubscriber.reviewedAt)}</dd></div> : null}
                  {selectedSubscriber.reviewNote ? <div><dt>Review note</dt><dd>{selectedSubscriber.reviewNote}</dd></div> : null}
                  {selectedSubscriber.lastDeliveryAt ? (
                    <div><dt>Last delivery</dt><dd>{deliveryStatusLabel(selectedSubscriber.lastDeliveryStatus)}{selectedSubscriber.lastDeliveryIssueTitle ? ` · ${selectedSubscriber.lastDeliveryIssueTitle}` : ""} · {formatDate(selectedSubscriber.lastDeliveryAt)}</dd></div>
                  ) : null}
                  {selectedSubscriber.lastDeliveryError ? <div><dt>Delivery note</dt><dd>{selectedSubscriber.lastDeliveryError}</dd></div> : null}
                </dl>

                {selectedSubscriber.status !== "active" || selectedSubscriber.status === "pending" ? (
                  <label className="newsletter-review-note">
                    <span>Optional private review note</span>
                    <textarea
                      className="input"
                      value={reviewNotes[selectedSubscriber.id] ?? ""}
                      disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))}
                      placeholder="Add context for this review..."
                      maxLength={600}
                      onChange={event => updateReviewNote(selectedSubscriber.id, event.target.value)}
                    />
                  </label>
                ) : null}

                <div className="modal-actions newsletter-subscriber-modal-actions">
                  {selectedSubscriber.status === "pending" || selectedSubscriber.status === "rejected" || selectedSubscriber.status === "unsubscribed" ? (
                    <button className="btn btn-primary" type="button" disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))} onClick={() => reviewSubscriber(selectedSubscriber.id, "approved")}>
                      <CheckCircle2 aria-hidden="true" />
                      <span>{newsletterActions.get(`subscriber:${selectedSubscriber.id}`) === "approved" ? "Approving..." : "Approve subscriber"}</span>
                    </button>
                  ) : null}
                  {selectedSubscriber.status === "pending" ? (
                    <button className="btn btn-danger-soft" type="button" disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))} onClick={() => reviewSubscriber(selectedSubscriber.id, "rejected")}>
                      <XCircle aria-hidden="true" />
                      <span>{newsletterActions.get(`subscriber:${selectedSubscriber.id}`) === "rejected" ? "Rejecting..." : "Reject request"}</span>
                    </button>
                  ) : null}
                  {selectedSubscriber.status === "active" ? (
                    <button className="btn btn-danger-soft" type="button" disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))} onClick={() => {
                      if (window.confirm(`Remove ${selectedSubscriber.displayName || "this subscriber"} from the approved newsletter list? Their audit history will be kept.`)) {
                        removeSubscriber(selectedSubscriber.id);
                      }
                    }}>
                      <Trash2 aria-hidden="true" />
                      <span>{newsletterActions.get(`subscriber:${selectedSubscriber.id}`) === "remove" ? "Removing..." : "Remove subscriber"}</span>
                    </button>
                  ) : null}
                  <button className="btn btn-secondary" type="button" disabled={Boolean(newsletterActions.get(`subscriber:${selectedSubscriber.id}`))} onClick={closeSubscriberDetails}>Close</button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PlatformPanel({ token, me, onRefresh, onLogout }) {
  const isMobileViewport = useMediaQuery("(max-width: 860px)");
  const [tenants, setTenants] = useState([]);
  const [platformUsers, setPlatformUsers] = useState([]);
  const [pendingRoleChange, setPendingRoleChange] = useState(null);
  const [pendingStatusChange, setPendingStatusChange] = useState(null);
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [platformMemberForm, setPlatformMemberForm] = useState({ tenantSlug: "", email: "", displayName: "", role: "contributor" });
  const [platformMemberIdentityCheck, setPlatformMemberIdentityCheck] = useState(null);
  const [addUserStatus, setAddUserStatus] = useState({ text: "", isError: false });
  const [form, setForm] = useState({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
  const [createIdentityCheck, setCreateIdentityCheck] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeView, setActiveView] = useState(() => platformViewFromLocation());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [status, setStatus] = useState({ text: "Loading platoons...", isError: false });
  const [createStatus, setCreateStatus] = useState({ text: "", isError: false });
  const [platformActions, setPlatformActions] = useState(() => new Map());
  const [platformProvisioningAvailable, setPlatformProvisioningAvailable] = useState(false);
  const [platformSetup, setPlatformSetup] = useState(null);
  const [setupTenantId, setSetupTenantId] = useState("");
  const [hasLoadedTenants, setHasLoadedTenants] = useState(false);
  const [tenantLoadError, setTenantLoadError] = useState(false);
  const platformActionRef = useRef(new Map());
  const platformLoadRequestRef = useRef(0);
  const userMenuRef = useRef(null);
  const mobileNavToggleRef = useRef(null);
  const mobileNavCloseRef = useRef(null);
  const createTenantTriggerRef = useRef(null);
  const platformUserName = me?.user?.display_name || me?.user?.email || "Admin user";
  const platformUserEmail = me?.user?.email || me?.identity?.email || "";
  const platformUserInitial = String(platformUserName || "A").slice(0, 1).toUpperCase();
  const totalMembers = tenants.reduce((sum, tenant) => sum + Number(tenant.memberCount || 0), 0);
  const totalAdmins = tenants.reduce((sum, tenant) => sum + Number(tenant.adminCount || 0), 0);
  const normalizedCreateAdminEmail = String(form.adminEmail || "").trim().toLowerCase();
  const visibleCreateIdentityCheck = createIdentityCheck?.email === normalizedCreateAdminEmail
    ? createIdentityCheck
    : null;
  const normalizedPlatformMemberEmail = String(platformMemberForm.email || "").trim().toLowerCase();
  const visiblePlatformMemberIdentityCheck = platformMemberIdentityCheck?.email === normalizedPlatformMemberEmail
    ? platformMemberIdentityCheck
    : null;
  const activeTenants = tenants.filter(tenant => tenant.status === "active");
  const setupTenant = tenants.find(tenant => tenant.id === setupTenantId) || tenants[0] || null;
  const tenantSetup = setupTenant ? platformSetup?.tenants?.[setupTenant.id] || null : null;
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
  const manageablePlatformUsers = platformUsers
    .map(user => ({
      ...user,
      memberships: (user.memberships || []).filter(membership => (
        membership?.id
        && membership?.tenantSlug
        && ["tenant_admin", "contributor", "viewer"].includes(membership.role)
      ))
    }))
    .filter(user => user.memberships.length);
  const visiblePlatformUsers = manageablePlatformUsers.filter(user => matchesSearch([
    user.displayName,
    user.email,
    ...user.memberships.flatMap(membership => [membership.tenantName, membership.tenantSlug, membership.role])
  ], query));
  const createAction = platformActions.get("create") || "";
  const refreshAction = platformActions.get("refresh") || "";
  const hasPlatformAction = platformActions.size > 0;
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
    ["Permanent accounts", platformProvisioningAvailable ? "connected" : "not connected"],
    ["Last request ID", readLastApiRequestId() || "none recorded"],
    ["Signed in as", me?.user?.email || me?.identity?.email || "unknown"]
  ];
  const pageMeta = {
    dashboard: {
      title: "Dashboard",
      copy: "Open a platoon and see where today’s inventories need attention."
    },
    users: {
      title: "Users",
      copy: "Manage who can access each platoon and what they can do."
    },
    settings: {
      title: "Platform settings",
      copy: "Create platoons and review technical workspace setup when needed."
    },
    support: {
      title: "Support",
      copy: "Get help with Shadow Tracer or open technical diagnostics."
    }
  }[activeView] || {
    title: "Dashboard",
    copy: "Monitor platform setup, active workspaces, and admin access."
  };
  const platformNavItems = [
    { id: "dashboard", label: "Dashboard", icon: Home },
    { id: "users", label: "Users", icon: UserPlus },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "support", label: "Support", icon: RefreshCw }
  ];

  function beginPlatformAction(scope, action) {
    if (!scope || platformActionRef.current.size || platformActionRef.current.has(scope)) return false;
    platformActionRef.current.set(scope, action);
    setPlatformActions(current => {
      const next = new Map(current);
      next.set(scope, action);
      return next;
    });
    return true;
  }

  function finishPlatformAction(scope, action) {
    if (platformActionRef.current.get(scope) !== action) return;
    platformActionRef.current.delete(scope);
    setPlatformActions(current => {
      const next = new Map(current);
      if (next.get(scope) === action) next.delete(scope);
      return next;
    });
  }

  function clearPlatformFilters() {
    setQuery("");
    setStatusFilter("all");
  }

  function tenantWorkspaceHref(tenant) {
    const host = tenantHost(tenant);
    const isLocal = appConfig.baseDomain === "localhost" || window.location.hostname.endsWith(".localhost") || window.location.hostname === "localhost";
    if (isLocal) {
      const port = window.location.port ? `:${window.location.port}` : "";
      return `${window.location.protocol}//${host}${port}/#/admin`;
    }
    return `https://${host}/#/admin`;
  }

  async function copyTenantLink(tenant) {
    const host = tenantHost(tenant);
    const copied = await copyText(tenantWorkspaceHref(tenant));
    setStatus({
      text: copied ? `Copied workspace link for ${host}` : "Could not copy the workspace link from this browser.",
      isError: !copied
    });
  }

  async function loadTenants({ quiet = false } = {}) {
    const requestId = platformLoadRequestRef.current + 1;
    platformLoadRequestRef.current = requestId;
    try {
      if (!quiet) setStatus({ text: "Loading platoons...", isError: false });
      setTenantLoadError(false);
      const [data, userData] = await Promise.all([
        apiRequest("/platform/tenants", { token }),
        apiRequest("/platform/users", { token }).catch(() => ({ users: [], management: { mutationsAvailable: false, reason: "User management is temporarily unavailable." } }))
      ]);
      if (requestId !== platformLoadRequestRef.current) return { ok: false, stale: true };
      setTenants(data.tenants || []);
      setPlatformUsers(userData.users || []);
      setHasLoadedTenants(true);
      setPlatformSetup(data.setup || { unavailable: true, tenants: {} });
      const accountSetupAvailable = data.provisioningAvailable === true;
      setPlatformProvisioningAvailable(accountSetupAvailable);
      if (!accountSetupAvailable) {
        setForm(current => ({ ...current, adminEmail: "", adminDisplayName: "" }));
        setCreateIdentityCheck(null);
      }
      if (!quiet) setStatus({ text: "", isError: false });
      return { ok: true };
    } catch (error) {
      if (requestId !== platformLoadRequestRef.current) return { ok: false, stale: true };
      setPlatformProvisioningAvailable(false);
      setHasLoadedTenants(true);
      setTenantLoadError(true);
      if (!quiet) setPlatformSetup(null);
      if (!quiet) setStatus({ text: getApiErrorMessage(error), isError: true });
      return { ok: false, error };
    }
  }

  useEffect(() => {
    loadTenants({ quiet: hasLoadedTenants });
  }, [token]);

  useEffect(() => {
    const syncViewFromLocation = () => setActiveView(platformViewFromLocation());
    window.addEventListener("hashchange", syncViewFromLocation);
    window.addEventListener("popstate", syncViewFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncViewFromLocation);
      window.removeEventListener("popstate", syncViewFromLocation);
    };
  }, []);

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
    const scope = "refresh";
    const action = "refresh";
    if (!beginPlatformAction(scope, action)) return;
    try {
      const result = await loadTenants();
      if (result.ok) {
        setStatus({ text: "Platform refreshed.", isError: false });
        onRefresh?.();
      }
    } finally {
      finishPlatformAction(scope, action);
    }
  }

  function openCreateTenant() {
    if (platformActionRef.current.size) return;
    createTenantTriggerRef.current = document.activeElement;
    setCreateStatus({ text: "", isError: false });
    setCreateIdentityCheck(null);
    setIsCreateOpen(true);
  }

  function closeCreateTenant() {
    if (platformActionRef.current.has("create")) return;
    setIsCreateOpen(false);
    setCreateStatus({ text: "", isError: false });
    setCreateIdentityCheck(null);
    window.requestAnimationFrame(() => createTenantTriggerRef.current?.focus?.());
  }

  function handleCreateTenantKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCreateTenant();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
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

  function selectPlatformView(view) {
    setActiveView(view);
    navigateAppHash(platformViewHashes[view] || platformViewHashes.dashboard);
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
    if (key === "adminEmail") setCreateIdentityCheck(null);
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
    const scope = "create";
    const action = "create";
    if (!beginPlatformAction(scope, action)) return;
    setCreateStatus({ text: "Creating platoon...", isError: false });
    setStatus({ text: "", isError: false });
    try {
      const adminEmail = platformProvisioningAvailable ? form.adminEmail.trim().toLowerCase() : "";
      let selectedIdentityId = "";
      if (adminEmail) {
        setCreateStatus({ text: "Checking the admin sign-in account...", isError: false });
        const identityData = await apiRequest("/platform/identity-check", {
          method: "POST",
          token,
          body: { email: adminEmail }
        });
        if (identityData.status === "ambiguous") {
          const candidates = identityData.candidates || [];
          const previousSelection = createIdentityCheck?.email === adminEmail
            ? createIdentityCheck.selectedId
            : "";
          selectedIdentityId = candidates.some(candidate => candidate.id === previousSelection && candidate.eligible)
            ? previousSelection
            : "";
          setCreateIdentityCheck({
            email: adminEmail,
            status: "ambiguous",
            candidates,
            selectedId: selectedIdentityId
          });
          if (!selectedIdentityId) {
            setCreateStatus({
              text: "Choose the correct existing sign-in account before creating the platoon.",
              isError: false
            });
            return;
          }
        } else {
          setCreateIdentityCheck(null);
        }
      } else {
        setCreateIdentityCheck(null);
      }

      setCreateStatus({ text: "Creating platoon...", isError: false });
      const body = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        adminEmail: adminEmail || undefined,
        adminDisplayName: platformProvisioningAvailable ? form.adminDisplayName.trim() || undefined : undefined,
        ...(selectedIdentityId ? { authentikUserUuid: selectedIdentityId } : {})
      };
      const data = await apiRequest("/platform/tenants", { method: "POST", token, body });
      setForm({ name: "", slug: "", adminEmail: "", adminDisplayName: "" });
      setCreateIdentityCheck(null);
      setIsCreateOpen(false);
      setCreateStatus({ text: "", isError: false });
      window.requestAnimationFrame(() => createTenantTriggerRef.current?.focus?.());
      const refreshed = await loadTenants({ quiet: true });
      const createdText = `Created ${data.tenant.slug}.${appConfig.baseDomain}.`;
      if (!refreshed.ok && !refreshed.stale) {
        setStatus({ text: `${createdText} The latest platoon list could not be loaded. ${getApiErrorMessage(refreshed.error)}`, isError: true });
      } else {
        setStatus({ text: createdText, isError: false });
      }
    } catch (error) {
      setCreateStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishPlatformAction(scope, action);
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
    selectPlatformView("support");
    setIsUserMenuOpen(false);
  }

  async function copyDiagnosticsFromMenu() {
    await copyDiagnostics();
    setIsUserMenuOpen(false);
  }

  function openNewsletter() {
    navigateAppHash(newsletterSectionHashes.overview);
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

  async function confirmPlatformRoleChange() {
    if (!pendingRoleChange) return;
    const { membership, nextRole, user } = pendingRoleChange;
    const scope = `role-${membership.id}`;
    const action = "role";
    if (!beginPlatformAction(scope, action)) return;
    try {
      await apiRequest(`/tenant/members/${membership.id}`, {
        method: "PATCH",
        token,
        tenantSlug: membership.tenantSlug,
        body: { role: nextRole }
      });
      setPendingRoleChange(null);
      await loadTenants({ quiet: true });
      setStatus({ text: `${user.displayName || user.email} is now ${formatTeamRole(nextRole)} in ${membership.tenantName}.`, isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishPlatformAction(scope, action);
    }
  }

  async function confirmPlatformStatusChange() {
    if (!pendingStatusChange) return;
    const { membership, nextStatus, user } = pendingStatusChange;
    const scope = `status-${membership.id}`;
    const action = "status";
    if (!beginPlatformAction(scope, action)) return;
    try {
      await apiRequest(`/tenant/members/${membership.id}`, {
        method: "PATCH",
        token,
        tenantSlug: membership.tenantSlug,
        body: { status: nextStatus }
      });
      setPendingStatusChange(null);
      await loadTenants({ quiet: true });
      setStatus({
        text: `${user.displayName || user.email} is now ${nextStatus === "active" ? "active" : "disabled"} in ${membership.tenantName}.`,
        isError: false
      });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishPlatformAction(scope, action);
    }
  }

  function openAddPlatformUser() {
    if (platformActionRef.current.size || !platformProvisioningAvailable) return;
    setPlatformMemberForm(current => ({
      ...current,
      tenantSlug: activeTenants.some(tenant => tenant.slug === current.tenantSlug)
        ? current.tenantSlug
        : activeTenants[0]?.slug || ""
    }));
    setPlatformMemberIdentityCheck(null);
    setAddUserStatus({ text: "", isError: false });
    setIsAddUserOpen(true);
  }

  function closeAddPlatformUser() {
    if (platformActionRef.current.has("add-user")) return;
    setIsAddUserOpen(false);
    setPlatformMemberIdentityCheck(null);
    setAddUserStatus({ text: "", isError: false });
  }

  function updatePlatformMemberForm(key, value) {
    if (key === "email") setPlatformMemberIdentityCheck(null);
    setPlatformMemberForm(current => ({ ...current, [key]: value }));
  }

  async function createPlatformMember(event) {
    event.preventDefault();
    const scope = "add-user";
    const action = "create-user";
    if (!beginPlatformAction(scope, action)) return;
    const tenantSlug = platformMemberForm.tenantSlug || activeTenants[0]?.slug || "";
    const email = normalizedPlatformMemberEmail;
    try {
      setAddUserStatus({ text: "Checking the sign-in account...", isError: false });
      const identityData = await apiRequest("/tenant/members/identity-check", {
        method: "POST",
        token,
        tenantSlug,
        body: { email }
      });
      let selectedIdentityId = "";
      if (identityData.status === "ambiguous") {
        const candidates = identityData.candidates || [];
        const previousSelection = platformMemberIdentityCheck?.email === email
          ? platformMemberIdentityCheck.selectedId
          : "";
        selectedIdentityId = candidates.some(candidate => candidate.id === previousSelection && candidate.eligible)
          ? previousSelection
          : "";
        setPlatformMemberIdentityCheck({ email, status: "ambiguous", candidates, selectedId: selectedIdentityId });
        if (!selectedIdentityId) {
          setAddUserStatus({ text: "Choose the correct existing sign-in account, then add the user.", isError: false });
          return;
        }
      } else {
        setPlatformMemberIdentityCheck(null);
      }

      setAddUserStatus({ text: "Adding the user...", isError: false });
      await apiRequest("/tenant/members", {
        method: "POST",
        token,
        tenantSlug,
        body: {
          email,
          role: platformMemberForm.role,
          ...(platformMemberForm.displayName.trim() ? { displayName: platformMemberForm.displayName.trim() } : {}),
          ...(selectedIdentityId ? { authentikUserUuid: selectedIdentityId } : {})
        }
      });
      setPlatformMemberForm({ tenantSlug, email: "", displayName: "", role: "contributor" });
      setPlatformMemberIdentityCheck(null);
      setIsAddUserOpen(false);
      await loadTenants({ quiet: true });
      setStatus({ text: `${email} was added to ${tenants.find(tenant => tenant.slug === tenantSlug)?.name || tenantSlug}. Account setup will continue automatically.`, isError: false });
    } catch (error) {
      setAddUserStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      finishPlatformAction(scope, action);
    }
  }

  function renderSetupChecklist() {
    if (!hasLoadedTenants) {
      return <EmptyPanel title="Checking setup" body="Verifying workspace access, imports, and storage." />;
    }
    if (tenantLoadError || platformSetup?.unavailable) {
      return (
        <EmptyPanel
          title="Could not check setup"
          body="Refresh the platform to run the setup checks again."
          action={<button className="btn btn-secondary btn-small" type="button" disabled={hasPlatformAction} onClick={refreshPlatform}>Try again</button>}
        />
      );
    }
    if (!setupTenant) {
      return (
        <EmptyPanel
          title="No platoon to check"
          body="Create the first platoon, then finish its access and packet setup here."
          action={<button className="btn btn-primary btn-small" type="button" disabled={hasPlatformAction} onClick={openCreateTenant}>Create platoon</button>}
        />
      );
    }
    if (!tenantSetup) {
      return (
        <EmptyPanel
          title="Setup checks unavailable"
          body="Refresh the platform to check this platoon again."
          action={<button className="btn btn-secondary btn-small" type="button" disabled={hasPlatformAction} onClick={refreshPlatform}>Try again</button>}
        />
      );
    }

    const workspaceHref = tenantWorkspaceHref(setupTenant);
    const hostname = tenantSetup.hostname || tenantHost(setupTenant);
    const steps = [
      {
        id: "dns",
        label: "Workspace address",
        state: tenantSetup.dns?.state || "missing",
        detail: tenantSetup.dns?.state === "ready" ? `${hostname} resolves.` : `${hostname} does not resolve yet.`,
        action: tenantSetup.dns?.state === "ready" ? null : (
          <button className="btn btn-secondary btn-small" type="button" onClick={() => copyTenantLink(setupTenant)}>Copy address</button>
        )
      },
      {
        id: "authentik",
        label: "Account group",
        state: tenantSetup.authentikGroup?.state || "not_connected",
        detail: tenantSetup.authentikGroup?.state === "ready"
          ? `${tenantSetup.authentikGroup.name} is ready.`
          : tenantSetup.authentikGroup?.state === "missing"
            ? `${tenantSetup.authentikGroup.name} still needs to be created.`
            : tenantSetup.authentikGroup?.state === "unavailable"
              ? "The account service could not be checked."
              : "Permanent account setup is not connected.",
        action: tenantSetup.authentikGroup?.state === "ready" ? null : (
          <button className="btn btn-secondary btn-small" type="button" onClick={openSupportDetails}>Open setup details</button>
        )
      },
      {
        id: "leader",
        label: "Leader access",
        state: tenantSetup.leaderAccess?.state || "missing",
        detail: tenantSetup.leaderAccess?.state === "ready"
          ? countLabel(tenantSetup.leaderAccess.activeAdminCount, "active leader")
          : tenantSetup.leaderAccess?.state === "pending"
            ? `${countLabel(tenantSetup.leaderAccess.pendingInviteCount, "leader invite")} pending.`
            : "No leader has access yet.",
        action: tenantSetup.leaderAccess?.state === "ready" ? null : (
          <a className="btn btn-secondary btn-small" href={workspaceHref}>{tenantSetup.leaderAccess?.state === "pending" ? "Check Team" : "Add leader"}</a>
        )
      },
      {
        id: "packet",
        label: "First packet",
        state: tenantSetup.packetImport?.state || "missing",
        detail: tenantSetup.packetImport?.state === "ready"
          ? `${countLabel(tenantSetup.packetImport.count, "packet import")} complete.`
          : "No packet has been imported.",
        action: tenantSetup.packetImport?.state === "ready" ? null : (
          <a className="btn btn-secondary btn-small" href={workspaceHref}>Import packet</a>
        )
      },
      {
        id: "storage",
        label: "Photo storage",
        state: platformSetup?.storage?.state || "unavailable",
        detail: platformSetup?.storage?.state === "ready" ? "Uploads can be saved." : "Storage is not writable.",
        action: platformSetup?.storage?.state === "ready" ? null : (
          <button className="btn btn-secondary btn-small" type="button" onClick={openSupportDetails}>Open diagnostics</button>
        )
      }
    ];
    const completeCount = steps.filter(step => step.state === "ready").length;

    return (
      <>
        <div className="platform-setup-toolbar">
          <label>
            <span>Platoon</span>
            <select className="select" aria-label="Platoon setup" value={setupTenant.id} onChange={event => setSetupTenantId(event.target.value)}>
              {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenantDisplayName(tenant)}</option>)}
            </select>
          </label>
          <span className="platform-setup-progress" aria-label={`${completeCount} of ${steps.length} setup steps ready`}>{completeCount} of {steps.length} ready</span>
        </div>
        <div className="platform-setup-list" role="list" aria-label={`${tenantDisplayName(setupTenant)} setup checks`}>
          {steps.map(step => {
            const isReady = step.state === "ready";
            const isPending = step.state === "pending";
            const statusLabel = isReady ? "Ready" : isPending ? "Invite sent" : "Needs setup";
            return (
              <article className={`platform-setup-step ${isReady ? "ready" : isPending ? "pending" : "needs-setup"}`} role="listitem" key={step.id}>
                <span className="platform-setup-icon" aria-hidden="true">{isReady ? <CheckCircle2 /> : <AlertCircle />}</span>
                <div className="platform-setup-copy">
                  <div>
                    <strong>{step.label}</strong>
                    <span className="platform-setup-state">{statusLabel}</span>
                  </div>
                  <p>{step.detail}</p>
                </div>
                {step.action ? <div className="platform-setup-action">{step.action}</div> : null}
              </article>
            );
          })}
        </div>
      </>
    );
  }

  function renderPlatoonCards(rows = tenants) {
    if (!rows.length) {
      if (!hasLoadedTenants) {
        return <EmptyPanel title="Loading platoons" body="Checking the latest workspaces and access counts." />;
      }
      if (tenantLoadError) {
        return (
          <EmptyPanel
            title="Could not load platoons"
            body="Refresh the platform to try again."
            action={activeView === "dashboard" ? null : (
              <button className="btn btn-secondary btn-small" type="button" disabled={hasPlatformAction} onClick={refreshPlatform}>Try again</button>
            )}
          />
        );
      }
      return (
        <EmptyPanel
          title="No platoons yet"
          body="Create the first platoon workspace from Platform settings."
          action={activeView === "settings" ? (
            <button className="btn btn-primary btn-small" type="button" disabled={hasPlatformAction} onClick={openCreateTenant}>Create platoon</button>
          ) : null}
        />
      );
    }

    return (
      <section className="platform-platoon-grid" aria-label="Platoon workspaces">
        {rows.map(tenant => {
          const host = tenantHost(tenant);
          const activeSession = tenant.latestActiveSession || null;
          const activeSessionCount = Number(tenant.activeSessionCount || 0);
          const crewCount = Number(tenant.activeTemporaryCrewCount || 0);
          const progress = Math.max(0, Math.min(100, Number(activeSession?.progressPercent || 0)));
          return (
            <article className="platform-platoon-card" key={tenant.id}>
              <div className="platform-platoon-card-heading">
                <span className="tenant-avatar" aria-hidden="true">{tenantInitials(tenant)}</span>
                <div>
                  <strong>{tenantDisplayName(tenant)}</strong>
                  <span className={`status-pill ${tenant.status}`}>{tenant.status}</span>
                </div>
              </div>

              <div className="platform-platoon-facts">
                <span><strong>{activeSessionCount}</strong>{countLabel(activeSessionCount, "active inventory").replace(/^\d+\s*/, "")}</span>
                <span><strong>{crewCount}</strong>{countLabel(crewCount, "active crew member").replace(/^\d+\s*/, "")}</span>
                <span><strong>{tenant.memberCount || 0}</strong>invited users</span>
              </div>

              {activeSession ? (
                <div className="platform-active-session">
                  <div>
                    <span>Current inventory</span>
                    <strong>{activeSession.name}</strong>
                  </div>
                  <div className="platform-session-progress-label">
                    <span>{activeSession.completedCount || 0} of {activeSession.itemCount || 0} resolved</span>
                    <strong>{progress}%</strong>
                  </div>
                  <div className="platform-session-progress" role="progressbar" aria-label={`${activeSession.name} progress`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : (
                <p className="platform-no-session">No active inventory session.</p>
              )}

              <div className="platform-link-row">
                <span><small>Link</small><strong>{host}</strong></span>
                <button className="icon-button" type="button" onClick={() => copyTenantLink(tenant)} aria-label={`Copy link for ${tenantDisplayName(tenant)}`}>
                  <Copy aria-hidden="true" />
                </button>
              </div>
              <a className="btn btn-primary platform-open-workspace" href={tenantWorkspaceHref(tenant)} aria-label={`Enter ${host} workspace`}>
                <span>Enter workspace</span>
                <ArrowRight aria-hidden="true" />
              </a>
            </article>
          );
        })}
      </section>
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
            <button className="icon-button platform-topbar-refresh" type="button" disabled={hasPlatformAction} onClick={refreshPlatform} aria-label={refreshAction ? "Refreshing platform" : "Refresh platform"}>
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
                    <button type="button" disabled={hasPlatformAction} onClick={() => {
                      refreshPlatform();
                      setIsUserMenuOpen(false);
                    }}>
                      <RefreshCw aria-hidden="true" />
                      <span>{refreshAction ? "Refreshing platform..." : "Refresh platform"}</span>
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
              {activeView === "users" ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={hasPlatformAction || !platformProvisioningAvailable || !activeTenants.length}
                  title={!platformProvisioningAvailable ? "Permanent account setup is not connected." : undefined}
                  onClick={openAddPlatformUser}
                >
                  <UserPlus aria-hidden="true" />
                  <span>Add user</span>
                </button>
              ) : null}
            </div>
          </div>

          <StatusLine status={status} />

          {activeView === "dashboard" ? (
            renderPlatoonCards()
          ) : null}

          {activeView === "users" ? (
            <section className="platform-table-card">
              <div className="platform-table-toolbar">
                <div className="platform-search" role="search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search users"
                    value={query}
                    placeholder="Search users..."
                    onChange={event => setQuery(event.target.value)}
                  />
                  {query ? (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X aria-hidden="true" /></button>
                  ) : null}
                </div>
              </div>
              <div className="platform-table platform-user-table" role="table" aria-label="Platform users">
                <div className="platform-table-head" role="row">
                  <span>User</span>
                  <span>Platoon</span>
                  <span>Role</span>
                  <span>Status</span>
                </div>
                {visiblePlatformUsers.flatMap(user => (
                  user.memberships.map(membership => (
                    <article className="platform-table-row" role="row" key={`${user.id}-${membership.id}`}>
                      <div className="platform-row-main">
                        <span className="tenant-avatar" aria-hidden="true">{String(user.displayName || user.email || "U").slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong>{user.displayName || "Unnamed user"}</strong>
                          <span>{user.email}</span>
                          <span className="platform-user-mobile-platoon"><Building2 aria-hidden="true" />{membership.tenantName}</span>
                        </div>
                      </div>
                      <span className="platform-user-platoon" data-label="Platoon"><span className="mobile-field-label">Platoon</span><span>{membership.tenantName}</span></span>
                      <span className="platform-user-role-field" data-label="Role">
                        <span className="mobile-field-label">Role</span>
                        <select
                          className="select platform-role-select"
                          aria-label={`Role for ${user.displayName || user.email} in ${membership.tenantName}`}
                          value={membership.role}
                          disabled={hasPlatformAction}
                          onChange={event => setPendingRoleChange({ user, membership, nextRole: event.target.value })}
                        >
                          <option value="tenant_admin">Platoon admin</option>
                          <option value="contributor">Member</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      </span>
                      <span className="platform-status-field" data-label="Status">
                        <span className="mobile-field-label">Status</span>
                        <select
                          className="select platform-status-select"
                          aria-label={`Status for ${user.displayName || user.email} in ${membership.tenantName}`}
                          value={membership.status}
                          disabled={hasPlatformAction}
                          onChange={event => setPendingStatusChange({ user, membership, nextStatus: event.target.value })}
                        >
                          {membership.status === "invited" ? <option value="invited">Invited</option> : null}
                          <option value="active">Active</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </span>
                    </article>
                  ))
                ))}
              </div>
              {!visiblePlatformUsers.length ? (
                <EmptyPanel
                  title={query.trim() ? "No matching users" : "No permanent users yet"}
                  body={query.trim() ? "Clear the search to see every user." : "Invite permanent users from a platoon workspace."}
                  action={query.trim() ? (
                    <button className="btn btn-secondary btn-small" type="button" onClick={() => setQuery("")}>Clear search</button>
                  ) : null}
                />
              ) : null}
            </section>
          ) : null}

          {activeView === "settings" ? (
            <div className="platform-settings-grid">
              <section className="platform-table-card">
                <div className="platform-card-header">
                  <div>
                    <h2>Platoon management</h2>
                    <p>Create a workspace only when the unit structure changes.</p>
                  </div>
                  <button className="btn btn-secondary btn-small" type="button" disabled={hasPlatformAction} onClick={openCreateTenant}>
                    <Plus aria-hidden="true" />
                    <span>Create platoon</span>
                  </button>
                </div>
                <div className="platform-summary-table" role="table" aria-label="Platform totals">
                  <div role="row"><span>Total platoons</span><strong>{tenants.length}</strong></div>
                  <div role="row"><span>Active platoons</span><strong>{activeTenants.length}</strong></div>
                  <div role="row"><span>Permanent users</span><strong>{totalMembers}</strong></div>
                  <div role="row"><span>Platoon admins</span><strong>{totalAdmins}</strong></div>
                </div>
              </section>
              <details className="platform-table-card platform-setup-details">
                <summary>
                  <span><strong>Technical workspace checks</strong><small>DNS, account groups, storage, and packet readiness</small></span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                {renderSetupChecklist()}
              </details>
            </div>
          ) : null}

          {activeView === "support" ? (
            <div className="platform-settings-grid">
              <section className="platform-table-card platform-support-contact">
                <span className="platform-stat-icon blue"><MessageSquare aria-hidden="true" /></span>
                <div>
                  <h2>Need help with Shadow Tracer?</h2>
                  <p>For any issues with Shadow Tracer, contact Lewis Benson.</p>
                  <a className="btn btn-primary" href="mailto:tm.lewisbenson@gmail.com">tm.lewisbenson@gmail.com</a>
                </div>
              </section>
              <details className="platform-table-card platform-setup-details">
                <summary>
                  <span><strong>Technical diagnostics</strong><small>Include these details when troubleshooting.</small></span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <button className="btn btn-secondary btn-small" type="button" onClick={copyDiagnostics}>
                  <Copy aria-hidden="true" />
                  <span>Copy diagnostics</span>
                </button>
                <div className="platform-diagnostics-grid">
                  {diagnostics.map(([label, value]) => (
                    <div className="platform-diagnostic" key={label}>
                      <span>{label}</span>
                      {label === "API health" ? (
                        <a className="platform-health-link" href={value} target="_blank" rel="noreferrer">{value}</a>
                      ) : (
                        <strong>{value}</strong>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          ) : null}
        </div>
      </main>

      {pendingRoleChange ? (
        <div className="modal-backdrop platform-modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget && !hasPlatformAction) setPendingRoleChange(null);
        }}>
          <section className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirmRoleTitle">
            <div className="platform-modal-heading">
              <div>
                <p className="eyebrow">Confirm role change</p>
                <h2 id="confirmRoleTitle">Change this user’s access?</h2>
              </div>
              <button className="icon-button" type="button" disabled={hasPlatformAction} onClick={() => setPendingRoleChange(null)} aria-label="Cancel role change"><X aria-hidden="true" /></button>
            </div>
            <p>
              <strong>{pendingRoleChange.user.displayName || pendingRoleChange.user.email}</strong> will become {formatTeamRole(pendingRoleChange.nextRole)} in {pendingRoleChange.membership.tenantName}.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" disabled={hasPlatformAction} onClick={() => setPendingRoleChange(null)}>Cancel</button>
              <button className="btn btn-primary" type="button" disabled={hasPlatformAction} onClick={confirmPlatformRoleChange}>Confirm role change</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingStatusChange ? (
        <div className="modal-backdrop platform-modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget && !hasPlatformAction) setPendingStatusChange(null);
        }}>
          <section className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirmUserStatusTitle">
            <div className="platform-modal-heading">
              <div>
                <p className="eyebrow">Confirm access change</p>
                <h2 id="confirmUserStatusTitle">{pendingStatusChange.nextStatus === "active" ? "Enable this account?" : "Disable this account?"}</h2>
              </div>
              <button className="icon-button" type="button" disabled={hasPlatformAction} onClick={() => setPendingStatusChange(null)} aria-label="Cancel status change"><X aria-hidden="true" /></button>
            </div>
            <p>
              <strong>{pendingStatusChange.user.displayName || pendingStatusChange.user.email}</strong> will be {pendingStatusChange.nextStatus === "active" ? "enabled" : "disabled"} in {pendingStatusChange.membership.tenantName}. Account access will be updated automatically.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" disabled={hasPlatformAction} onClick={() => setPendingStatusChange(null)}>Cancel</button>
              <button className={pendingStatusChange.nextStatus === "active" ? "btn btn-primary" : "btn btn-danger-soft"} type="button" disabled={hasPlatformAction} onClick={confirmPlatformStatusChange}>
                {pendingStatusChange.nextStatus === "active" ? "Enable account" : "Disable account"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isAddUserOpen ? (
        <div className="modal-backdrop platform-modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) closeAddPlatformUser();
        }}>
          <aside className="platform-create-modal" role="dialog" aria-modal="true" aria-labelledby="addPlatformUserTitle">
            <div className="platform-modal-heading">
              <div>
                <p className="eyebrow">Permanent account</p>
                <h2 id="addPlatformUserTitle">Add a user</h2>
              </div>
              <button className="icon-button" type="button" disabled={platformActionRef.current.has("add-user")} onClick={closeAddPlatformUser} aria-label="Close add user"><X aria-hidden="true" /></button>
            </div>

            <StatusLine status={addUserStatus} />

            <form className="admin-form" onSubmit={createPlatformMember}>
              <label className="field-label" htmlFor="platformMemberTenant">Platoon</label>
              <select
                id="platformMemberTenant"
                className="select"
                required
                autoFocus
                disabled={platformActionRef.current.has("add-user")}
                value={platformMemberForm.tenantSlug}
                onChange={event => updatePlatformMemberForm("tenantSlug", event.target.value)}
              >
                {activeTenants.map(tenant => <option key={tenant.id} value={tenant.slug}>{tenantDisplayName(tenant)}</option>)}
              </select>

              <label className="field-label" htmlFor="platformMemberEmail">Email</label>
              <input
                id="platformMemberEmail"
                className="input"
                type="email"
                required
                disabled={platformActionRef.current.has("add-user")}
                value={platformMemberForm.email}
                placeholder="user@example.com"
                onChange={event => updatePlatformMemberForm("email", event.target.value)}
              />

              <label className="field-label" htmlFor="platformMemberName">Name</label>
              <input
                id="platformMemberName"
                className="input"
                disabled={platformActionRef.current.has("add-user")}
                value={platformMemberForm.displayName}
                placeholder="SGT Smith"
                onChange={event => updatePlatformMemberForm("displayName", event.target.value)}
              />

              <label className="field-label" htmlFor="platformMemberRole">Role</label>
              <select
                id="platformMemberRole"
                className="select"
                disabled={platformActionRef.current.has("add-user")}
                value={platformMemberForm.role}
                onChange={event => updatePlatformMemberForm("role", event.target.value)}
              >
                <option value="tenant_admin">Platoon admin</option>
                <option value="contributor">Member</option>
                <option value="viewer">Viewer</option>
              </select>

              {visiblePlatformMemberIdentityCheck?.status === "ambiguous" ? (
                <fieldset className="identity-choice-fieldset">
                  <legend>Choose the correct sign-in account</legend>
                  <p>Multiple existing accounts use this email.</p>
                  <div className="identity-choice-list">
                    {visiblePlatformMemberIdentityCheck.candidates.map(candidate => (
                      <label className={`identity-choice${candidate.eligible ? "" : " blocked"}`} key={candidate.id}>
                        <input
                          type="radio"
                          name="platformMemberIdentity"
                          value={candidate.id}
                          checked={visiblePlatformMemberIdentityCheck.selectedId === candidate.id}
                          disabled={platformActionRef.current.has("add-user") || !candidate.eligible}
                          onChange={() => setPlatformMemberIdentityCheck(current => current ? { ...current, selectedId: candidate.id } : current)}
                        />
                        <span>
                          <strong>{candidate.displayName}</strong>
                          <small>@{candidate.username}</small>
                          {candidate.blockedReason ? <small className="identity-blocked-reason">{candidate.blockedReason}</small> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <div className="button-row platform-modal-actions">
                <button className="btn btn-primary btn-full" type="submit" disabled={platformActionRef.current.has("add-user") || (visiblePlatformMemberIdentityCheck?.status === "ambiguous" && !visiblePlatformMemberIdentityCheck.selectedId)}>
                  <UserPlus aria-hidden="true" />
                  <span>{platformActionRef.current.has("add-user") ? "Adding user..." : "Add user"}</span>
                </button>
                <button className="btn btn-secondary btn-full" type="button" disabled={platformActionRef.current.has("add-user")} onClick={closeAddPlatformUser}>Cancel</button>
              </div>
            </form>
          </aside>
        </div>
      ) : null}

      {isCreateOpen ? (
        <div
          className="modal-backdrop platform-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeCreateTenant();
          }}
        >
          <aside className="platform-create-modal" role="dialog" aria-modal="true" aria-labelledby="createPlatoonTitle" onKeyDown={handleCreateTenantKeyDown}>
            <div className="platform-modal-heading">
              <div>
                <p className="eyebrow">New workspace</p>
                <h2 id="createPlatoonTitle">Create platoon</h2>
              </div>
              <button className="icon-button" type="button" disabled={Boolean(createAction)} onClick={closeCreateTenant} aria-label="Close create platoon">
                <XCircle aria-hidden="true" />
              </button>
            </div>

            <StatusLine status={createStatus} />

            <form className="admin-form" onSubmit={createTenant} aria-busy={Boolean(createAction)}>
              <label className="field-label" htmlFor="tenantName">Platoon name</label>
              <input
                id="tenantName"
                className="input"
                required
                autoFocus
                disabled={Boolean(createAction)}
                value={form.name}
                placeholder="1st Platoon"
                onChange={e => updateForm("name", e.target.value)}
              />

              <label className="field-label" htmlFor="tenantSlug">Workspace link</label>
              <div className="input-suffix-row">
                <input
                  id="tenantSlug"
                  className="input"
                  required
                  disabled={Boolean(createAction)}
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
                disabled={!platformProvisioningAvailable || Boolean(createAction)}
                value={form.adminEmail}
                placeholder="admin@example.com"
                onChange={e => updateForm("adminEmail", e.target.value)}
              />

              {visibleCreateIdentityCheck?.status === "ambiguous" ? (
                <fieldset className="identity-choice-fieldset">
                  <legend>Choose the correct sign-in account</legend>
                  <p>Multiple existing accounts use this email. Select the account for the first platoon admin.</p>
                  <div className="identity-choice-list">
                    {visibleCreateIdentityCheck.candidates.map(candidate => (
                      <label className={`identity-choice${candidate.eligible ? "" : " blocked"}`} key={candidate.id}>
                        <input
                          type="radio"
                          name="createTenantIdentity"
                          value={candidate.id}
                          checked={visibleCreateIdentityCheck.selectedId === candidate.id}
                          disabled={Boolean(createAction) || !candidate.eligible}
                          onChange={() => setCreateIdentityCheck(current => current ? { ...current, selectedId: candidate.id } : current)}
                        />
                        <span>
                          <strong>{candidate.displayName}</strong>
                          <small>@{candidate.username}</small>
                          {candidate.blockedReason ? <small className="identity-blocked-reason">{candidate.blockedReason}</small> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <label className="field-label" htmlFor="tenantAdminName">Platoon admin name</label>
              <input
                id="tenantAdminName"
                className="input"
                disabled={!platformProvisioningAvailable || Boolean(createAction)}
                value={form.adminDisplayName}
                placeholder="PSG Smith"
                onChange={e => updateForm("adminDisplayName", e.target.value)}
              />

              <div className="button-row platform-modal-actions">
                <button
                  className="btn btn-primary btn-full"
                  type="submit"
                  disabled={Boolean(createAction) || (visibleCreateIdentityCheck?.status === "ambiguous" && !visibleCreateIdentityCheck.selectedId)}
                >
                  <Plus aria-hidden="true" />
                  <span>{createAction ? "Creating platoon..." : "Create platoon"}</span>
                </button>
                <button className="btn btn-secondary btn-full" type="button" disabled={Boolean(createAction)} onClick={closeCreateTenant}>
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
  canSubmit,
  preferredSessionId,
  onSessionChange,
  onCreateSession,
  onOpenSessions,
  onOpenSession,
  onOpenUpload,
  onInviteCrew,
  onOpenReview,
  showWorkQueue = false
}) {
  const isMobileViewport = useMediaQuery("(max-width: 860px)");
  const [sessions, setSessions] = useState([]);
  const [pendingItems, setPendingItems] = useState([]);
  const [assignmentList, setAssignmentList] = useState("available");
  const [claimingItemId, setClaimingItemId] = useState("");
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
  const resolvedRows = openSessions.reduce((total, session) => total + Number(session.foundCount || 0), 0);
  const overallProgress = totalRows ? Math.round((resolvedRows / totalRows) * 100) : 0;

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
    return item.locationHint || item.inventoryItem?.currentLocation || "";
  }

  async function claimDashboardItem(item) {
    if (!item?.id || claimingItemId) return;
    setClaimingItemId(item.id);
    try {
      setStatus({ text: "Claiming item...", isError: false });
      await apiRequest(`/session-items/${item.id}/assignment`, {
        method: "PATCH",
        token,
        tenantSlug,
        body: { memberId: "self" }
      });
      const sessionId = item.session?.id || selectedSession?.id;
      if (sessionId) {
        const nextDetail = await apiRequest(`/inventory/sessions/${sessionId}`, { token, tenantSlug });
        const rowSession = nextDetail.session || selectedSession;
        setPendingItems((nextDetail.items || [])
          .filter(row => !sessionItemIsComplete(row))
          .sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b))
          .map(row => ({ ...row, session: rowSession })));
      }
      setAssignmentList("mine");
      setStatus({ text: "Item claimed. It is now in Mine.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setClaimingItemId("");
    }
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
  const dashboardPreviewLimit = isMobileViewport ? 3 : 5;
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
      item.priorInventoryHistory?.sessionName,
      item.priorInventoryHistory?.locationText,
      item.priorInventoryHistory?.inventoriedAt,
      item.status,
      item.session?.name,
      assignedPerson(item)
    ], query))
    .slice(0, dashboardPreviewLimit);
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
  ], query)).slice(0, dashboardPreviewLimit);

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
          <span>Resolved</span>
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

      <div className={`leader-dashboard-grid ${!canManage || !showWorkQueue ? "single" : ""}`}>
        {showWorkQueue ? (
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
              const priorSnapshot = getPriorInventorySnapshot(item);
              const imageUrls = priorSnapshot?.photos.length
                ? priorSnapshot.photos.map(photo => photo.url)
                : getInventoryItemImages(item.inventoryItem);
              const currentLocation = itemLocation(item);
              const assignedName = assignedPerson(item);
              const canClaimItem = Boolean(canSubmit && !item.assignedTo && !item.assignedToEmail && sessionItemAssignmentBucket(item, me) === "available");
              return (
                <article className="leader-table-row" key={item.id}>
                  <div className="leader-item-cell">
                    <span className="leader-thumb">
                      {imageUrls[0] ? <ProtectedMediaImage src={imageUrls[0]} alt="" loading="lazy" /> : <FileText aria-hidden="true" />}
                    </span>
                    <div>
                      <strong>{itemTitle(item)}</strong>
                      <span>{item.session?.name || "Inventory session"}</span>
                      <small>{assignedName ? `Assigned to ${assignedName}` : "Unassigned"}</small>
                    </div>
                  </div>
                  {currentLocation && currentLocation !== priorSnapshot?.location ? <span>{currentLocation}</span> : null}
                  <PriorInventorySnapshot item={item} />
                  <span className={`status-pill ${item.status}`}>{formatItemStatus(item.status)}</span>
                  {canClaimItem ? (
                    <button className="btn btn-primary btn-small" type="button" disabled={Boolean(claimingItemId)} onClick={() => claimDashboardItem(item)}>
                      <UserPlus aria-hidden="true" />
                      <span>{claimingItemId === item.id ? "Claiming..." : "Claim item"}</span>
                    </button>
                  ) : null}
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
        ) : null}

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
                      {photo ? <ProtectedMediaImage src={photo} alt="" loading="lazy" /> : <Camera aria-hidden="true" />}
                    </span>
                    <div>
                      <strong>{submission.sessionItem?.packetLine || "Submitted proof"}</strong>
                      <span>{submission.submittedByName || submission.submittedByEmail || "Submitted"}</span>
                    </div>
                  </div>
                  <span>{submission.reviewNote || submission.note || formatReviewState(submission.reviewState)}</span>
                  <span className={`status-pill ${submission.reviewState}`}>{formatReviewState(submission.reviewState)}</span>
                  <button className="btn btn-secondary btn-small" type="button" onClick={onOpenReview}>
                    <span>Review proof</span>
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
                ) : null}
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
  const [draft, setDraft] = useState({ displayName: "", alertRecipientEmail: "", notificationPreferences: {} });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [status, setStatus] = useState({ text: "Loading settings...", isError: false });
  const settingsLoadSequence = useRef(0);
  const settingsActionRef = useRef("");

  function applySettings(settings) {
    const loaded = settings || {};
    setSettingsData(loaded);
    setDraft({
      displayName: loaded.displayName || "",
      alertRecipientEmail: loaded.alertRecipientEmail || "",
      notificationPreferences: { ...(loaded.notificationPreferences || {}) }
    });
  }

  async function loadSettings() {
    if (settingsActionRef.current) return;
    settingsActionRef.current = "load";
    const loadSequence = ++settingsLoadSequence.current;
    try {
      setIsLoading(true);
      setStatus({ text: "Loading settings...", isError: false });
      const data = await apiRequest("/tenant/settings", { token, tenantSlug });
      if (loadSequence !== settingsLoadSequence.current) return;
      applySettings(data.settings);
      setStatus({ text: "", isError: false });
    } catch (error) {
      if (loadSequence !== settingsLoadSequence.current) return;
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      if (loadSequence === settingsLoadSequence.current) setIsLoading(false);
      if (settingsActionRef.current === "load") settingsActionRef.current = "";
    }
  }

  useEffect(() => {
    loadSettings();
  }, [tenantSlug, token]);

  async function saveSettings(event) {
    event.preventDefault();
    if (settingsActionRef.current) return;
    settingsActionRef.current = "save";
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
          alertRecipientEmail: draft.alertRecipientEmail.trim(),
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
      if (settingsActionRef.current === "save") settingsActionRef.current = "";
    }
  }

  async function copyWorkspaceUrl() {
    if (settingsActionRef.current) return;
    settingsActionRef.current = "copy";
    setIsCopying(true);
    try {
      const copied = await copyText(settingsData?.workspace?.url || "");
      setStatus({ text: copied ? "Workspace URL copied." : "Could not copy the workspace URL.", isError: !copied });
    } finally {
      setIsCopying(false);
      if (settingsActionRef.current === "copy") settingsActionRef.current = "";
    }
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
                disabled={isLoading || isSaving}
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
        <button className="btn btn-secondary" type="button" onClick={loadSettings} disabled={isLoading || isSaving || isCopying}>
          <RefreshCw aria-hidden="true" />
          <span>{isLoading ? "Refreshing..." : "Refresh"}</span>
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
            disabled={isLoading || isSaving}
            onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))}
          />
          <div className="settings-workspace-link">
            <div>
              <span>Workspace link</span>
              <a href={settingsData?.workspace?.url || "#"}>{settingsData?.workspace?.url || "Loading..."}</a>
            </div>
            <button className="btn btn-secondary" type="button" onClick={copyWorkspaceUrl} disabled={isLoading || isSaving || isCopying || !settingsData?.workspace?.url}>
              <Copy aria-hidden="true" />
              <span>{isCopying ? "Copying..." : "Copy workspace URL"}</span>
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
          <div className="settings-alert-recipient">
            <label className="field-label" htmlFor="alertRecipientEmail">Proof alert recipient</label>
            <input
              id="alertRecipientEmail"
              className="input"
              type="email"
              value={draft.alertRecipientEmail}
              disabled={isLoading || isSaving}
              placeholder="Use active platoon admins"
              onChange={event => setDraft(current => ({ ...current, alertRecipientEmail: event.target.value }))}
            />
            <small>Set one address to route proof-submitted alerts there. Leave blank to email active platoon admins.</small>
          </div>
          <div className="settings-preference-grid">
            {renderPreferenceGroup("inApp", "In-app alerts", "Choose which workflow events appear under the bell.")}
            {renderPreferenceGroup("email", "Email alerts", "Choose which proof events send workflow email when SMTP is configured.")}
          </div>
        </section>

        <div className="settings-save-bar">
          <StatusLine status={status} />
          <button className="btn btn-primary" type="submit" disabled={isLoading || isSaving || isCopying || !draft.displayName.trim()}>
            <CheckCircle2 aria-hidden="true" />
            <span>{isSaving ? "Saving..." : "Save settings"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function equipmentIdentifiers(entry) {
  return [
    ...(entry?.lins || []).map(value => `LIN ${value}`),
    ...(entry?.nsns || []).map(value => `NSN ${value}`)
  ].filter(Boolean);
}

function equipmentLocationText(location) {
  return String(location?.locationText || location?.location || "").trim();
}

function equipmentLatest(entry) {
  return entry?.latest || {
    outcome: entry?.latestOutcome,
    sessionName: entry?.latestSessionName,
    sessionStatus: entry?.latestSessionStatus,
    observedAt: entry?.latestObservedAt
  };
}

function equipmentReportedLocations(entry) {
  return entry?.recentFoundLocations || entry?.locations || [];
}

function equipmentOpenInventoryLabel(sessionStatus) {
  const normalizedStatus = String(sessionStatus || "").trim().toLowerCase();
  return normalizedStatus && normalizedStatus !== "closed" ? "Open inventory" : "";
}

function equipmentEntrySearchValues(entry) {
  const latest = equipmentLatest(entry);
  return [
    entry?.displayName,
    entry?.key,
    latest?.outcome,
    latest?.sessionName,
    latest?.sessionStatus,
    latest?.observedAt,
    entry?.lastFound?.locationText,
    entry?.lastFound?.sessionName,
    entry?.lastFound?.observedAt,
    entry?.photoContext?.sessionName,
    ...(entry?.lins || []),
    ...(entry?.nsns || []),
    ...equipmentReportedLocations(entry).flatMap(location => [
      equipmentLocationText(location),
      location?.sessionName,
      location?.observedAt
    ])
  ];
}

function EquipmentLibraryPanel({ token, tenantSlug, query, onQueryChange = () => {} }) {
  const [entries, setEntries] = useState([]);
  const [unlinkedActiveRows, setUnlinkedActiveRows] = useState([]);
  const [rememberedLinks, setRememberedLinks] = useState([]);
  const [generatedAt, setGeneratedAt] = useState("");
  const [status, setStatus] = useState({ text: "Loading equipment library...", isError: false });
  const [isLoading, setIsLoading] = useState(true);
  const [linkingRow, setLinkingRow] = useState(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkTargetKey, setLinkTargetKey] = useState("");
  const [linkStatus, setLinkStatus] = useState({ text: "", isError: false });
  const [linkAction, setLinkAction] = useState("");
  const [removingLinkId, setRemovingLinkId] = useState("");
  const [photoViewer, setPhotoViewer] = useState(null);
  const loadRequestRef = useRef(0);
  const linkTriggerRef = useRef(null);
  const photoTriggerRef = useRef(null);

  async function loadEquipmentLibrary({ quiet = false } = {}) {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    try {
      if (!quiet) {
        setIsLoading(true);
        setStatus({ text: "Loading equipment library...", isError: false });
      }
      const data = await apiRequest("/inventory/equipment-library", { token, tenantSlug });
      if (requestId !== loadRequestRef.current) return false;
      setEntries(data.entries || []);
      setUnlinkedActiveRows(data.unlinkedActiveRows || []);
      setRememberedLinks(data.rememberedLinks || []);
      setGeneratedAt(data.generatedAt || "");
      if (!quiet) setStatus({ text: "", isError: false });
      return true;
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
    } finally {
      if (requestId === loadRequestRef.current) setIsLoading(false);
    }
  }

  useEffect(() => {
    loadEquipmentLibrary();
  }, [tenantSlug, token]);

  useEffect(() => {
    if (!linkingRow && !photoViewer) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [Boolean(linkingRow), Boolean(photoViewer)]);

  const visibleEntries = useMemo(() => entries
    .filter(entry => matchesSearch(equipmentEntrySearchValues(entry), query))
    .sort((first, second) => String(first.displayName || first.key).localeCompare(String(second.displayName || second.key))), [entries, query]);
  const visibleUnlinkedRows = useMemo(() => unlinkedActiveRows.filter(row => matchesSearch([
    row.packetLine,
    row.sessionName,
    row.expectedQty
  ], query)), [unlinkedActiveRows, query]);
  const linkChoices = useMemo(() => entries
    .filter(entry => matchesSearch(equipmentEntrySearchValues(entry), linkSearch))
    .sort((first, second) => String(first.displayName || first.key).localeCompare(String(second.displayName || second.key))), [entries, linkSearch]);

  function openLinkDialog(row, trigger) {
    linkTriggerRef.current = trigger || document.activeElement;
    setLinkingRow(row);
    setLinkSearch("");
    setLinkTargetKey("");
    setLinkStatus({ text: "", isError: false });
  }

  function closeLinkDialog() {
    if (linkAction) return;
    setLinkingRow(null);
    setLinkSearch("");
    setLinkTargetKey("");
    setLinkStatus({ text: "", isError: false });
    window.requestAnimationFrame(() => linkTriggerRef.current?.focus?.());
  }

  async function rememberEquipmentLink(event) {
    event.preventDefault();
    if (!linkingRow?.id || !linkTargetKey || linkAction) {
      if (!linkTargetKey) setLinkStatus({ text: "Choose the equipment this row belongs to.", isError: true });
      return;
    }
    setLinkAction("save");
    setLinkStatus({ text: "Remembering link...", isError: false });
    try {
      await apiRequest("/inventory/equipment-library/links", {
        method: "POST",
        token,
        tenantSlug,
        body: {
          sourceSessionItemId: linkingRow.id,
          targetEntryKey: linkTargetKey
        }
      });
      await loadEquipmentLibrary({ quiet: true });
      setLinkingRow(null);
      setLinkSearch("");
      setLinkTargetKey("");
      setStatus({ text: "Equipment link remembered for matching packet wording.", isError: false });
      window.requestAnimationFrame(() => linkTriggerRef.current?.focus?.());
    } catch (error) {
      setLinkStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setLinkAction("");
    }
  }

  async function removeRememberedLink(link) {
    if (!link?.id || removingLinkId) return;
    setRemovingLinkId(link.id);
    setStatus({ text: "Removing remembered link...", isError: false });
    try {
      await apiRequest(`/inventory/equipment-library/links/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
        token,
        tenantSlug
      });
      await loadEquipmentLibrary({ quiet: true });
      setStatus({ text: "Remembered equipment link removed.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setRemovingLinkId("");
    }
  }

  function openEquipmentPhoto(entry, index, trigger) {
    if (!entry?.photos?.length) return;
    const photoContext = entry.photoContext || entry.lastFound || {};
    photoTriggerRef.current = trigger || document.activeElement;
    setPhotoViewer({
      photos: entry.photos,
      index,
      isZoomed: false,
      title: "Equipment photo",
      packetLine: entry.displayName || "Equipment",
      sessionName: photoContext.sessionName || "Approved inventory",
      submittedBy: "Approved found inventory",
      personLabel: "Source",
      sourceContextLabel: equipmentOpenInventoryLabel(photoContext.sessionStatus || entry.lastFound?.sessionStatus),
      createdAt: photoContext.observedAt || entry.lastFound?.observedAt,
      dateLabel: "Found",
      locationText: photoContext.locationText || entry.lastFound?.locationText || ""
    });
  }

  function closeEquipmentPhoto() {
    setPhotoViewer(null);
    window.requestAnimationFrame(() => photoTriggerRef.current?.focus?.());
  }

  function moveEquipmentPhoto(delta) {
    setPhotoViewer(current => {
      if (!current?.photos?.length) return current;
      return {
        ...current,
        index: (current.index + delta + current.photos.length) % current.photos.length,
        isZoomed: false
      };
    });
  }

  return (
    <div className="leader-dashboard equipment-library-page">
      <div className="leader-page-heading">
        <div>
          <h1>Equipment Library</h1>
          <p>Automatically built from approved inventories. Locations are the last places equipment was reported found, not a live location.</p>
        </div>
      </div>

      <StatusLine status={status} />

      {!isLoading && entries.length ? (
        <div className="equipment-library-summary" aria-label="Equipment library summary">
          <strong>{countLabel(entries.length, "equipment record")}</strong>
          <span>{generatedAt ? `Updated ${formatRelativeTime(generatedAt)}` : "Built from approved inventory history"}</span>
        </div>
      ) : null}

      {!isLoading && visibleEntries.length ? (
        <section className="equipment-library-grid" aria-label="Equipment library results">
          {visibleEntries.map(entry => {
            const identifiers = equipmentIdentifiers(entry);
            const photos = (entry.photos || []).slice(0, 3);
            const latest = equipmentLatest(entry);
            const latestMeta = [latest?.sessionName, latest?.observedAt ? formatDate(latest.observedAt) : ""].filter(Boolean).join(" - ");
            const latestOpenInventoryLabel = equipmentOpenInventoryLabel(latest?.sessionStatus);
            const lastFound = entry.lastFound || null;
            const lastFoundMeta = [lastFound?.sessionName, lastFound?.observedAt ? formatDate(lastFound.observedAt) : ""].filter(Boolean).join(" - ");
            const lastFoundOpenInventoryLabel = equipmentOpenInventoryLabel(lastFound?.sessionStatus);
            const earlierLocations = equipmentReportedLocations(entry).filter(location => {
              const text = equipmentLocationText(location);
              if (!text) return false;
              return !(lastFound?.locationText && text === lastFound.locationText && (!location.observedAt || location.observedAt === lastFound.observedAt));
            });
            return (
              <article className="equipment-library-card" key={entry.key}>
                {photos.length ? (
                  <div className={`equipment-library-photos count-${photos.length}`} aria-label={`Found photos for ${entry.displayName}`}>
                    {photos.map((photo, index) => (
                      <button
                        type="button"
                        key={photo.id || photo.url || index}
                        aria-label={`View found photo ${index + 1} for ${entry.displayName}`}
                        aria-haspopup="dialog"
                        onClick={event => openEquipmentPhoto(entry, index, event.currentTarget)}
                      >
                        <ProtectedMediaImage src={photo.url} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="equipment-library-card-body">
                  <header className="equipment-library-card-heading">
                    <div>
                      <h2>{entry.displayName || "Unnamed equipment"}</h2>
                      {identifiers.length ? <p>{identifiers.join(" - ")}</p> : null}
                    </div>
                    {latest?.outcome || latestOpenInventoryLabel ? (
                      <div className="equipment-library-result-badges">
                        {latest?.outcome ? <span className={`status-pill ${latest.outcome}`}>{formatItemStatus(latest.outcome)}</span> : null}
                        {latestOpenInventoryLabel ? <span className="equipment-open-inventory">{latestOpenInventoryLabel}</span> : null}
                      </div>
                    ) : null}
                  </header>

                  {latestMeta ? <p className="equipment-library-latest"><strong>Latest approved result</strong><span>{latestMeta}</span></p> : null}

                  {lastFound ? (
                    <section className="equipment-last-found" aria-label={`Last found details for ${entry.displayName}`}>
                      <span>Last found</span>
                      {lastFound.locationText ? <strong>{lastFound.locationText}</strong> : null}
                      {lastFoundMeta || lastFoundOpenInventoryLabel ? (
                        <small className="equipment-context-line">
                          {lastFoundMeta ? <span>{lastFoundMeta}</span> : null}
                          {lastFoundOpenInventoryLabel ? <span className="equipment-open-inventory">{lastFoundOpenInventoryLabel}</span> : null}
                        </small>
                      ) : null}
                      {lastFound.expectedQty != null ? <small>Quantity on record: {lastFound.expectedQty}</small> : null}
                    </section>
                  ) : null}

                  {earlierLocations.length ? (
                    <section className="equipment-prior-locations" aria-label={`Earlier reported locations for ${entry.displayName}`}>
                      <h3>Earlier reported locations</h3>
                      <ul>
                        {earlierLocations.slice(0, 3).map((location, index) => {
                          const locationMeta = [location.sessionName, location.observedAt ? formatDate(location.observedAt) : ""].filter(Boolean).join(" - ");
                          const locationOpenInventoryLabel = equipmentOpenInventoryLabel(location.sessionStatus);
                          return (
                            <li key={`${equipmentLocationText(location)}-${location.observedAt || index}`}>
                              <strong>{equipmentLocationText(location)}</strong>
                              {locationMeta || locationOpenInventoryLabel ? (
                                <span className="equipment-context-line">
                                  {locationMeta ? <span>{locationMeta}</span> : null}
                                  {locationOpenInventoryLabel ? <span className="equipment-open-inventory">{locationOpenInventoryLabel}</span> : null}
                                </span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      {earlierLocations.length > 3 ? <small>+{earlierLocations.length - 3} more reported {earlierLocations.length - 3 === 1 ? "location" : "locations"}</small> : null}
                    </section>
                  ) : null}

                  <footer className="equipment-library-card-footer">
                    <span>{countLabel(Number(entry.observationCount || 0), "approved observation")}</span>
                    {Number(entry.sessionCount || 0) ? <span>{countLabel(Number(entry.sessionCount), "inventory session")}</span> : null}
                  </footer>
                </div>
              </article>
            );
          })}
        </section>
      ) : !isLoading ? (
        <EmptyPanel
          title={query.trim() ? "No matching equipment" : "No approved equipment yet"}
          body={query.trim()
            ? "Clear the search or try an equipment name, LIN, NSN, or reported location."
            : "Approved inventory proof will appear here automatically."}
          action={query.trim() ? <button className="btn btn-secondary btn-small" type="button" onClick={() => onQueryChange("")}>Clear search</button> : null}
        />
      ) : null}

      {unlinkedActiveRows.length ? (
        <section className="leader-card equipment-exceptions" aria-label="Unmatched active rows">
          <div className="equipment-section-heading">
            <div>
              <p className="eyebrow">Manual exceptions</p>
              <h2>Unmatched active rows</h2>
              <p>Operational rows normally link automatically. Remember a link only when the row is the same equipment; this does not merge serialized assets.</p>
            </div>
            <span>{unlinkedActiveRows.length}</span>
          </div>
          <div className="equipment-exception-list">
            {visibleUnlinkedRows.length ? visibleUnlinkedRows.map(row => (
              <article className="equipment-exception-row" key={row.id}>
                <div>
                  <strong>{row.packetLine || "Unnamed packet row"}</strong>
                  {row.sessionName ? <span>{row.sessionName}</span> : null}
                  {row.expectedQty != null ? <small>Quantity: {row.expectedQty}</small> : null}
                </div>
                <button className="btn btn-secondary btn-small" type="button" onClick={event => openLinkDialog(row, event.currentTarget)}>Link to equipment</button>
              </article>
            )) : <p className="equipment-section-empty">No unmatched active rows match this search.</p>}
          </div>
        </section>
      ) : null}

      <section className="leader-card equipment-remembered-links" aria-label="Remembered links">
        <div className="equipment-section-heading">
          <div>
            <p className="eyebrow">Maintenance</p>
            <h2>Remembered links</h2>
            <p>These exceptions apply to future rows with identical packet wording. Removing one does not change past inventory evidence or merge saved assets.</p>
          </div>
          {rememberedLinks.length ? <span>{rememberedLinks.length}</span> : null}
        </div>
        {rememberedLinks.length ? (
          <div className="equipment-remembered-list">
            {rememberedLinks.map(link => (
              <article className="equipment-remembered-row" key={link.id}>
                <div>
                  <span>{link.sourcePacketLine}</span>
                  <strong>{link.targetDisplayName || link.targetEntryKey}</strong>
                  {link.createdAt ? <small>Remembered {formatDate(link.createdAt)}</small> : null}
                </div>
                <button className="btn btn-danger-soft btn-small" type="button" disabled={Boolean(removingLinkId)} onClick={() => removeRememberedLink(link)}>
                  {removingLinkId === link.id ? "Removing..." : "Remove"}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="equipment-section-empty">No manual equipment links are remembered.</p>
        )}
      </section>

      {linkingRow ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) closeLinkDialog();
        }}>
          <form className="modal-panel equipment-link-panel" role="dialog" aria-modal="true" aria-labelledby="equipmentLinkTitle" onSubmit={rememberEquipmentLink} onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeLinkDialog();
            }
          }}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Manual exception</p>
                <h2 id="equipmentLinkTitle">Link unmatched row</h2>
                <p className="modal-copy">Choose the equipment represented by <strong>{linkingRow.packetLine}</strong>.</p>
              </div>
              <button className="icon-button" type="button" aria-label="Close equipment link" disabled={Boolean(linkAction)} onClick={closeLinkDialog}><X aria-hidden="true" /></button>
            </div>

            <div className="equipment-link-warning">
              <Info aria-hidden="true" />
              <p>The remembered link applies to future active rows with identical packet wording. It groups operational history only and does not merge serialized assets.</p>
            </div>

            <label className="equipment-link-search">
              <span>Search equipment</span>
              <input className="input" type="search" value={linkSearch} autoFocus placeholder="Name, LIN, NSN, or reported location" onChange={event => setLinkSearch(event.target.value)} />
            </label>

            <div className="equipment-link-choices" role="radiogroup" aria-label="Equipment link choices">
              {linkChoices.length ? linkChoices.map(entry => {
                const identifiers = equipmentIdentifiers(entry);
                return (
                  <label className={`equipment-link-choice ${linkTargetKey === entry.key ? "selected" : ""}`} key={entry.key}>
                    <input type="radio" name="equipmentLinkTarget" value={entry.key} checked={linkTargetKey === entry.key} onChange={() => {
                      setLinkTargetKey(entry.key);
                      setLinkStatus({ text: "", isError: false });
                    }} />
                    {entry.photos?.[0]?.url ? <ProtectedMediaImage src={entry.photos[0].url} alt="" loading="lazy" /> : <span className="equipment-link-choice-icon"><Camera aria-hidden="true" /></span>}
                    <span>
                      <strong>{entry.displayName || "Unnamed equipment"}</strong>
                      {identifiers.length ? <small>{identifiers.join(" - ")}</small> : null}
                      {entry.lastFound?.locationText ? <small>Last found: {entry.lastFound.locationText}</small> : null}
                    </span>
                  </label>
                );
              }) : <p className="equipment-section-empty">No equipment matches this search.</p>}
            </div>

            <StatusLine status={linkStatus} />
            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" disabled={Boolean(linkAction)} onClick={closeLinkDialog}>Cancel</button>
              <button className="btn btn-primary" type="submit" disabled={Boolean(linkAction) || !linkTargetKey}>{linkAction ? "Remembering..." : "Remember link"}</button>
            </div>
          </form>
        </div>
      ) : null}

      <ProofPhotoViewer
        viewer={photoViewer}
        onClose={closeEquipmentPhoto}
        onMove={moveEquipmentPhoto}
        onSelect={index => setPhotoViewer(current => current ? { ...current, index, isZoomed: false } : current)}
        onToggleZoom={() => setPhotoViewer(current => current ? { ...current, isZoomed: !current.isZoomed } : current)}
      />
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
  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState({ text: "Loading reports...", isError: false });
  const reportsLoadRef = useRef(false);

  async function loadReports() {
    if (reportsLoadRef.current) return;
    reportsLoadRef.current = true;
    try {
      setIsLoading(true);
      setStatus({ text: "Loading reports...", isError: false });
      const data = await apiRequest("/inventory/reports", { token, tenantSlug });
      setSessions(data.sessions || []);
      setRows(data.rows || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      reportsLoadRef.current = false;
      setIsLoading(false);
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

  function formatReportDuration(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "In progress";
    const totalMinutes = Math.round(totalSeconds / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return [days ? `${days}d` : "", hours ? `${hours}h` : "", (!days && minutes) || (!days && !hours) ? `${minutes}m` : ""].filter(Boolean).join(" ");
  }

  const visibleReportSessions = sessions.filter(session => {
    if (sessionFilter !== "all" && session.id !== sessionFilter) return false;
    if (lifecycleFilter === "open" && session.status === "closed") return false;
    if (lifecycleFilter === "closed" && session.status !== "closed") return false;
    return true;
  });

  return (
    <div className={`leader-dashboard reports-page ${isPrintTarget ? "reports-print-target" : ""}`}>
      <div className="leader-page-heading reports-screen-only">
        <div>
          <h1>Reports</h1>
          <p>Review outcomes and proof status across inventory sessions.</p>
        </div>
        <div className="leader-page-actions">
          <button className="btn btn-primary" type="button" onClick={exportReportsCsv} disabled={isLoading || !visibleRows.length}>
            <Download aria-hidden="true" /><span>Export CSV</span>
          </button>
          <button className="btn btn-secondary desktop-secondary-action" type="button" onClick={loadReports} disabled={isLoading}>
            <RefreshCw aria-hidden="true" /><span>{isLoading ? "Refreshing..." : "Refresh"}</span>
          </button>
          <button className="btn btn-secondary desktop-secondary-action" type="button" onClick={printSummary} disabled={isLoading || !visibleRows.length}>
            <Printer aria-hidden="true" /><span>Print summary</span>
          </button>
          <ResponsiveActionMenu
            className="mobile-secondary-actions"
            label={isLoading ? "Refreshing..." : "More actions"}
            ariaLabel={isLoading ? "Refreshing report" : "More actions"}
            disabled={isLoading}
          >
            <button type="button" onClick={loadReports} disabled={isLoading}>
              <RefreshCw aria-hidden="true" /><span>{isLoading ? "Refreshing report..." : "Refresh report"}</span>
            </button>
            <button type="button" onClick={printSummary} disabled={isLoading || !visibleRows.length}>
              <Printer aria-hidden="true" /><span>Print summary</span>
            </button>
          </ResponsiveActionMenu>
        </div>
      </div>

      <section className="leader-card reports-filter-card reports-screen-only" aria-label="Report filters">
        <div className="reports-filter-grid">
          <label>
            <span>Session</span>
            <select className="select" value={sessionFilter} disabled={isLoading} onChange={event => setSessionFilter(event.target.value)}>
              <option value="all">All sessions</option>
              {sessions.map(session => <option value={session.id} key={session.id}>{session.name}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select className="select" value={lifecycleFilter} disabled={isLoading} onChange={event => setLifecycleFilter(event.target.value)}>
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
            <button className={resultFilter === value ? "active" : ""} type="button" key={value} aria-pressed={resultFilter === value} disabled={isLoading} onClick={() => setResultFilter(value)}>
              <span>{label}</span><strong>{resultCounts[value]}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="leader-card reports-session-timing reports-screen-only" aria-label="Session timing">
        <div className="leader-card-header">
          <span className="leader-card-icon"><CalendarDays aria-hidden="true" /></span>
          <div><h2>Session timing</h2><p>When each inventory started and how long it took to reach 100%.</p></div>
        </div>
        <div className="reports-session-timing-table" role="table">
          <div className="reports-session-timing-head" role="row"><span>Session</span><span>Started</span><span>Completed</span><span>Time to 100%</span></div>
          {visibleReportSessions.map(session => (
            <div className="reports-session-timing-row" role="row" key={session.id}>
              <strong>{session.name}</strong>
              <span>{formatDate(session.startedAt || session.createdAt)}</span>
              <span>{session.completedAt ? formatDate(session.completedAt) : session.status === "closed" ? "Closed before 100%" : "In progress"}</span>
              <span>{formatReportDuration(session.durationToCompletionSeconds)}</span>
            </div>
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
          <span>Session</span><span>Item</span><span>Outcome</span><span>Reported by</span><span>Proof status</span><span>Location / serial</span>
        </div>
        {visibleRows.length ? renderedRows.map(item => {
          const wasDirectlyVerified = Boolean(item.directVerifiedBy || item.directVerifiedByName || item.directVerifiedByEmail);
          const latest = wasDirectlyVerified ? null : latestSubmission(item);
          const location = latest?.locationText || item.inventoryItem?.currentLocation || item.locationHint || "No location";
          const displayName = itemDisplayName(item);
          const reportedBy = item.directVerifiedByName || item.directVerifiedByEmail || latest?.submittedByName || latest?.submittedByEmail || "—";
          return (
            <article className="reports-table reports-table-row" key={item.id}>
              <div data-label="Session"><span className="mobile-field-label">Session</span><span className="reports-field-value"><strong>{item.sessionName}</strong><small>{formatItemStatus(item.sessionStatus)}</small></span></div>
              <div data-label="Item">
                <span className="mobile-field-label">Item</span>
                <span className="reports-field-value"><strong>{displayName}</strong>{item.packetLine && item.packetLine !== displayName ? <small>{item.packetLine}</small> : null}</span>
              </div>
              <div data-label="Outcome"><span className="mobile-field-label">Outcome</span><span className={`status-pill ${reportItemOutcome(item)}`}>{formatItemStatus(reportItemOutcome(item))}</span></div>
              <div data-label="Reported by"><span className="mobile-field-label">Reported by</span><span className="reports-field-value"><span>{reportedBy}</span></span></div>
              <div data-label="Proof status"><span className="mobile-field-label">Proof status</span><span className={`status-pill ${wasDirectlyVerified ? "approved" : latest?.reviewState || "unchecked"}`}>{wasDirectlyVerified ? "Direct check" : latest?.reviewState ? formatReviewState(latest.reviewState) : "No proof"}</span></div>
              <div data-label="Location / serial"><span className="mobile-field-label">Location / serial</span><span className="reports-field-value"><span>{location}</span>{hasMeaningfulSerial(latest?.serialNumber) ? <small>Serial: {latest.serialNumber}</small> : null}</span></div>
            </article>
          );
        }) : (
          <EmptyPanel
            title={isLoading ? "Loading report" : "No report rows"}
            body={isLoading ? "Getting the latest inventory results." : "Adjust the session, status, proof, or workspace search filters."}
            action={!isLoading ? (
              <button className="btn btn-secondary btn-small" type="button" onClick={resetReportFilters}>
                <RefreshCw aria-hidden="true" />
                <span>Reset filters</span>
              </button>
            ) : null}
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

function activityDetailValue(key, value) {
  if (key === "requestedFields") {
    const proofRequestLabelByValue = new Map(proofRequestOptions.map(option => [option.value, option.label]));
    return (Array.isArray(value) ? value : [value])
      .map(field => proofRequestLabelByValue.get(field) || formatItemStatus(field))
      .join(", ");
  }
  return Array.isArray(value) ? value.join(", ") : String(value);
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

function TenantActivityPanel({ token, tenantSlug, onOpenSession, onOpenSessions, onOpenPeople, onOpenSettings }) {
  const emptyFilters = { category: "", actor: "", action: "", entityType: "", from: "", to: "" };
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [filterOptions, setFilterOptions] = useState({ actors: [], actions: [], entityTypes: [] });
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingAction, setLoadingAction] = useState("initial");
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [status, setStatus] = useState({ text: "Loading activity...", isError: false });
  const requestRef = useRef(0);
  const activityActionRef = useRef("");
  const hasFilters = Object.values(appliedFilters).some(Boolean);
  const categoryOptions = filterOptions.categories?.length ? filterOptions.categories : [
    { value: "workflow", label: "Workflow" },
    { value: "access", label: "Access" },
    { value: "workspace", label: "Workspace" },
    { value: "files", label: "Files / system" },
    { value: "other", label: "Other" }
  ];

  async function loadEvents({ append = false, cursor = "", filterValues = appliedFilters, actionKind = append ? "more" : "refresh" } = {}) {
    if (activityActionRef.current) return;
    activityActionRef.current = actionKind;
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
      setLoadingAction(actionKind);
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
      if (requestId === requestRef.current) {
        setIsLoading(false);
        setLoadingAction("");
      }
      if (activityActionRef.current === actionKind) activityActionRef.current = "";
    }
  }

  useEffect(() => {
    const initial = { ...emptyFilters };
    setFilters(initial);
    setAppliedFilters(initial);
    loadEvents({ filterValues: initial, actionKind: "initial" });
  }, [tenantSlug, token]);

  function applyFilters(event) {
    event.preventDefault();
    const next = { ...filters };
    setAppliedFilters(next);
    loadEvents({ filterValues: next, actionKind: "apply" });
  }

  function clearFilters() {
    const next = { ...emptyFilters };
    setFilters(next);
    setAppliedFilters(next);
    loadEvents({ filterValues: next, actionKind: "clear" });
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
        <button className="btn btn-secondary" type="button" disabled={isLoading} onClick={() => loadEvents({ filterValues: appliedFilters, actionKind: "refresh" })}>
          <RefreshCw aria-hidden="true" />
          <span>{loadingAction === "refresh" ? "Refreshing..." : "Refresh"}</span>
        </button>
      </div>

      <form className="leader-card activity-filters" aria-label="Activity filters" onSubmit={applyFilters}>
        <label>
          <span>Category</span>
          <select className="select" value={filters.category} disabled={isLoading} onChange={event => updateFilter("category", event.target.value)}>
            <option value="">All categories</option>
            {categoryOptions.map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Actor</span>
          <select className="select" value={filters.actor} disabled={isLoading} onChange={event => updateFilter("actor", event.target.value)}>
            <option value="">All actors</option>
            {(filterOptions.actors || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Action</span>
          <select className="select" value={filters.action} disabled={isLoading} onChange={event => updateFilter("action", event.target.value)}>
            <option value="">All actions</option>
            {(filterOptions.actions || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Entity</span>
          <select className="select" value={filters.entityType} disabled={isLoading} onChange={event => updateFilter("entityType", event.target.value)}>
            <option value="">All entities</option>
            {(filterOptions.entityTypes || []).map(option => (
              <option value={activityFilterValue(option)} key={activityFilterValue(option)}>{activityFilterLabel(option)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input className="input" type="date" value={filters.from} disabled={isLoading} onChange={event => updateFilter("from", event.target.value)} />
        </label>
        <label>
          <span>Through</span>
          <input className="input" type="date" value={filters.to} disabled={isLoading} onChange={event => updateFilter("to", event.target.value)} />
        </label>
        <div className="activity-filter-actions">
          <button className="btn btn-primary" type="submit" disabled={isLoading}>{loadingAction === "apply" ? "Applying..." : "Apply filters"}</button>
          <button className="btn btn-secondary" type="button" disabled={isLoading || (!hasFilters && !Object.values(filters).some(Boolean))} onClick={clearFilters}>{loadingAction === "clear" ? "Clearing..." : "Clear filters"}</button>
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
                          <dd>{activityDetailValue(key, value)}</dd>
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
            action={hasFilters ? (
              <button className="btn btn-secondary btn-small" type="button" onClick={clearFilters}>Clear filters</button>
            ) : (
              <button className="btn btn-primary btn-small" type="button" onClick={onOpenSessions}>Open inventory sessions</button>
            )}
          />
        ) : null}
      </section>

      {nextCursor ? (
        <button className="btn btn-secondary activity-load-more" type="button" disabled={isLoading} onClick={() => loadEvents({ append: true, cursor: nextCursor, filterValues: appliedFilters, actionKind: "more" })}>
          <History aria-hidden="true" />
          <span>{loadingAction === "more" ? "Loading older..." : "Load older activity"}</span>
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
  memberIdentityCheck,
  onClearMemberIdentityCheck,
  onSelectMemberIdentity,
  onCreateMember,
  onUpdateMember,
  onDisableMember,
  onRetryMember,
  onResolveMemberIdentity,
  onCancelMemberInvitation,
  onResendEnrollment,
  onCopyInviteLink,
  onResendInvitation,
  onRevokeInvitation,
  inviteLinksById,
  inviteActionsById,
  memberActionId,
  lastInviteUrl,
  isSaving,
  provisioningAvailable,
  canResolveIdentities,
  identityResolution,
  onSelectResolutionIdentity,
  onConfirmResolution,
  onCloseResolution
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
  const normalizedMemberEmail = String(memberForm.email || "").trim().toLowerCase();
  const visibleIdentityCheck = memberIdentityCheck?.email === normalizedMemberEmail
    ? memberIdentityCheck
    : null;
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
                    onChange={e => {
                      onClearMemberIdentityCheck?.();
                      onMemberFormChange(current => ({ ...current, email: e.target.value }));
                    }}
                  />

                  {visibleIdentityCheck?.status === "ambiguous" && visibleIdentityCheck.candidates?.length ? (
                    <fieldset className="identity-choice-fieldset">
                      <legend>Choose the correct sign-in account</legend>
                      <p>More than one existing account uses this email. Select the account this teammate should use.</p>
                      <div className="identity-choice-list">
                        {visibleIdentityCheck.candidates.map(candidate => (
                          <label className={`identity-choice${candidate.eligible ? "" : " blocked"}`} key={candidate.id}>
                            <input
                              type="radio"
                              name="memberIdentity"
                              value={candidate.id}
                              checked={visibleIdentityCheck.selectedId === candidate.id}
                              disabled={isSaving || !candidate.eligible}
                              onChange={() => onSelectMemberIdentity(candidate.id)}
                            />
                            <span>
                              <strong>{candidate.displayName}</strong>
                              <small>@{candidate.username}</small>
                              {candidate.blockedReason ? <small className="identity-blocked-reason">{candidate.blockedReason}</small> : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

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

                  <button
                    className="btn btn-primary btn-full"
                    type="submit"
                    disabled={isSaving || (visibleIdentityCheck?.status === "ambiguous" && !visibleIdentityCheck.selectedId)}
                  >
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
                const isIdentityAmbiguous = provisioning?.error?.code === "identity_ambiguous";
                const canRetry = provisioningAvailable
                  && accountState.label === "Needs attention"
                  && provisioning?.retryable === true;
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
                        {canRetry || isIdentityAmbiguous ? (
                          <div className="member-provisioning-actions">
                            {canRetry ? (
                              <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onRetryMember(member)}>
                                <RefreshCw aria-hidden="true" />
                                <span>{isWorking ? "Retrying..." : "Retry"}</span>
                              </button>
                            ) : null}
                            {isIdentityAmbiguous && canResolveIdentities ? (
                              <button className="btn btn-secondary btn-small" type="button" disabled={isWorking} onClick={() => onResolveMemberIdentity(member)}>
                                <Users aria-hidden="true" />
                                <span>{isWorking ? "Checking..." : "Resolve duplicate"}</span>
                              </button>
                            ) : null}
                            {isIdentityAmbiguous ? (
                              <button className="btn btn-danger-soft btn-small" type="button" disabled={isWorking} onClick={() => onCancelMemberInvitation(member)}>
                                <Trash2 aria-hidden="true" />
                                <span>{isWorking ? "Canceling..." : "Cancel invite"}</span>
                              </button>
                            ) : null}
                          </div>
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
              ) : (
                <button className="btn btn-secondary btn-small" type="button" onClick={openAddTeammate}>
                  {provisioningAvailable ? "Add teammate" : "Open inventory sessions"}
                </button>
              )}
            />
          )}
        </div>
      </details>

      {identityResolution ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !identityResolution.isSaving) onCloseResolution();
          }}
        >
          <div className="modal-panel member-identity-panel" role="dialog" aria-modal="true" aria-labelledby="identityResolutionTitle">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Duplicate sign-in</p>
                <h2 id="identityResolutionTitle">Choose the correct account</h2>
                <p className="modal-copy">
                  {identityResolution.member.displayName || identityResolution.member.email} has more than one account using {identityResolution.member.email}.
                </p>
              </div>
              <button className="icon-button" type="button" aria-label="Close account chooser" disabled={identityResolution.isSaving} onClick={onCloseResolution}>
                <X aria-hidden="true" />
              </button>
            </div>

            {identityResolution.error ? <div className="error-banner" role="alert">{identityResolution.error}</div> : null}

            <div className="identity-choice-list identity-resolution-list">
              {identityResolution.candidates.length ? identityResolution.candidates.map(candidate => (
                <label className={`identity-choice${candidate.eligible ? "" : " blocked"}`} key={candidate.id}>
                  <input
                    type="radio"
                    name="resolvedMemberIdentity"
                    value={candidate.id}
                    checked={identityResolution.selectedId === candidate.id}
                    disabled={identityResolution.isSaving || !candidate.eligible}
                    onChange={() => onSelectResolutionIdentity(candidate.id)}
                  />
                  <span>
                    <strong>{candidate.displayName}</strong>
                    <small>@{candidate.username}</small>
                    {candidate.blockedReason ? <small className="identity-blocked-reason">{candidate.blockedReason}</small> : null}
                  </span>
                </label>
              )) : <div className="error-banner" role="status">No matching sign-in accounts are available now. Close this window and cancel the stale invitation.</div>}
            </div>

            <p className="member-manage-note">This links the invitation to one existing sign-in account. It does not merge or delete either account.</p>
            <div className="modal-actions identity-resolution-actions">
              <button className="btn btn-secondary" type="button" disabled={identityResolution.isSaving} onClick={onCloseResolution}>Back</button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={identityResolution.isSaving || !identityResolution.selectedId}
                onClick={onConfirmResolution}
              >
                <Users aria-hidden="true" />
                <span>{identityResolution.isSaving ? "Linking account..." : "Use selected account"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
    ...(isTenantAdmin ? [{ id: "equipment", label: "Equipment", icon: ClipboardList }] : []),
    ...(isTenantAdmin ? [{ id: "reports", label: "Reports", icon: BarChart3 }] : []),
    ...(isTenantAdmin ? [{ id: "people", label: "Team", icon: Users }] : []),
    ...(isTenantAdmin ? [{ id: "activity", label: "Activity Log", icon: History }] : []),
    ...(isTenantAdmin ? [{ id: "settings", label: "Workspace Settings", icon: Settings }] : [])
  ];
  const [activeTab, setActiveTab] = useState(() => {
    const requestedTab = tenantRouteFromLocation().tab;
    return isTenantAdmin || requestedTab === "dashboard" ? requestedTab : "dashboard";
  });
  const [isSessionWorkspaceOpen, setIsSessionWorkspaceOpen] = useState(() => isCrew || tenantRouteFromLocation().panel === "sessions");
  const [isReviewWorkspaceOpen, setIsReviewWorkspaceOpen] = useState(() => isTenantAdmin && tenantRouteFromLocation().panel === "review");
  const [sessionIntent, setSessionIntent] = useState("");
  const [preferredSessionId, setPreferredSessionId] = useState(() => me?.crew?.sessionId || "");
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
  const [memberIdentityCheck, setMemberIdentityCheck] = useState(null);
  const [identityResolution, setIdentityResolution] = useState(null);
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
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
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
  const notificationActionRef = useRef(false);
  const workspaceRefreshActionRef = useRef(false);
  const logoutActionRef = useRef(false);
  const userName = me?.user?.display_name || me?.user?.displayName || me?.user?.email || "Signed in";
  const userRole = isCrew ? "Crew member" : me?.membership?.role ? formatRole(me.membership.role) : isTenantAdmin ? "Platoon admin" : "Member";
  const userInitial = String(userName || "U").slice(0, 1).toUpperCase();
  const tenantSearch = activeTab === "dashboard" && !isTenantAdmin && !isSessionWorkspaceOpen ? null : ({
    dashboard: {
      label: "Search dashboard",
      placeholder: "Search dashboard items, sessions, locations..."
    },
    equipment: {
      label: "Search equipment",
      placeholder: "Search equipment, LIN, NSN, or reported location..."
    },
    reports: {
      label: "Search reports",
      placeholder: "Search reports by item, serial, location..."
    },
    people: {
      label: "Search teammates",
      placeholder: "Search teammates, roles, status..."
    }
  }[activeTab] || null);
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
    if (logoutActionRef.current) return;
    logoutActionRef.current = true;
    setIsLoggingOut(true);
    setStatus({ text: isCrew ? "Leaving inventory..." : "Signing out...", isError: false });
    try {
      await onLogout();
    } catch (error) {
      setStatus({
        text: `${getApiErrorMessage(error)} ${isCrew ? "Try leaving the inventory again." : "Try signing out again."}`,
        isError: true
      });
    } finally {
      logoutActionRef.current = false;
      setIsLoggingOut(false);
    }
  }

  function selectTenantTab(tabId) {
    if (tabId !== activeTab) setLeaderQuery("");
    setActiveTab(tabId);
    setIsSessionWorkspaceOpen(isCrew);
    setIsReviewWorkspaceOpen(false);
    navigateAppHash(tenantTabHashes[tabId] || tenantTabHashes.dashboard);
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
      return true;
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
      return true;
    } catch (error) {
      if (silent) {
        setProvisioningPollFailures(current => Math.min(current + 1, 5));
      } else {
        setStatus({ text: getApiErrorMessage(error), isError: true });
      }
      return false;
    }
  }

  async function loadNotifications() {
    if (!tenantSlug || !token) return true;
    if (notificationActionRef.current) return null;

    notificationActionRef.current = true;
    setIsLoadingNotifications(true);
    try {
      const data = await apiRequest("/tenant/notifications", { token, tenantSlug });
      setNotifications(data.notifications || []);
      setNotificationUnreadCount(Number(data.unreadCount || 0));
      setNotificationStatus("");
      return true;
    } catch (error) {
      setNotificationStatus(getApiErrorMessage(error));
      return false;
    } finally {
      notificationActionRef.current = false;
      setIsLoadingNotifications(false);
    }
  }

  useEffect(() => {
    if (tenantSlug) {
      loadTenant({ silent: Boolean(tenant) });
      loadNotifications();
    }
  }, [tenantSlug, token, isTenantAdmin, isCrew, me?.tenant?.id]);

  useEffect(() => {
    const syncTenantRoute = () => {
      const route = tenantRouteFromLocation();
      const nextTab = navItems.some(item => item.id === route.tab) ? route.tab : "dashboard";
      setActiveTab(nextTab);
      setIsSessionWorkspaceOpen(isCrew || route.panel === "sessions");
      setIsReviewWorkspaceOpen(isTenantAdmin && route.panel === "review");
      setIsSidebarOpen(false);
      setIsNotificationsOpen(false);
      setIsUserMenuOpen(false);
    };
    window.addEventListener("hashchange", syncTenantRoute);
    window.addEventListener("popstate", syncTenantRoute);
    return () => {
      window.removeEventListener("hashchange", syncTenantRoute);
      window.removeEventListener("popstate", syncTenantRoute);
    };
  }, [isCrew, isTenantAdmin]);

  useEffect(() => {
    if (!tenantSlug || !token) return undefined;
    const refreshVisibleNotifications = () => {
      if (document.visibilityState === "visible") loadNotifications();
    };
    const intervalId = window.setInterval(refreshVisibleNotifications, 15_000);
    document.addEventListener("visibilitychange", refreshVisibleNotifications);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshVisibleNotifications);
    };
  }, [tenantSlug, token]);

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
      const email = memberForm.email.trim().toLowerCase();
      const identityData = await apiRequest("/tenant/members/identity-check", {
        method: "POST",
        token,
        tenantSlug,
        body: { email }
      });
      let selectedIdentityId = "";
      if (identityData.status === "ambiguous") {
        const candidates = identityData.candidates || [];
        const previousSelection = memberIdentityCheck?.email === email
          ? memberIdentityCheck.selectedId
          : "";
        selectedIdentityId = candidates.some(candidate => candidate.id === previousSelection && candidate.eligible)
          ? previousSelection
          : "";
        setMemberIdentityCheck({
          email,
          status: "ambiguous",
          candidates,
          selectedId: selectedIdentityId
        });
        if (!selectedIdentityId) {
          setStatus({
            text: candidates.length
              ? "Choose the correct existing sign-in account, then add the teammate."
              : "More than one sign-in account uses this email. Ask a platform administrator to choose the correct account.",
            isError: !candidates.length
          });
          return;
        }
      } else {
        setMemberIdentityCheck(null);
      }

      const data = await apiRequest("/tenant/members", {
        method: "POST",
        token,
        tenantSlug,
        body: {
          email,
          displayName: memberForm.displayName.trim(),
          role: memberForm.role,
          ...(selectedIdentityId ? { authentikUserUuid: selectedIdentityId } : {})
        }
      });
      setMemberForm({ email: "", displayName: "", role: "contributor" });
      setMemberIdentityCheck(null);
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

  async function openMemberIdentityResolution(member) {
    setMemberActionId(member.id);
    try {
      const data = await apiRequest(`/tenant/members/${member.id}/identity-candidates`, {
        token,
        tenantSlug
      });
      setIdentityResolution({
        member: data.member || member,
        candidates: data.candidates || [],
        selectedId: "",
        isSaving: false,
        error: ""
      });
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setMemberActionId("");
    }
  }

  function selectResolutionIdentity(candidateId) {
    setIdentityResolution(current => current ? { ...current, selectedId: candidateId, error: "" } : current);
  }

  async function confirmMemberIdentityResolution() {
    if (!identityResolution?.member?.id || !identityResolution.selectedId || identityResolution.isSaving) return;
    const memberId = identityResolution.member.id;
    setIdentityResolution(current => current ? { ...current, isSaving: true, error: "" } : current);
    try {
      const data = await apiRequest(`/tenant/members/${memberId}/resolve-identity`, {
        method: "POST",
        token,
        tenantSlug,
        body: { authentikUserUuid: identityResolution.selectedId }
      });
      if (data.member) {
        setMembers(current => current.map(member => member.id === data.member.id ? data.member : member));
      }
      setIdentityResolution(null);
      setStatus({ text: "Sign-in account selected. Account setup is continuing.", isError: false });
      await loadTenant({ silent: true });
    } catch (error) {
      setIdentityResolution(current => current ? {
        ...current,
        isSaving: false,
        error: getApiErrorMessage(error)
      } : current);
    }
  }

  async function cancelFailedMemberInvitation(member) {
    if (!member?.id || memberActionId === member.id) return;
    const confirmed = window.confirm(
      `Cancel the invitation for ${member.displayName || member.email}? This removes it from the team but does not delete either sign-in account.`
    );
    if (!confirmed) return;

    setMemberActionId(member.id);
    if (identityResolution?.member?.id === member.id) {
      setIdentityResolution(current => current ? { ...current, isSaving: true, error: "" } : current);
    }
    try {
      await apiRequest(`/tenant/members/${member.id}`, {
        method: "DELETE",
        token,
        tenantSlug
      });
      setMembers(current => current.filter(item => item.id !== member.id));
      setIdentityResolution(current => current?.member?.id === member.id ? null : current);
      setStatus({ text: "Invitation canceled", isError: false });
      await loadTenant({ silent: true });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
      setIdentityResolution(current => current?.member?.id === member.id
        ? { ...current, isSaving: false, error: getApiErrorMessage(error) }
        : current);
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
    setSessionIntent(intent);
    setIsSessionWorkspaceOpen(true);
    setActiveTab("dashboard");
    setIsReviewWorkspaceOpen(false);
    navigateAppHash("/admin/sessions");
    closeTenantSidebar(false);
  }

  function openActivitySession(sessionId) {
    setPreferredSessionId(sessionId || "");
    setSessionIntent("");
    setIsSessionWorkspaceOpen(true);
    setActiveTab("dashboard");
    setIsReviewWorkspaceOpen(false);
    navigateAppHash("/admin/sessions");
    closeTenantSidebar(false);
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
      setSessionIntent(startInventoryForm.source === "packet" ? "packet" : "");
      setStartInventoryForm({ name: defaultInventorySessionName(), source: startInventoryForm.source });
      setIsStartInventoryOpen(false);
      setIsSessionWorkspaceOpen(true);
      setIsReviewWorkspaceOpen(false);
      setActiveTab("dashboard");
      navigateAppHash("/admin/sessions");
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
      setActiveTab("dashboard");
      setIsReviewWorkspaceOpen(true);
      setIsSessionWorkspaceOpen(false);
      navigateAppHash("/admin/review");
      return;
    }

    const sessionId = action.sessionId || notification?.sessionId || "";
    if (sessionId) {
      openActivitySession(sessionId);
      return;
    }

    setActiveTab("dashboard");
    setIsSessionWorkspaceOpen(true);
    setIsReviewWorkspaceOpen(false);
    navigateAppHash("/admin/sessions");
  }

  async function refreshTenantWorkspace() {
    if (workspaceRefreshActionRef.current) return;
    workspaceRefreshActionRef.current = true;
    setIsRefreshingWorkspace(true);
    setStatus({ text: "Refreshing workspace...", isError: false });
    try {
      const [tenantLoaded, notificationsLoaded, refreshedIdentity] = await Promise.all([
        loadTenant(),
        loadNotifications(),
        onRefresh?.()
      ]);
      if (tenantLoaded === false || refreshedIdentity === null) return;
      setStatus({
        text: notificationsLoaded === false
          ? "Workspace refreshed, but alerts could not be loaded. Try refreshing alerts again."
          : "Workspace refreshed.",
        isError: notificationsLoaded === false
      });
    } finally {
      workspaceRefreshActionRef.current = false;
      setIsRefreshingWorkspace(false);
    }
  }

  if (!tenantSlug) {
    return (
      <EmptyPanel
        title="No platoon selected"
        body="Choose a workspace to continue."
        action={<a className="btn btn-primary btn-small" href="/#/launch">Choose workspace</a>}
      />
    );
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
              disabled={isRefreshingWorkspace || isLoggingOut}
              aria-label={isRefreshingWorkspace ? "Refreshing workspace" : "Refresh workspace"}
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <div className="leader-popover-anchor" ref={notificationsRef}>
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
                    <button type="button" onClick={loadNotifications} disabled={isLoadingNotifications || isLoggingOut}>
                      <RefreshCw aria-hidden="true" />
                      <span>{isLoadingNotifications ? "Refreshing alerts..." : "Refresh alerts"}</span>
                    </button>
                    <button type="button" onClick={() => openSessions()}>
                      <CalendarDays aria-hidden="true" />
                      <span>Open sessions</span>
                    </button>
                    {isTenantAdmin ? (
                      <button type="button" onClick={() => {
                        setActiveTab("dashboard");
                        setIsReviewWorkspaceOpen(true);
                        setIsSessionWorkspaceOpen(false);
                        setIsNotificationsOpen(false);
                        navigateAppHash("/admin/review");
                      }}>
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
                    <button type="button" onClick={refreshTenantWorkspace} disabled={isRefreshingWorkspace || isLoggingOut}>
                      <RefreshCw aria-hidden="true" />
                      <span>{isRefreshingWorkspace ? "Refreshing workspace..." : "Refresh workspace"}</span>
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
                    <button type="button" onClick={handleLogout} disabled={isLoggingOut || isRefreshingWorkspace}>
                      <LogOut aria-hidden="true" />
                      <span>{isLoggingOut ? (isCrew ? "Leaving..." : "Signing out...") : (isCrew ? "Leave inventory" : "Sign out")}</span>
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
            <>
              <LeaderOverviewPanel
                token={token}
                tenantSlug={tenantSlug}
                me={me}
                query={leaderQuery}
                onQueryChange={setLeaderQuery}
                canManage={isTenantAdmin}
                canSubmit={canSubmitProof}
                preferredSessionId={preferredSessionId}
                onSessionChange={setPreferredSessionId}
                onCreateSession={() => openStartInventoryWizard("packet")}
                onOpenSessions={() => openSessions()}
                onOpenSession={openActivitySession}
                onOpenUpload={() => openSessions("packet")}
                onInviteCrew={session => setCrewDialogSession(session)}
                onOpenReview={() => {
                  setIsReviewWorkspaceOpen(true);
                  setIsSessionWorkspaceOpen(false);
                  navigateAppHash("/admin/review");
                }}
                showWorkQueue={false}
              />

              {isSessionWorkspaceOpen ? (
                <section className="embedded-workspace-panel" aria-label="Inventory workspace">
                  {!isCrew ? (
                    <div className="embedded-workspace-heading">
                      <div><p className="eyebrow">Current inventory</p><h2>Work queue</h2></div>
                      <button className="btn btn-secondary btn-small" type="button" onClick={() => {
                        setIsSessionWorkspaceOpen(false);
                        navigateAppHash(tenantTabHashes.dashboard);
                      }}>Close work queue</button>
                    </div>
                  ) : null}
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
                    onUploadIntentHandled={() => setSessionIntent("")}
                    onSessionChange={setPreferredSessionId}
                    onInviteCrew={session => setCrewDialogSession(session)}
                    onOpenReview={() => {
                      setIsReviewWorkspaceOpen(true);
                      setIsSessionWorkspaceOpen(false);
                      navigateAppHash("/admin/review");
                    }}
                  />
                </section>
              ) : null}

              {isReviewWorkspaceOpen && isTenantAdmin ? (
                <section className="embedded-workspace-panel" aria-label="Review queue">
                  <div className="embedded-workspace-heading">
                    <div><p className="eyebrow">Leader review</p><h2>Review queue</h2></div>
                    <button className="btn btn-secondary btn-small" type="button" onClick={() => {
                      setIsReviewWorkspaceOpen(false);
                      navigateAppHash(tenantTabHashes.dashboard);
                    }}>Close review queue</button>
                  </div>
                  <ReviewPanel
                    token={token}
                    tenantSlug={tenantSlug}
                    query={leaderQuery}
                    onQueryChange={setLeaderQuery}
                    onClearSearch={clearLeaderSearch}
                    onOpenSessions={() => openSessions()}
                  />
                </section>
              ) : null}
            </>
          ) : null}

          {activeTab === "reports" && isTenantAdmin ? (
            <ReportsPanel token={token} tenantSlug={tenantSlug} query={leaderQuery} onQueryChange={setLeaderQuery} />
          ) : null}

          {activeTab === "equipment" && isTenantAdmin ? (
            <EquipmentLibraryPanel token={token} tenantSlug={tenantSlug} query={leaderQuery} onQueryChange={setLeaderQuery} />
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
              memberIdentityCheck={memberIdentityCheck}
              onClearMemberIdentityCheck={() => setMemberIdentityCheck(null)}
              onSelectMemberIdentity={candidateId => setMemberIdentityCheck(current => current ? { ...current, selectedId: candidateId } : current)}
              onCreateMember={createPermanentMember}
              onUpdateMember={updateMember}
              onDisableMember={disableMember}
              onRetryMember={retryMemberProvisioning}
              onResolveMemberIdentity={openMemberIdentityResolution}
              onCancelMemberInvitation={cancelFailedMemberInvitation}
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
              canResolveIdentities={Boolean(me?.isPlatformAdmin)}
              identityResolution={identityResolution}
              onSelectResolutionIdentity={selectResolutionIdentity}
              onConfirmResolution={confirmMemberIdentityResolution}
              onCloseResolution={() => {
                if (!identityResolution?.isSaving) setIdentityResolution(null);
              }}
            />
          ) : null}

          {activeTab === "activity" && isTenantAdmin ? (
            <TenantActivityPanel
              token={token}
              tenantSlug={tenantSlug}
              onOpenSession={openActivitySession}
              onOpenSessions={() => openSessions()}
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
  const [authAction, setAuthAction] = useState("");
  const [hasCheckedAccess, setHasCheckedAccess] = useState(false);
  const [isRefreshingSession, setIsRefreshingSession] = useState(false);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const authActionRef = useRef("");
  const token = getSessionAccessToken(session);

  async function runAuthAction(kind, action) {
    if (authActionRef.current) return null;
    authActionRef.current = kind;
    setAuthAction(kind);
    try {
      return await action();
    } finally {
      if (authActionRef.current === kind) authActionRef.current = "";
      setAuthAction(current => current === kind ? "" : current);
    }
  }

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
      if (tenantSlug && !data?.tenant) {
        setMe(null);
        setStatus({ text: "That workspace no longer exists. Redirecting...", isError: false });
        window.location.replace(getMissingTenantRedirectUrl(data));
        return null;
      }
      setMe(data);
      setStatus({ text: "", isError: false });
      return data;
    } catch (error) {
      if (error?.code === "crew_access_ended" || error?.details?.code === "crew_access_ended") {
        endCrewAccess();
        return null;
      }
      if (!me) setMe(null);
      if (!silent) setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
      return null;
    }
  }

  useEffect(() => {
    function handleSessionRefresh(event) {
      const refreshState = event?.detail?.state || "";
      setIsRefreshingSession(refreshState === "start");
      if (refreshState === "success" && event?.detail?.session) {
        setSession(event.detail.session);
        setReconnectRequired(false);
      }
    }

    function handleInvalidatedSession() {
      setIsRefreshingSession(false);
      setReconnectRequired(true);
      setStatus({ text: "", isError: false });
    }

    window.addEventListener(AUTH_SESSION_REFRESH_EVENT, handleSessionRefresh);
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidatedSession);
    return () => {
      window.removeEventListener(AUTH_SESSION_REFRESH_EVENT, handleSessionRefresh);
      window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidatedSession);
    };
  }, []);

  useEffect(() => {
    if (!session?.accessToken || !authSessionCanRefresh(session) || reconnectRequired) return undefined;

    let timeoutId = null;
    let cancelled = false;
    const scheduledSession = session;
    const schedule = delay => {
      timeoutId = window.setTimeout(renewSession, Math.min(Math.max(0, delay), 2_147_000_000));
    };
    const renewSession = async () => {
      const activeSession = readAuthSession();
      if (
        !activeSession
        || activeSession.accessToken !== scheduledSession.accessToken
        || activeSession.refreshToken !== scheduledSession.refreshToken
        || Number(activeSession.expiresAt || 0) !== Number(scheduledSession.expiresAt || 0)
      ) return;

      try {
        await refreshAuthSession(activeSession, { force: true });
      } catch {
        if (!cancelled) schedule(60_000);
      }
    };
    const expiresAt = Number(session.expiresAt || 0);
    schedule(expiresAt ? expiresAt - Date.now() - 90_000 : 0);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [session?.accessToken, session?.expiresAt, session?.refreshAvailable, session?.refreshToken, reconnectRequired]);

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
        if (ignore) return;
        if (redirectedSession) {
          setSession(redirectedSession);
          await loadMe(redirectedSession.accessToken);
          return;
        }
        const storedSession = readAuthSession();
        const storedToken = getSessionAccessToken(storedSession);
        if (storedToken) {
          setSession(storedSession);
          await loadMe(storedToken);
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

      if (!callbackFailed) {
        try {
          if (!ignore) setStatus({ text: "Restoring your sign-in...", isError: false });
          const refreshedSession = await refreshAuthSession(null, { force: true });
          const refreshedToken = getSessionAccessToken(refreshedSession);
          if (refreshedToken && !ignore) {
            setSession(refreshedSession);
            await loadMe(refreshedToken);
            return;
          }
        } catch (refreshError) {
          if (![400, 401].includes(Number(refreshError?.details?.status))) {
            if (!ignore) setStatus({ text: getProtectedAuthErrorMessage(refreshError), isError: true });
            return;
          }
        }
      }

      if (!callbackFailed && !appConfig.enableQaAuth) {
        try {
          setStatus({ text: "Opening secure sign-in...", isError: false });
          await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
          return;
        } catch (error) {
          if (!ignore) setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
          return;
        }
      }

      if (!ignore && !callbackFailed) setStatus({ text: "", isError: false });
    }

    handleRedirect().finally(() => {
      if (!ignore) setHasCheckedAccess(true);
    });
    return () => {
      ignore = true;
    };
  }, []);

  async function logout() {
    return runAuthAction("logout", async () => {
      const wasCrew = me?.authKind === "crew";
      if (wasCrew) {
        await apiRequest("/crew/logout", { method: "POST", tenantSlug });
      } else {
        await endOidcSession();
      }
      clearAuthSession();
      clearQaIdentity();
      setSession(null);
      setMe(null);
      setReconnectRequired(false);
      setHasCheckedAccess(true);
      setStatus({ text: "", isError: false });
      if (wasCrew) endCrewAccess("You left the inventory. Open a new private invite to join again.", "left");
      return true;
    });
  }

  async function saveManualToken() {
    const accessToken = manualToken.trim();
    if (!accessToken) return;
    await runAuthAction("token", async () => {
      const nextSession = {
        accessToken,
        expiresAt: Date.now() + 60 * 60 * 1000,
        createdAt: Date.now(),
        manual: true
      };
      saveAuthSession(nextSession);
      setSession(nextSession);
      setManualToken("");
      return loadMe(accessToken);
    });
  }

  async function useQaIdentity(kind) {
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
    await runAuthAction(`qa:${kind}`, async () => {
      saveQaIdentity(identity);
      const nextSession = {
        accessToken: "qa-dev",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        createdAt: Date.now(),
        qa: true
      };
      saveAuthSession(nextSession);
      setSession(nextSession);
      setStatus({ text: `Signing in as ${identity.name}...`, isError: false });
      return loadMe(nextSession.accessToken);
    });
  }

  async function signIn() {
    await runAuthAction("signIn", async () => {
      try {
        setStatus({ text: "Opening secure sign-in...", isError: false });
        await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
      } catch (error) {
        setStatus({ text: error.message || "Could not start login", isError: true });
      }
    });
  }

  async function reconnectSession() {
    await runAuthAction("reconnect", async () => {
      try {
        setStatus({ text: "Opening secure sign-in...", isError: false });
        await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
      } catch (error) {
        setStatus({ text: getProtectedAuthErrorMessage(error), isError: true });
      }
    });
  }

  async function refreshAccess() {
    return runAuthAction("refresh", () => loadMe());
  }

  const normalizedHash = typeof window === "undefined" ? "" : window.location.hash.toLowerCase();
  const isNewsletterPage = normalizedHash === "#/newsletter"
    || normalizedHash.startsWith("#/newsletter/")
    || normalizedHash.startsWith("#/newsletter?");
  const isPlatformPage = !isNewsletterPage && (isAdminHostname() || !tenantSlug);
  const canUsePlatform = Boolean(me?.isPlatformAdmin);
  const canUseNewsletter = Boolean(me?.isPlatformAdmin || me?.isFrgAdmin);
  const canUseTenant = Boolean(
    tenantSlug && me?.tenant && (me?.authKind === "crew" || me?.isPlatformAdmin || ["tenant_admin", "contributor", "crew", "viewer"].includes(me?.membership?.role))
  );
  const isTenantDashboard = Boolean(me && !isPlatformPage && canUseTenant);
  const isNewsletterDashboard = Boolean(
    token && me && canUseNewsletter && (isNewsletterPage || (isAdminHostname() && !canUsePlatform))
  );
  const isPlatformDashboard = Boolean(token && me && isPlatformPage && canUsePlatform);
  const shellClassName = isTenantDashboard ? "leader-app" : isPlatformDashboard || isNewsletterDashboard ? "platform-app" : "app-frame admin-frame";
  const isBootingAccess = !hasCheckedAccess || (!me && !status.isError && /checking|restoring|opening secure sign-in/i.test(status.text || ""));

  return (
    <MediaAuthProvider token={token} tenantSlug={tenantSlug}>
      <div className={shellClassName}>
      {!isTenantDashboard && !isPlatformDashboard && !isNewsletterDashboard ? (
        <AdminHeader me={me} tenantSlug={tenantSlug} mode={isNewsletterPage ? "newsletter" : ""} authAction={authAction} onRefresh={refreshAccess} onLogout={logout} />
      ) : null}

      {!me ? (
        isBootingAccess && !authAction ? <AuthBootPanel status={status} /> : <AuthPanel
          status={status}
          authAction={authAction}
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
              ? <NewsletterPanel token={token} me={me} onRefresh={refreshAccess} onLogout={logout} />
              : <EmptyPanel title="Newsletter admin access required" body="This account can sign in, but it is not assigned newsletter publishing access." action={<a className="btn btn-primary btn-small" href="/#/launch">Choose workspace</a>} />
          ) : isPlatformPage ? (
            canUsePlatform
              ? <PlatformPanel token={token} me={me} onRefresh={refreshAccess} onLogout={logout} />
              : <EmptyPanel title="Platform access required" body="This account can sign in, but it is not a root admin." action={<a className="btn btn-primary btn-small" href="/#/launch">Choose workspace</a>} />
          ) : canUseTenant ? (
            <TenantPanel token={token} tenantSlug={tenantSlug} me={me} onRefresh={refreshAccess} onLogout={logout} />
          ) : (
            <EmptyPanel title="Workspace access required" body="This account does not have access to this platoon." action={<a className="btn btn-primary btn-small" href="/#/launch">Choose workspace</a>} />
          )}
        </>
      )}

      {me && isRefreshingSession ? (
        <div className="session-refresh-indicator" role="status" aria-live="polite">
          <RefreshCw aria-hidden="true" />
          <span>Refreshing secure access</span>
        </div>
      ) : null}

      {me && reconnectRequired ? (
        <section className="session-reconnect-card" role="alert" aria-live="assertive">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Reconnect to continue</strong>
            <span>Your current page is still here. Reconnect your secure sign-in to keep working.</span>
          </div>
          <button className="btn btn-primary btn-small" type="button" disabled={Boolean(authAction)} onClick={reconnectSession}>
            <LogIn aria-hidden="true" />
            <span>{authAction === "reconnect" ? "Opening sign-in..." : "Reconnect"}</span>
          </button>
        </section>
      ) : null}
      </div>
    </MediaAuthProvider>
  );
}
