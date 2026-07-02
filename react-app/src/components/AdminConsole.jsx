import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Camera,
  CheckCircle2,
  ClipboardList,
  ClipboardPlus,
  FileText,
  ListChecks,
  LogIn,
  LogOut,
  MailPlus,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
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
    ? "Create platoon workspaces and assign the first LT."
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
            <button className="btn btn-secondary" type="button" onClick={() => onUseQaIdentity("lt")}>
              <span>LT admin</span>
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

function parsePacketRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\t|\s+\|\s+/).map(part => part.trim()).filter(Boolean);
      const maybeQty = Number(parts[1]);
      return {
        packetLine: parts[0] || line,
        expectedQty: Number.isInteger(maybeQty) && maybeQty >= 0 ? maybeQty : undefined,
        locationHint: parts.length > 2 ? parts.slice(2).join(" ") : undefined
      };
    });
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
  const ranks = {
    needs_review: 0,
    unchecked: 1,
    mismatch: 2,
    not_found: 3,
    found: 4,
    approved: 5
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

function ProofForm({ item, token, tenantSlug, onCancel, onSaved, onStatus }) {
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
        placeholder="Note"
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
          <span>{isSaving ? "Submitting..." : "Submit"}</span>
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel}>
          <span>Cancel</span>
        </button>
      </div>
    </form>
  );
}

function SessionPanel({ token, tenantSlug, canManage, canSubmit }) {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [detail, setDetail] = useState(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [packetRows, setPacketRows] = useState("");
  const [proofItemId, setProofItemId] = useState("");
  const [status, setStatus] = useState({ text: "Loading inventory sessions...", isError: false });
  const [isSaving, setIsSaving] = useState(false);

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

  async function addPacketRows(e) {
    e.preventDefault();
    if (!selectedSessionId) {
      setStatus({ text: "Create or select a session first.", isError: true });
      return;
    }

    const items = parsePacketRows(packetRows);
    if (!items.length) {
      setStatus({ text: "Paste at least one packet row.", isError: true });
      return;
    }

    try {
      setIsSaving(true);
      await apiRequest(`/inventory/sessions/${selectedSessionId}/items/bulk`, {
        method: "POST",
        token,
        tenantSlug,
        body: { items }
      });
      setPacketRows("");
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

  const selectedSession = sessions.find(session => session.id === selectedSessionId) || detail?.session;
  const detailItems = useMemo(
    () => [...(detail?.items || [])].sort((a, b) => sessionItemPriority(a) - sessionItemPriority(b)),
    [detail?.items]
  );
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
              <EmptyPanel title="No sessions yet" body="Start one from the packet the LT receives." />
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
                <details className="packet-import">
                  <summary className="btn btn-secondary">
                    <ClipboardPlus aria-hidden="true" />
                    <span>Add packet rows</span>
                  </summary>
                  <form className="disclosure-panel packet-import-form" onSubmit={addPacketRows}>
                    <textarea
                      className="input packet-textarea"
                      value={packetRows}
                      placeholder="A90594 ARMAMENT SUBSYS: M153&#10;B67839 BINOCULAR: M24"
                      onChange={e => setPacketRows(e.target.value)}
                    />
                    <button className="btn btn-secondary" type="submit" disabled={isSaving}>
                      <span>Add rows</span>
                    </button>
                  </form>
                </details>
              ) : null}

              <div className="session-items">
                {detailItems.length ? detailItems.map(item => {
                  const submission = latestSubmission(item);
                  return (
                    <article className="session-item" key={item.id}>
                      <div className="session-item-main">
                        <FileText aria-hidden="true" />
                        <div>
                          <strong>{item.inventoryItem?.commonName || item.inventoryItem?.title || item.packetLine || "Untitled row"}</strong>
                          <span>{item.packetLine || "No packet text"}</span>
                          {item.locationHint ? <small>Hint: {item.locationHint}</small> : null}
                          {submission ? <small>Latest proof: {submission.reviewState}</small> : null}
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
                            <span>Proof</span>
                          </button>
                        ) : null}
                      </div>
                      {proofItemId === item.id ? (
                        <ProofForm
                          item={item}
                          token={token}
                          tenantSlug={tenantSlug}
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
                }) : (
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
          <p className="eyebrow">LT review</p>
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

          <label className="field-label" htmlFor="tenantAdminEmail">LT email</label>
          <input
            id="tenantAdminEmail"
            className="input"
            type="email"
            value={form.adminEmail}
            placeholder="lt@example.com"
            onChange={e => updateForm("adminEmail", e.target.value)}
          />

          <label className="field-label" htmlFor="tenantAdminName">LT name</label>
          <input
            id="tenantAdminName"
            className="input"
            value={form.adminDisplayName}
            placeholder="LT Smith"
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
      const [tenantData, memberData, inviteData] = await Promise.all([
        apiRequest("/tenant", { token, tenantSlug }),
        apiRequest("/tenant/members", { token, tenantSlug }),
        apiRequest("/tenant/invitations", { token, tenantSlug })
      ]);
      setTenant(tenantData.tenant);
      setMembers(memberData.members || []);
      setInvitations(inviteData.invitations || []);
      setStatus({ text: "", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    }
  }

  useEffect(() => {
    if (tenantSlug) loadTenant();
  }, [tenantSlug, token]);

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
        groups: ["inventory-platform-admins"]
      },
      lt: {
        sub: "qa-lt",
        email: "qa-lt@876en.test",
        name: "QA LT",
        groups: []
      },
      nco: {
        sub: "qa-nco",
        email: "qa-nco@876en.test",
        name: "QA NCO",
        groups: []
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
