import { useEffect, useMemo, useState } from "react";
import { ClipboardList, LogIn, ShieldCheck, UserCheck } from "lucide-react";
import { appConfig } from "../config.js";
import { apiRequest, getApiErrorMessage } from "../lib/api.js";
import {
  beginOidcLogin,
  clearAuthSession,
  completeOidcRedirect,
  getSessionAccessToken,
  readAuthSession,
  saveAuthSession
} from "../lib/auth.js";

function getInviteTokenFromHash(hash = window.location.hash) {
  const value = String(hash || "");
  const queryStart = value.indexOf("?");
  if (!value.toLowerCase().startsWith("#/accept-invite") || queryStart === -1) return "";
  return new URLSearchParams(value.slice(queryStart + 1)).get("token") || "";
}

function formatRole(role) {
  const labels = {
    tenant_admin: "Platoon admin",
    contributor: "Contributor",
    viewer: "Viewer"
  };
  return labels[role] || role || "Member";
}

function StatusLine({ status }) {
  if (!status?.text) return null;
  return <div className={`admin-status ${status.isError ? "error" : ""}`}>{status.text}</div>;
}

export default function AcceptInvite() {
  const inviteToken = useMemo(() => getInviteTokenFromHash(), []);
  const [session, setSession] = useState(() => readAuthSession());
  const [invite, setInvite] = useState(null);
  const [accepted, setAccepted] = useState(null);
  const [manualToken, setManualToken] = useState("");
  const [status, setStatus] = useState({ text: "Loading invite...", isError: false });
  const [isAccepting, setIsAccepting] = useState(false);
  const accessToken = getSessionAccessToken(session);

  useEffect(() => {
    let ignore = false;

    async function boot() {
      try {
        const redirectedSession = await completeOidcRedirect();
        if (redirectedSession && !ignore) setSession(redirectedSession);
      } catch (error) {
        if (!ignore) setStatus({ text: error.message || "Login failed", isError: true });
      }

      if (!inviteToken) {
        if (!ignore) setStatus({ text: "Invite link is missing a token.", isError: true });
        return;
      }

      try {
        const data = await apiRequest(`/invitations/${encodeURIComponent(inviteToken)}`);
        if (!ignore) {
          setInvite(data.invitation);
          setStatus({ text: "", isError: false });
        }
      } catch (error) {
        if (!ignore) setStatus({ text: getApiErrorMessage(error), isError: true });
      }
    }

    boot();
    return () => {
      ignore = true;
    };
  }, [inviteToken]);

  async function acceptInvite(activeToken = accessToken) {
    if (!activeToken) {
      setStatus({ text: "Sign in first, then accept the invite.", isError: true });
      return;
    }

    try {
      setIsAccepting(true);
      setStatus({ text: "Accepting invite...", isError: false });
      const data = await apiRequest("/invitations/accept", {
        method: "POST",
        token: activeToken,
        body: { token: inviteToken }
      });
      setAccepted(data);
      setStatus({ text: "Invite accepted.", isError: false });
    } catch (error) {
      setStatus({ text: getApiErrorMessage(error), isError: true });
    } finally {
      setIsAccepting(false);
    }
  }

  async function signIn() {
    try {
      setStatus({ text: "Redirecting to Authentik...", isError: false });
      await beginOidcLogin(`${window.location.pathname}${window.location.hash || ""}`);
    } catch (error) {
      setStatus({ text: error.message || "Could not start login", isError: true });
    }
  }

  function saveManualToken() {
    const token = manualToken.trim();
    if (!token) return;

    const nextSession = {
      accessToken: token,
      expiresAt: Date.now() + 60 * 60 * 1000,
      createdAt: Date.now(),
      manual: true
    };
    saveAuthSession(nextSession);
    setSession(nextSession);
    setManualToken("");
    setStatus({ text: "Token saved. You can accept the invite now.", isError: false });
  }

  function signOut() {
    clearAuthSession();
    setSession(null);
    setAccepted(null);
    setStatus({ text: "", isError: false });
  }

  const tenantUrl = invite?.tenant?.slug
    ? `https://${invite.tenant.slug}.${appConfig.baseDomain}/#/admin`
    : "/";

  return (
    <div className="auth-screen invite-screen">
      <section className="auth-card invite-card" aria-labelledby="inviteTitle">
        <p className="eyebrow">876 EN Inventory</p>
        <h1 id="inviteTitle">Accept Invite</h1>

        {accepted ? (
          <div className="invite-result">
            <span className="admin-icon">
              <UserCheck aria-hidden="true" />
            </span>
            <div>
              <strong>You are in.</strong>
              <span>Your account now has {formatRole(accepted.membership?.role)} access.</span>
            </div>
          </div>
        ) : invite ? (
          <div className="invite-summary">
            <span>Workspace</span>
            <strong>{invite.tenant?.name || invite.tenant?.slug}</strong>
            <span>Invited email</span>
            <strong>{invite.email}</strong>
            <span>Role</span>
            <strong>{formatRole(invite.role)}</strong>
          </div>
        ) : null}

        <div className="form-stack">
          {accepted ? (
            <a className="btn btn-primary btn-full" href={tenantUrl}>
              <ClipboardList aria-hidden="true" />
              <span>Open workspace</span>
            </a>
          ) : (
            <>
              {!accessToken ? (
                <button className="btn btn-primary btn-full" type="button" onClick={signIn}>
                  <LogIn aria-hidden="true" />
                  <span>Continue with Authentik</span>
                </button>
              ) : (
                <button className="btn btn-primary btn-full" type="button" disabled={isAccepting || !invite} onClick={() => acceptInvite()}>
                  <UserCheck aria-hidden="true" />
                  <span>{isAccepting ? "Accepting..." : "Accept invite"}</span>
                </button>
              )}

              {accessToken ? (
                <button className="btn btn-secondary btn-full" type="button" onClick={signOut}>
                  <span>Use a different account</span>
                </button>
              ) : null}

              {appConfig.enableQaAuth ? (
                <details className="disclosure">
                  <summary className="btn btn-secondary btn-full">
                    <span>Use access token</span>
                  </summary>
                  <div className="disclosure-panel form-stack">
                    <textarea
                      className="input admin-token-input"
                      value={manualToken}
                      placeholder="Paste bearer token..."
                      onChange={e => setManualToken(e.target.value)}
                    />
                    <button className="btn btn-secondary btn-full" type="button" onClick={saveManualToken}>
                      <ShieldCheck aria-hidden="true" />
                      <span>Use token</span>
                    </button>
                  </div>
                </details>
              ) : null}
            </>
          )}

          <StatusLine status={status} />
        </div>
      </section>
    </div>
  );
}
