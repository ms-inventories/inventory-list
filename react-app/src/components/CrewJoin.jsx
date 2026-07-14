import { useEffect, useRef, useState } from "react";
import { KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { APP_NAME } from "../branding.js";
import { getTenantSlugFromHostname } from "../config.js";
import { apiRequest, clearQaIdentity, getApiErrorMessage } from "../lib/api.js";
import { clearAuthSession } from "../lib/auth.js";

function joinErrorMessage(error) {
  if (error?.status === 429) return "Too many attempts. Wait a few minutes, then try again.";
  if ([400, 401, 404, 409].includes(error?.status)) return "That code is invalid or no longer available.";
  return getApiErrorMessage(error);
}

function inviteTokenFromLocation() {
  const hash = String(window.location.hash || "");
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return "";
  const token = new URLSearchParams(hash.slice(queryIndex + 1)).get("invite") || "";
  return /^[A-Za-z0-9_-]{24,160}$/.test(token) ? token : "";
}

function noticeFromLocation() {
  const hash = String(window.location.hash || "");
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return "";
  const notice = new URLSearchParams(hash.slice(queryIndex + 1)).get("notice") || "";
  if (notice === "left") return "You left the inventory. Open a new private invite to join again.";
  if (notice === "ended") return "This inventory access has ended. Ask your leader for a new invite if you still need access.";
  return "";
}

export default function CrewJoin() {
  const tenantSlug = getTenantSlugFromHostname();
  const inviteToken = inviteTokenFromLocation();
  const routeNotice = noticeFromLocation();
  const inputRef = useRef(null);
  const [code, setCode] = useState("");
  const [isChecking, setIsChecking] = useState(Boolean(tenantSlug));
  const [isJoining, setIsJoining] = useState(false);
  const [statusIsError, setStatusIsError] = useState(false);
  const [status, setStatus] = useState(() => {
    try {
      return routeNotice || sessionStorage.getItem("inventory.crew.notice") || "";
    } catch {
      return routeNotice;
    }
  });
  const initialNoticeRef = useRef(status);

  useEffect(() => {
    try {
      sessionStorage.removeItem("inventory.crew.notice");
    } catch {
      // Session storage is best-effort only.
    }

    if (!tenantSlug) {
      setIsChecking(false);
      setStatusIsError(true);
      setStatus("Open the platoon-specific join link your leader shared with you.");
      return undefined;
    }

    let ignore = false;
    async function checkExistingCrewAccess() {
      try {
        const data = await apiRequest("/me", { tenantSlug });
        if (!ignore && data?.authKind === "crew") {
          window.location.replace("/#/admin");
          return;
        }
      } catch {
        // An anonymous visitor is expected here. Never start OIDC from this page.
      }

      if (!ignore) {
        setIsChecking(false);
        if (!inviteToken) {
          if (!initialNoticeRef.current) {
            setStatusIsError(true);
            setStatus("Open the private inventory link your leader shared with you.");
          }
        } else {
          window.requestAnimationFrame(() => inputRef.current?.focus());
        }
      }
    }

    checkExistingCrewAccess();
    return () => {
      ignore = true;
    };
  }, [inviteToken, tenantSlug]);

  async function joinInventory(event) {
    event.preventDefault();
    if (code.length !== 4 || isJoining || !tenantSlug || !inviteToken) return;

    try {
      setIsJoining(true);
      setStatusIsError(false);
      setStatus("Joining inventory...");
      await apiRequest("/crew/consume", {
        method: "POST",
        tenantSlug,
        body: { code, inviteToken }
      });
      clearAuthSession();
      clearQaIdentity();
      setCode("");
      window.location.replace("/#/admin");
    } catch (error) {
      setStatusIsError(true);
      setStatus(joinErrorMessage(error));
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setIsJoining(false);
    }
  }

  return (
    <div className="auth-screen crew-join-screen">
      <main className="auth-card crew-join-card" aria-labelledby="crewJoinTitle">
        <span className="crew-join-icon"><KeyRound aria-hidden="true" /></span>
        <p className="eyebrow">{APP_NAME}</p>
        <h1 id="crewJoinTitle">Join inventory</h1>
        <p className="auth-copy">Open your private invite link, then enter the 4-digit PIN your leader gave you. You do not need a permanent account.</p>

        <form className="crew-join-form" onSubmit={joinInventory}>
          <label htmlFor="crewJoinCode">4-digit code</label>
          <input
            ref={inputRef}
            id="crewJoinCode"
            className="input crew-code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4}"
            maxLength={4}
            value={code}
            disabled={isChecking || isJoining || !tenantSlug || !inviteToken}
            aria-describedby="crewJoinHelp"
            onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
          />
          <span id="crewJoinHelp" className="crew-join-help">The PIN works once, only with this private link, and only for this inventory.</span>
          <button className="btn btn-primary btn-full" type="submit" disabled={code.length !== 4 || isChecking || isJoining || !tenantSlug || !inviteToken}>
            <LogIn aria-hidden="true" />
            <span>{isChecking ? "Checking access..." : isJoining ? "Joining..." : "Join inventory"}</span>
          </button>
        </form>

        {status ? <div className={`admin-status crew-join-status ${statusIsError ? "error" : ""}`} role="status" aria-live="polite">{status}</div> : null}

        <div className="crew-join-privacy">
          <ShieldCheck aria-hidden="true" />
          <span>Your access ends automatically when the inventory closes.</span>
        </div>
      </main>
    </div>
  );
}
