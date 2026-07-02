import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  ClipboardList,
  LogIn,
  LogOut,
  MailPlus,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  UserPlus,
  Users
} from "lucide-react";
import { appConfig, getTenantSlugFromHostname, isAdminHostname } from "../config.js";
import { apiRequest, getApiErrorMessage } from "../lib/api.js";
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

function AuthPanel({ status, manualToken, onManualTokenChange, onManualTokenSave, onSignIn }) {
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
    <div className="admin-grid">
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
  const canUseTenant = Boolean(tenantSlug && (me?.isPlatformAdmin || me?.membership?.role === "tenant_admin"));

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
