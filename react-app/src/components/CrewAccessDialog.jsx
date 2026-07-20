import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, KeyRound, RefreshCw, Share2, Trash2, UserPlus, X } from "lucide-react";
import { apiRequest, getApiErrorMessage } from "../lib/api.js";

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function crewStatusLabel(status) {
  return {
    pending: "Waiting",
    consumed: "Joined",
    active: "Joined",
    expired: "Expired",
    revoked: "Removed"
  }[status] || status || "Unknown";
}

function canRemoveAccess(access) {
  return ["pending", "consumed", "active"].includes(access?.status);
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export default function CrewAccessDialog({ session, tenant, token, tenantSlug, onClose }) {
  const previousFocusRef = useRef(document.activeElement);
  const dialogRef = useRef(null);
  const nameInputRef = useRef(null);
  const copyInviteRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const closeBlockedRef = useRef(false);
  const [crew, setCrew] = useState([]);
  const [limit, setLimit] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [created, setCreated] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [actionId, setActionId] = useState("");
  const [status, setStatus] = useState("");
  const joinUrl = created?.inviteToken
    ? `${window.location.origin}/#/join?invite=${encodeURIComponent(created.inviteToken)}`
    : "";
  const inviteText = useMemo(() => created ? [
    `Join ${tenant?.name || tenantSlug || "the platoon"} inventory:`,
    joinUrl,
    `Code: ${created.code}`,
    `For ${created.access?.displayName || displayName}. This code works once${created.access?.expiresAt ? ` and expires ${formatDate(created.access.expiresAt)}` : ""}.`
  ].join("\n") : "", [created, displayName, joinUrl, tenant?.name, tenantSlug]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  function requestClose() {
    if (closeBlockedRef.current) return;
    onCloseRef.current?.();
  }

  async function loadCrew({ quiet = false } = {}) {
    if (!session?.id) return;
    try {
      if (!quiet) setIsLoading(true);
      const data = await apiRequest(`/inventory/sessions/${encodeURIComponent(session.id)}/crew-access`, { token, tenantSlug });
      setCrew(data.crew || data.access || []);
      setLimit(Number(data.limit || 0));
      if (!quiet) setStatus("");
    } catch (error) {
      setStatus(getApiErrorMessage(error));
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }

  useEffect(() => {
    loadCrew();
  }, [session?.id, tenantSlug, token]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => nameInputRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])"
      ) || [])].filter(element => element.getClientRects().length > 0);
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
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => previousFocusRef.current?.focus?.());
    };
  }, []);

  useEffect(() => {
    if (created?.code) window.requestAnimationFrame(() => copyInviteRef.current?.focus());
  }, [created?.code]);

  async function createAccess(event) {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length < 2 || isCreating) return;

    try {
      closeBlockedRef.current = true;
      setIsCreating(true);
      setStatus("Generating code...");
      const data = await apiRequest(`/inventory/sessions/${encodeURIComponent(session.id)}/crew-access`, {
        method: "POST",
        token,
        tenantSlug,
        body: { displayName: name }
      });
      const code = String(data.code || "");
      if (!/^\d{4}$/.test(code)) throw new Error("The server did not return a valid crew code.");
      const inviteToken = String(data.inviteToken || "");
      if (!/^[A-Za-z0-9_-]{24,160}$/.test(inviteToken)) throw new Error("The server did not return a valid private invite link.");
      setCreated({ access: data.access, code, inviteToken });
      setDisplayName("");
      setStatus("Code ready. Share it with this helper now; it will not be shown again after you close this window.");
      await loadCrew({ quiet: true });
    } catch (error) {
      setStatus(getApiErrorMessage(error));
    } finally {
      closeBlockedRef.current = false;
      setIsCreating(false);
    }
  }

  async function copyInvite() {
    try {
      const copied = await copyText(inviteText);
      setStatus(copied ? "Invite copied." : "Could not copy the invite from this browser.");
    } catch {
      setStatus("Could not copy the invite from this browser.");
    }
  }

  async function shareInvite() {
    if (!navigator.share || !inviteText) return;
    try {
      await navigator.share({ title: "Join inventory", text: inviteText });
      setStatus("Invite shared.");
    } catch (error) {
      if (error?.name !== "AbortError") setStatus("Could not share the invite from this browser.");
    }
  }

  async function removeAccess(access) {
    if (!access?.id || actionId) return;
    try {
      closeBlockedRef.current = true;
      setActionId(access.id);
      setStatus(`Removing access for ${access.displayName || "crew member"}...`);
      await apiRequest(`/inventory/sessions/${encodeURIComponent(session.id)}/crew-access/${encodeURIComponent(access.id)}/revoke`, {
        method: "POST",
        token,
        tenantSlug
      });
      if (created?.access?.id === access.id) setCreated(null);
      await loadCrew({ quiet: true });
      setStatus("Crew access removed.");
    } catch (error) {
      setStatus(getApiErrorMessage(error));
    } finally {
      closeBlockedRef.current = false;
      setActionId("");
    }
  }

  return (
    <div className="modal-backdrop crew-access-backdrop" role="presentation">
      <section ref={dialogRef} className="modal-panel crew-access-dialog" role="dialog" aria-modal="true" aria-labelledby="crewAccessTitle">
        <header className="crew-access-heading">
          <span className="modal-icon"><UserPlus aria-hidden="true" /></span>
          <div>
            <p className="eyebrow">{session?.name || "Inventory"}</p>
            <h2 id="crewAccessTitle">Invite crew</h2>
            <p>Give each helper their own private link and one-time PIN.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close crew invite" disabled={isCreating || Boolean(actionId)} onClick={requestClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        {created?.code ? (
          <section className="crew-code-result" aria-label="New crew code">
            <span>Code for {created.access?.displayName || "helper"}</span>
            <output className="crew-code" aria-label={`Crew code ${created.code.split("").join(" ")}`}>{created.code}</output>
            <small>Private link + PIN work once{created.access?.expiresAt ? ` - expires ${formatDate(created.access.expiresAt)}` : ""}</small>
            <div className="crew-invite-actions">
              <button ref={copyInviteRef} className="btn btn-primary" type="button" onClick={copyInvite}>
                <Copy aria-hidden="true" /><span>Copy invite</span>
              </button>
              {navigator.share ? (
                <button className="btn btn-secondary" type="button" onClick={shareInvite}>
                  <Share2 aria-hidden="true" /><span>Share</span>
                </button>
              ) : null}
              <button className="btn btn-secondary" type="button" onClick={() => {
                setCreated(null);
                setStatus("");
                window.requestAnimationFrame(() => nameInputRef.current?.focus());
              }}>
                <UserPlus aria-hidden="true" /><span>Invite another</span>
              </button>
            </div>
          </section>
        ) : (
          <form className="crew-invite-form" onSubmit={createAccess}>
            <label htmlFor="crewDisplayName">Helper name</label>
            <input
              ref={nameInputRef}
              id="crewDisplayName"
              className="input"
              required
              minLength={2}
              maxLength={80}
              value={displayName}
              placeholder="SSG Rivera"
              onChange={event => setDisplayName(event.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={displayName.trim().length < 2 || isCreating}>
              <KeyRound aria-hidden="true" />
              <span>{isCreating ? "Generating..." : "Generate code"}</span>
            </button>
          </form>
        )}

        {status ? <div className="admin-status crew-access-status" role="status" aria-live="polite">{status}</div> : null}

        <details className="crew-access-list" open={!created}>
          <summary>
            <span>Current crew</span>
            <strong>{crew.filter(item => canRemoveAccess(item)).length}{limit ? ` / ${limit}` : ""}</strong>
          </summary>
          <div>
            {isLoading ? <p className="crew-access-empty">Loading crew...</p> : crew.length ? crew.map(access => (
              <article className="crew-access-row" key={access.id}>
                <div>
                  <strong>{access.displayName || "Crew member"}</strong>
                  <span>{crewStatusLabel(access.status)}{access.expiresAt ? ` - expires ${formatDate(access.expiresAt)}` : ""}</span>
                </div>
                <span className={`status-pill ${access.status}`}>{crewStatusLabel(access.status)}</span>
                {canRemoveAccess(access) ? (
                  <button className="btn btn-danger-soft btn-small" type="button" disabled={Boolean(actionId)} onClick={() => removeAccess(access)}>
                    <Trash2 aria-hidden="true" />
                    <span>{actionId === access.id ? "Removing..." : "Remove access"}</span>
                  </button>
                ) : null}
              </article>
            )) : <p className="crew-access-empty">No crew invitations for this inventory yet.</p>}
          </div>
        </details>

        <footer className="crew-access-footer">
          <button className="btn btn-secondary" type="button" disabled={isLoading || isCreating || Boolean(actionId)} onClick={() => loadCrew()}>
            <RefreshCw aria-hidden="true" /><span>Refresh</span>
          </button>
          <button className="btn btn-secondary" type="button" disabled={isCreating || Boolean(actionId)} onClick={requestClose}><span>Done</span></button>
        </footer>
      </section>
    </div>
  );
}
