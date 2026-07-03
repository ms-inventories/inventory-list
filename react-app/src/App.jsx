import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Copy,
  CornerDownRight,
  FileUp,
  ImageOff,
  LogIn,
  Mail,
  Megaphone,
  Repeat2,
  ScanText,
  Search,
  Settings,
  ShieldCheck,
  X
} from "lucide-react";
import AcceptInvite from "./components/AcceptInvite.jsx";
import AdminConsole from "./components/AdminConsole.jsx";
import blackShadowLogo from "./assets/black-shadow-company.jpg";
import { appConfig, getTenantSlugFromHostname, isAdminHostname } from "./config.js";
import { demoIndexData, demoInventoriesByFile } from "./data/demoData.js";
import { apiRequest, getApiErrorMessage } from "./lib/api.js";
import {
  beginOidcLogin,
  completeOidcRedirect,
  getSessionAccessToken,
  readAuthSession
} from "./lib/auth.js";
import { getPacketCandidateDisplay, recognizePacketFile } from "./lib/ocr.js";

const BUCKET_BASE_URL = String(appConfig.legacyBucketBaseUrl || "").replace(/\/+$/, "");
const INDEX_URL = BUCKET_BASE_URL ? `${BUCKET_BASE_URL}/inventories/index.json` : "";
const IMAGE_BASE_URL = BUCKET_BASE_URL ? `${BUCKET_BASE_URL}/` : "/";

const SEARCH_NOISE_TERMS = new Set([
  "buom",
  "ciic",
  "date",
  "description",
  "dla",
  "ea",
  "from",
  "lotno",
  "mpo",
  "nsn",
  "officer",
  "oh",
  "page",
  "qty",
  "regno",
  "responsible",
  "serno",
  "sysno",
  "time",
  "to",
  "uic",
  "ui"
]);

function normalizeImageSrc(src) {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  return IMAGE_BASE_URL + src.replace(/^\/+/, "");
}

async function fetchJson(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return await res.json();
}

function cloneData(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

async function loadIndexData() {
  let remoteError = null;

  if (INDEX_URL) {
    try {
      return { data: await fetchJson(INDEX_URL), source: "remote" };
    } catch (e) {
      remoteError = e;
    }
  }

  if (appConfig.enableDemoFallback) {
    return { data: cloneData(demoIndexData), source: "demo", error: remoteError };
  }

  throw remoteError || new Error("No inventory index source configured");
}

async function loadInventoryData(file, dataSource) {
  let remoteError = null;

  if (dataSource !== "demo" && BUCKET_BASE_URL) {
    try {
      return { data: await fetchJson(`${BUCKET_BASE_URL}/${file}`), source: "remote" };
    } catch (e) {
      remoteError = e;
    }
  }

  if (appConfig.enableDemoFallback && demoInventoriesByFile[file]) {
    return { data: cloneData(demoInventoriesByFile[file]), source: "demo", error: remoteError };
  }

  throw remoteError || new Error("No inventory source configured for this platoon");
}

function getInitialPlatoonId(platoons, tenantSlug) {
  const list = Array.isArray(platoons) ? platoons : [];
  const tenantMatch = tenantSlug
    ? list.find(platoon => String(platoon.id || "").toLowerCase() === tenantSlug.toLowerCase())
    : null;

  return (tenantMatch || list[0] || {}).id || "";
}

function isImageField(field) {
  return String(field.label || "").toLowerCase() === "image";
}

function fieldValueToText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function isPlaceholderImageSrc(src) {
  const value = String(src || "").toLowerCase();
  return value.includes("placehold.co");
}

function getImageValues(item) {
  const imageField = (item.fields || []).find(isImageField);
  if (!imageField) return [];
  const values = Array.isArray(imageField.value) ? imageField.value : [imageField.value];
  return values
    .map(v => String(v || "").trim())
    .filter(value => value && !isPlaceholderImageSrc(value));
}

function getDetailFields(item) {
  return (item.fields || []).filter(field => {
    if (isImageField(field)) return false;
    const label = String(field.label || "").toLowerCase();
    return label !== "common name" && label !== "location";
  });
}

function getFieldValue(item, label) {
  const target = String(label || "").toLowerCase();
  const field = (item.fields || []).find(f => !isImageField(f) && String(f.label || "").toLowerCase() === target);
  return field ? fieldValueToText(field.value).trim() : "";
}

function normalizeSearchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSearchText(item) {
  const fieldText = (item.fields || [])
    .map(field => `${field.label || ""} ${fieldValueToText(field.value)}`)
    .join(" ");

  return `${item.title || ""} ${fieldText}`;
}

function getSearchTerms(query) {
  return normalizeSearchValue(query)
    .split(" ")
    .filter(term => term.length > 1 && !SEARCH_NOISE_TERMS.has(term));
}

function itemMatchesSearch(item, query) {
  const normalizedQuery = normalizeSearchValue(query);
  const terms = getSearchTerms(query);
  if (!normalizedQuery) return true;
  if (!terms.length) return false;

  const haystack = normalizeSearchValue(getSearchText(item));
  return terms.every(term => haystack.includes(term));
}

function getItemSearchParts(item) {
  const parts = {
    title: normalizeSearchValue(item.title),
    commonName: normalizeSearchValue(getFieldValue(item, "Common Name")),
    armyName: normalizeSearchValue(getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature")),
    lin: normalizeSearchValue(getFieldValue(item, "LIN")),
    nsn: normalizeSearchValue(getFieldValue(item, "NSN")),
    description: normalizeSearchValue(getFieldValue(item, "Description")),
    location: normalizeSearchValue(getFieldValue(item, "Location")),
    all: normalizeSearchValue(getSearchText(item))
  };
  parts.tokens = parts.all.split(" ").filter(term => term.length > 1);
  return parts;
}

function getConsonantKey(value) {
  return normalizeSearchValue(value)
    .replace(/\s+/g, "")
    .split("")
    .filter((char, index) => /\d/.test(char) || index === 0 || !/[aeiou]/.test(char))
    .join("");
}

function getVariantTokenScore(term, tokens) {
  if (term.length < 4) return 0;
  const termKey = getConsonantKey(term);

  for (const token of tokens) {
    if (token.length < 4) continue;
    if (token.startsWith(term) || term.startsWith(token)) return 14;

    const tokenKey = getConsonantKey(token);
    if (termKey.length >= 4 && termKey === tokenKey) return 12;
  }

  return 0;
}

function fieldContainsTerm(fieldValue, term) {
  return fieldValue && fieldValue.includes(term);
}

function scoreSuggestedItem(item, terms) {
  const parts = getItemSearchParts(item);
  let score = 0;
  let matchedTerms = 0;

  terms.forEach(term => {
    let termScore = 0;

    if (parts.lin && (parts.lin === term || parts.lin.includes(term) || term.includes(parts.lin))) {
      termScore = Math.max(termScore, 120);
    }

    if (parts.nsn && (parts.nsn === term || parts.nsn.includes(term) || term.includes(parts.nsn))) {
      termScore = Math.max(termScore, 95);
    }

    if (fieldContainsTerm(parts.commonName, term) || fieldContainsTerm(parts.title, term)) {
      termScore = Math.max(termScore, 58);
    }

    if (fieldContainsTerm(parts.armyName, term)) {
      termScore = Math.max(termScore, 48);
    }

    if (fieldContainsTerm(parts.description, term) || fieldContainsTerm(parts.location, term)) {
      termScore = Math.max(termScore, 24);
    }

    if (fieldContainsTerm(parts.all, term)) {
      termScore = Math.max(termScore, 16);
    }

    termScore = Math.max(termScore, getVariantTokenScore(term, parts.tokens));

    if (termScore > 0) {
      score += termScore;
      matchedTerms += 1;
    }
  });

  if (!matchedTerms) return 0;

  score += matchedTerms * 12;
  if (matchedTerms >= Math.ceil(terms.length * 0.4)) score += 28;
  if (matchedTerms === terms.length) score += 35;

  return score;
}

function getClosestItemMatches(items, query, limit) {
  const terms = getSearchTerms(query);
  if (!terms.length) return [];

  return items
    .map(item => ({ item, score: scoreSuggestedItem(item, terms) }))
    .filter(result => result.score >= 32)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 4)
    .map(result => result.item);
}

function getSuggestedSearchQuery(item) {
  return getFieldValue(item, "Common Name")
    || item.title
    || getFieldValue(item, "LIN")
    || getFieldValue(item, "Army Name")
    || getFieldValue(item, "Nomenclature")
    || "";
}

function buildItemCopyText(item) {
  const commonName = getFieldValue(item, "Common Name");
  const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
  const lin = getFieldValue(item, "LIN");
  const nsn = getFieldValue(item, "NSN");
  const location = getFieldValue(item, "Location");
  const title = commonName || item.title || armyName || "(Untitled)";
  const lines = [title];

  if (lin) lines.push(`LIN: ${lin}`);
  if (armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(title)) {
    lines.push(`Army name: ${armyName}`);
  }
  if (nsn) lines.push(`NSN: ${nsn}`);
  if (location) lines.push(`Location: ${location}`);

  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) throw new Error("Copy command failed");
  } finally {
    textarea.remove();
  }
}

function StatusText({ status, className = "" }) {
  return (
    <div className={`status-text ${className} ${status?.isError ? "error" : ""}`} role="status" aria-live="polite">
      {status?.text || ""}
    </div>
  );
}

function isBaseHostname(hostname = window.location.hostname) {
  const cleanHost = String(hostname || "").split(":")[0].toLowerCase();
  return cleanHost === appConfig.baseDomain.toLowerCase();
}

function getAdminUrl() {
  return `https://admin.${appConfig.baseDomain}/#/admin`;
}

function getApplicationPortalUrl() {
  return appConfig.authentikLaunchUrl || getAdminUrl();
}

function getTenantUrl(slug) {
  return `https://${slug}.${appConfig.baseDomain}/#/admin`;
}

function normalizeGroupLabels(groups) {
  return [...new Set((groups || [])
    .map(group => String(group || "").trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

function getWorkspaceSlugsFromGroups(groups) {
  const reserved = new Set(["876en", "876en-admins", "876en-frg-admins", "876en-platoon-admin"]);

  return [...new Set(normalizeGroupLabels(groups)
    .filter(group => group.startsWith("876en-") && !reserved.has(group))
    .map(group => group.replace(/^876en-/, ""))
    .filter(Boolean))]
    .sort();
}

function isOidcCallback(search = window.location.search) {
  const params = new URLSearchParams(search || "");
  return params.has("code") && params.has("state");
}

function LaunchRouter() {
  const [status, setStatus] = useState({ text: "Checking your access...", isError: false });
  const [workspaces, setWorkspaces] = useState([]);
  const [me, setMe] = useState(null);
  const groupLabels = normalizeGroupLabels(me?.groups);
  const signedInLabel = me?.user?.display_name || me?.user?.email || "Signed in";

  useEffect(() => {
    let ignore = false;

    async function routeAfterLogin() {
      try {
        const redirectedSession = await completeOidcRedirect();
        if (redirectedSession) {
          const routeAfterRedirect = `${window.location.pathname}${window.location.hash || ""}`;
          const normalizedRouteAfterRedirect = routeAfterRedirect.toLowerCase();
          if (!normalizedRouteAfterRedirect.endsWith("#/launch") && !normalizedRouteAfterRedirect.startsWith("/launch")) {
            window.location.replace(routeAfterRedirect);
            return;
          }
        }

        const session = redirectedSession || readAuthSession();
        const token = getSessionAccessToken(session);

        if (!token) {
          setStatus({ text: "Redirecting to sign in...", isError: false });
          await beginOidcLogin("/#/launch");
          return;
        }

        const data = await apiRequest("/me", { token });
        if (ignore) return;

        setMe(data);
        const groups = normalizeGroupLabels(data.groups);
        const slugs = getWorkspaceSlugsFromGroups(groups);

        if (data.isPlatformAdmin || groups.includes("876en-admins")) {
          window.location.assign(getAdminUrl());
          return;
        }

        if (slugs.length === 1) {
          window.location.assign(getTenantUrl(slugs[0]));
          return;
        }

        if (slugs.length > 1) {
          setWorkspaces(slugs);
          setStatus({ text: "Choose a workspace to continue.", isError: false });
          return;
        }

        if (data.isFrgAdmin || groups.includes("876en-frg-admins")) {
          setStatus({
            text: "FRG publishing access is ready, but the editor screen is not wired into this launcher yet.",
            isError: false
          });
          return;
        }

        setStatus({
          text: "This account can sign in, but it is not assigned to an inventory workspace yet.",
          isError: true
        });
      } catch (error) {
        if (!ignore) setStatus({ text: getApiErrorMessage(error), isError: true });
      }
    }

    routeAfterLogin();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="auth-screen launch-screen">
      <section className="auth-card launch-card" aria-labelledby="launchTitle">
        <p className="eyebrow">876 EN Inventory</p>
        <h1 id="launchTitle">Opening workspace</h1>
        <p className="auth-copy">
          We are checking your account and sending you to the right place.
        </p>

        {me ? (
          <div className="launch-profile">
            <span className="badge strong">{signedInLabel}</span>
            <span className="badge">{groupLabels.length ? `${groupLabels.length} groups` : "No groups in token"}</span>
          </div>
        ) : null}

        {workspaces.length ? (
          <div className="launch-workspace-list">
            {workspaces.map(slug => (
              <a className="btn btn-secondary btn-full" key={slug} href={getTenantUrl(slug)}>
                <CornerDownRight aria-hidden="true" />
                <span>{slug.toUpperCase()} workspace</span>
              </a>
            ))}
          </div>
        ) : null}

        <StatusText status={status} />

        {status.isError && me ? (
          <details className="launch-access-details">
            <summary>Access details</summary>
            <dl>
              <div>
                <dt>Account</dt>
                <dd>{signedInLabel}</dd>
              </div>
              <div>
                <dt>Platform admin</dt>
                <dd>{me.isPlatformAdmin ? "yes" : "no"}</dd>
              </div>
              <div>
                <dt>Groups from token</dt>
                <dd>{groupLabels.length ? groupLabels.join(", ") : "none"}</dd>
              </div>
            </dl>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function PublicHome() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState({ text: "", isError: false });
  const newsletterActionUrl = String(appConfig.newsletterActionUrl || "").trim();
  const canSubmit = Boolean(newsletterActionUrl);

  function submitNewsletter(event) {
    if (canSubmit) return;
    event.preventDefault();
    setStatus({
      text: "Newsletter signup is being connected. Check back here for the first update link.",
      isError: false
    });
  }

  return (
    <main className="public-site">
      <section className="public-hero" aria-labelledby="publicTitle">
        <img className="public-hero-logo" src={blackShadowLogo} alt="" aria-hidden="true" />
        <nav className="public-nav" aria-label="Public navigation">
          <a className="public-brand" href="/">
            <span>876 EN</span>
            <strong>Black Shadow Company</strong>
          </a>

          <details className="public-login-menu">
            <summary className="btn btn-secondary public-nav-action">
              <LogIn aria-hidden="true" />
              <span>Login</span>
            </summary>
            <div className="public-login-panel">
              <a href={getApplicationPortalUrl()}>
                <LogIn aria-hidden="true" />
                <span>
                  <strong>Application portal</strong>
                  <small>Sign in to continue</small>
                </span>
              </a>
            </div>
          </details>
        </nav>

        <div className="public-hero-copy">
          <p className="eyebrow">Family readiness group</p>
          <h1 id="publicTitle">Black Shadow Company</h1>
          <p>
            Family updates, event reminders, and company resources will live here as this site comes online.
          </p>
          <div className="public-hero-actions">
            <a className="btn btn-primary" href="#newsletter">
              <Mail aria-hidden="true" />
              <span>Get updates</span>
            </a>
          </div>
        </div>
      </section>

      <section className="public-info-band" aria-label="Site sections">
        <div className="public-info-grid">
          <article className="public-info-item">
            <span><Megaphone aria-hidden="true" /></span>
            <strong>Announcements</strong>
            <p>Public unit and family updates without exposing internal inventory work.</p>
          </article>
          <article className="public-info-item">
            <span><CalendarDays aria-hidden="true" /></span>
            <strong>Events</strong>
            <p>Upcoming FRG reminders, drill weekend notes, and family support dates.</p>
          </article>
          <article className="public-info-item">
            <span><ShieldCheck aria-hidden="true" /></span>
            <strong>Resources</strong>
            <p>Helpful links and points of contact for the 876 EN community.</p>
          </article>
        </div>
      </section>

      <section className="public-newsletter-band" id="newsletter" aria-labelledby="newsletterTitle">
        <div className="public-newsletter-wrap">
          <div>
            <p className="eyebrow">Newsletter</p>
            <h2 id="newsletterTitle">Stay in the loop</h2>
            <p>
              The newsletter form is ready to connect to Brevo when the company contact list is finalized.
            </p>
          </div>
          <form
            className="public-newsletter-form"
            action={newsletterActionUrl || undefined}
            method="post"
            onSubmit={submitNewsletter}
          >
            <label className="field-label" htmlFor="newsletterEmail">Email address</label>
            <div className="public-newsletter-row">
              <input
                id="newsletterEmail"
                className="input"
                name="EMAIL"
                type="email"
                value={email}
                placeholder="name@example.com"
                onChange={event => setEmail(event.target.value)}
                required
              />
              <button className="btn btn-primary" type="submit" disabled={!email.trim()}>
                <Mail aria-hidden="true" />
                <span>{canSubmit ? "Sign up" : "Coming soon"}</span>
              </button>
            </div>
            <StatusText status={status} />
          </form>
        </div>
      </section>
    </main>
  );
}

function LoginScreen({
  indexData,
  selectedPlatoonId,
  password,
  tenantSlug,
  dataSource,
  loginStatus,
  onSelectedPlatoonIdChange,
  onPasswordChange,
  onSubmit
}) {
  return (
    <div className="auth-screen">
      <section className="auth-card" aria-labelledby="loginTitle">
        <p className="eyebrow">{tenantSlug ? `${tenantSlug} workspace` : "876 EN inventory"}</p>
        <h1 id="loginTitle">Equipment Inventory</h1>
        <p className="auth-copy">
          {dataSource === "demo"
            ? "Demo data is loaded for local testing. Use password demo."
            : "Select your platoon and open the latest equipment list."}
        </p>

        <div className="form-stack">
          <label className="field-label" htmlFor="platoonSelect">Platoon</label>
          <select
            id="platoonSelect"
            className="select"
            value={selectedPlatoonId}
            disabled={!indexData}
            onChange={e => onSelectedPlatoonIdChange(e.target.value)}
          >
            {(indexData?.platoons || []).map(platoon => (
              <option key={platoon.id} value={platoon.id}>{platoon.name || platoon.id}</option>
            ))}
          </select>

          <label className="field-label" htmlFor="passwordInput">Password</label>
          <input
            type="password"
            id="passwordInput"
            className="input"
            placeholder="Password..."
            value={password}
            onChange={e => onPasswordChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onSubmit();
            }}
          />

          <button id="submitBtn" className="btn btn-primary btn-full" onClick={onSubmit}>
            <LogIn aria-hidden="true" />
            <span>Open inventory</span>
          </button>

          <a className="btn btn-secondary btn-full" href="/#/admin">
            <Settings aria-hidden="true" />
            <span>Admin view</span>
          </a>

          <StatusText status={loginStatus} />
        </div>
      </section>
    </div>
  );
}

function ImageGallery({ item, images, onOpen }) {
  if (images.length === 0) {
    return (
      <div className="card-media">
        <div className="empty-media" aria-label="No image available">
          <ImageOff aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="card-media">
      <div className="image-gallery">
        {images.slice(0, 4).map((imgSrc, index) => {
          const src = normalizeImageSrc(imgSrc);
          return (
            <img
              key={`${src}-${index}`}
              src={src}
              alt={item.title || "Inventory image"}
              loading="lazy"
              tabIndex={0}
              onClick={() => onOpen(src, item.title || "Inventory image")}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(src, item.title || "Inventory image");
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function DetailGrid({ item }) {
  const fields = getDetailFields(item);

  if (!fields.length) {
    return (
      <div className="detail-grid">
        <div className="empty-state">No details have been recorded for this item yet.</div>
      </div>
    );
  }

  return (
    <div className="detail-grid">
      {fields.map((field, index) => {
        const label = String(field.label || "").trim();
        if (!label) return null;
        const value = fieldValueToText(field.value).trim();

        return (
          <div className="detail-cell" key={`${label}-${index}`}>
            <span className="detail-label">{label}</span>
            <span className={value ? "detail-value" : "detail-value empty"}>{value || "Not recorded"}</span>
          </div>
        );
      })}
    </div>
  );
}

function InventoryCard({ item, onOpenImage, onStatus }) {
  const images = getImageValues(item);
  const commonName = getFieldValue(item, "Common Name");
  const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
  const lin = getFieldValue(item, "LIN");
  const location = getFieldValue(item, "Location");
  const displayTitle = commonName || item.title || armyName || "(Untitled)";
  const packetParts = [
    lin ? `LIN ${lin}` : "",
    armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(displayTitle) ? armyName : ""
  ].filter(Boolean);

  const copyItem = async () => {
    try {
      await copyTextToClipboard(buildItemCopyText(item));
      onStatus({ text: `Copied: ${displayTitle}`, isError: false });
    } catch {
      onStatus({ text: "Could not copy item info", isError: true });
    }
  };

  return (
    <article className="viewer-card">
      <ImageGallery item={item} images={images} onOpen={onOpenImage} />
      <div className="card-body">
        {location ? (
          <div className="location-caption">
            <span className="location-caption-label">Location</span>
            <span className="location-caption-value">{location}</span>
          </div>
        ) : null}

        <div className="card-title-row">
          <div className="title-block">
            <h2 className="item-title">{displayTitle}</h2>
            {packetParts.length ? <p className="packet-meta">{packetParts.join(" - ")}</p> : null}
          </div>

          <button className="btn btn-secondary btn-small copy-item-btn" type="button" onClick={copyItem}>
            <Copy aria-hidden="true" />
            <span>Copy</span>
          </button>
        </div>

        <DetailGrid item={item} />
      </div>
    </article>
  );
}

function SuggestionList({ suggestions, onChoose }) {
  return (
    <div className="suggestion-panel">
      <p className="suggestion-heading">Closest matches</p>
      <div className="suggestion-list">
        {suggestions.map(item => {
          const commonName = getFieldValue(item, "Common Name");
          const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
          const lin = getFieldValue(item, "LIN");
          const location = getFieldValue(item, "Location");
          const displayTitle = commonName || item.title || armyName || "(Untitled)";
          const meta = [
            lin ? `LIN ${lin}` : "",
            armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(displayTitle) ? armyName : "",
            location ? `Location: ${location}` : ""
          ].filter(Boolean);

          return (
            <button
              className="suggestion-btn"
              type="button"
              key={`${displayTitle}-${lin}-${location}`}
              onClick={() => onChoose(item, displayTitle)}
            >
              <span className="suggestion-icon">
                <CornerDownRight aria-hidden="true" />
              </span>
              <span className="suggestion-copy">
                <span className="suggestion-main">{displayTitle}</span>
                {meta.length ? <span className="suggestion-meta">{meta.join(" - ")}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScanCandidatePicker({ parsed, onClose, onChoose }) {
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-panel">
        <div className="modal-stack">
          <div className="modal-heading">
            <span className="modal-icon"><ScanText aria-hidden="true" /></span>
            <div>
              <p className="eyebrow">Document scan</p>
              <div className="modal-title">Pick item row</div>
            </div>
          </div>
          <p className="modal-copy">
            I found several possible rows. Choose the one from the packet, or scan a closer single row if this list looks wrong.
          </p>

          <div className="candidate-list">
            {candidates.map(candidate => {
              const display = getPacketCandidateDisplay(candidate);
              return (
                <button
                  className="btn btn-secondary candidate-btn"
                  type="button"
                  key={`${candidate.line}-${candidate.score}`}
                  onClick={() => onChoose(candidate.line)}
                >
                  <span className="candidate-content">
                    <span className="candidate-main">{display.title}</span>
                    {display.meta ? (
                      <span className={`candidate-meta confidence-${display.confidence || "low"}`}>
                        {display.meta}
                      </span>
                    ) : null}
                    {display.rawLine ? <span className="candidate-raw">{display.rawLine}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="button-row">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              <X aria-hidden="true" />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ image, onClose }) {
  if (!image) return null;

  return (
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" onClick={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="lightbox-panel">
        <img src={image.src} alt={image.alt || "Inventory image"} />
        <div className="lightbox-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            <X aria-hidden="true" />
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ViewerApp() {
  const [indexData, setIndexData] = useState(null);
  const [dataSource, setDataSource] = useState("remote");
  const [selectedPlatoonId, setSelectedPlatoonId] = useState("");
  const [password, setPassword] = useState("");
  const [loginStatus, setLoginStatus] = useState({ text: "Loading platoons...", isError: false });
  const [scanStatus, setScanStatus] = useState({ text: "", isError: false });
  const [inventory, setInventory] = useState(null);
  const [selectedPlatoon, setSelectedPlatoon] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanPicker, setScanPicker] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null);
  const cameraInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const tenantSlug = useMemo(() => getTenantSlugFromHostname(), []);

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const result = await loadIndexData();
        const data = result.data;
        if (!data || !Array.isArray(data.platoons) || data.platoons.length === 0) {
          throw new Error("index.json has no platoons");
        }

        if (!ignore) {
          setDataSource(result.source);
          setIndexData(data);
          setSelectedPlatoonId(getInitialPlatoonId(data.platoons, tenantSlug));
          setLoginStatus({
            text: result.source === "demo" ? "Using bundled demo data until the live source is available." : "",
            isError: false
          });
        }
      } catch {
        if (!ignore) setLoginStatus({ text: "Failed to load index.json", isError: true });
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [tenantSlug]);

  useEffect(() => {
    const onKeyDown = e => {
      if (e.key === "Escape") {
        setLightboxImage(null);
        setScanPicker(null);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const currentPlatoon = useMemo(
    () => (indexData?.platoons || []).find(p => p.id === selectedPlatoonId) || null,
    [indexData, selectedPlatoonId]
  );

  const items = inventory?.items || [];
  const filteredItems = useMemo(
    () => items.filter(item => itemMatchesSearch(item, searchQuery)),
    [items, searchQuery]
  );
  const suggestions = useMemo(
    () => filteredItems.length || !searchQuery ? [] : getClosestItemMatches(items, searchQuery, 4),
    [filteredItems.length, items, searchQuery]
  );
  const withPhotos = useMemo(
    () => items.filter(item => getImageValues(item).length > 0).length,
    [items]
  );
  const visibleCount = filteredItems.length || suggestions.length;

  async function attemptLogin() {
    setLoginStatus({ text: "", isError: false });

    if (!currentPlatoon) {
      setLoginStatus({ text: "Select a platoon", isError: true });
      return;
    }

    setLoginStatus({ text: "Loading inventory...", isError: false });

    try {
      const result = await loadInventoryData(currentPlatoon.file, dataSource);
      const data = result.data;
      if (password !== data.password) {
        setLoginStatus({
          text: result.source === "demo" ? "Incorrect password. Demo password is demo." : "Incorrect password",
          isError: true
        });
        return;
      }

      setDataSource(result.source);
      setInventory(data);
      setSelectedPlatoon(currentPlatoon);
      setSearchQuery("");
      setScanStatus({
        text: result.source === "demo" ? "Demo inventory loaded. Live backend data is not connected yet." : "",
        isError: false
      });
      setLoginStatus({ text: "", isError: false });
    } catch {
      setLoginStatus({ text: "Failed to load platoon inventory", isError: true });
    }
  }

  function resetToLogin() {
    setInventory(null);
    setSelectedPlatoon(null);
    setPassword("");
    setSearchQuery("");
    setScanStatus({ text: "", isError: false });
    setLoginStatus({ text: "", isError: false });
  }

  function searchPacketLine(line) {
    setSearchQuery(line || "");
    setScanStatus({ text: line ? `Searched: ${line}` : "", isError: false });
  }

  async function scanPacketForSearch(file) {
    if (!file) return;

    try {
      setIsScanning(true);
      setScanStatus({ text: "Reading packet file...", isError: false });
      const parsed = await recognizePacketFile(file, text => setScanStatus({ text, isError: false }));
      const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

      if (candidates.length <= 1) {
        searchPacketLine(parsed.line);
      } else {
        setScanPicker(parsed);
      }
    } catch (e) {
      setScanStatus({ text: e.message || "Could not read that file", isError: true });
    } finally {
      setIsScanning(false);
    }
  }

  if (!inventory) {
    return (
      <LoginScreen
        indexData={indexData}
        selectedPlatoonId={selectedPlatoonId}
        password={password}
        tenantSlug={tenantSlug}
        dataSource={dataSource}
        loginStatus={loginStatus}
        onSelectedPlatoonIdChange={setSelectedPlatoonId}
        onPasswordChange={setPassword}
        onSubmit={attemptLogin}
      />
    );
  }

  return (
    <div className="app-frame">
      <header className="app-header">
        <div>
          <p className="eyebrow">{tenantSlug ? `${tenantSlug} workspace` : "Platoon inventory"}</p>
          <h1 id="pageTitle">{selectedPlatoon?.name || "Equipment Inventory"}</h1>
          <p className="header-copy">Fast lookup for what is on hand and where it is staged.</p>
        </div>
        <div className="header-actions">
          <label className="search-wrap" htmlFor="searchInput">
            <Search aria-hidden="true" />
            <input
              id="searchInput"
              className="input search-input"
              type="search"
              placeholder="Search packet item, LIN, NSN..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </label>
          <input
            ref={cameraInputRef}
            className="hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={e => {
              const file = e.target.files && e.target.files[0];
              scanPacketForSearch(file);
              e.target.value = "";
            }}
          />
          <input
            ref={pdfInputRef}
            className="hidden"
            type="file"
            accept="application/pdf,.pdf"
            onChange={e => {
              const file = e.target.files && e.target.files[0];
              scanPacketForSearch(file);
              e.target.value = "";
            }}
          />
          <button className="btn btn-accent" type="button" disabled={isScanning} onClick={() => cameraInputRef.current?.click()}>
            <ScanText aria-hidden="true" />
            <span>Scan paper</span>
          </button>
          <button className="btn btn-secondary" type="button" disabled={isScanning} onClick={() => pdfInputRef.current?.click()}>
            <FileUp aria-hidden="true" />
            <span>Upload PDF</span>
          </button>
          <a className="btn btn-secondary" href="/#/admin">
            <Settings aria-hidden="true" />
            <span>Admin</span>
          </a>
          <button className="btn btn-secondary" type="button" onClick={resetToLogin}>
            <Repeat2 aria-hidden="true" />
            <span>Change platoon</span>
          </button>
        </div>
      </header>

      <StatusText status={scanStatus} className="scan-status" />

      <section className="summary-strip" aria-label="Inventory summary">
        <div className="summary-item">
          <span className="summary-value">{items.length}</span>
          <span className="summary-label">Items tracked</span>
        </div>
        <div className="summary-item">
          <span className="summary-value">{visibleCount}</span>
          <span className="summary-label">Currently shown</span>
        </div>
        <div className="summary-item">
          <span className="summary-value">{withPhotos}</span>
          <span className="summary-label">With photos</span>
        </div>
      </section>

      <div className="inventory-grid">
        {!filteredItems.length ? (
          <>
            <div className="empty-state">
              {searchQuery && suggestions.length
                ? "No exact match. These are the closest items I found."
                : searchQuery
                  ? "No equipment matched that search."
                  : "No equipment has been added for this platoon yet."}
            </div>
            {suggestions.length ? (
              <SuggestionList
                suggestions={suggestions}
                onChoose={(item, displayTitle) => {
                  setSearchQuery(getSuggestedSearchQuery(item));
                  setScanStatus({ text: `Showing closest match: ${displayTitle}`, isError: false });
                }}
              />
            ) : null}
          </>
        ) : (
          filteredItems.map((item, index) => (
            <InventoryCard
              key={`${item.title}-${index}`}
              item={item}
              onOpenImage={(src, alt) => setLightboxImage({ src, alt })}
              onStatus={setScanStatus}
            />
          ))
        )}
      </div>

      {scanPicker ? (
        <ScanCandidatePicker
          parsed={scanPicker}
          onClose={() => setScanPicker(null)}
          onChoose={line => {
            searchPacketLine(line);
            setScanPicker(null);
          }}
        />
      ) : null}

      <Lightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState({
    path: window.location.pathname.toLowerCase(),
    hash: window.location.hash,
    search: window.location.search
  });

  useEffect(() => {
    const updateRoute = () => {
      setRoute({
        path: window.location.pathname.toLowerCase(),
        hash: window.location.hash,
        search: window.location.search
      });
    };

    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  const path = route.path;
  const hash = route.hash;
  const normalizedHash = hash.toLowerCase();
  const tenantSlug = getTenantSlugFromHostname();
  if (normalizedHash.startsWith("#/accept-invite")) return <AcceptInvite />;
  if (normalizedHash === "#/launch" || path.startsWith("/launch") || isOidcCallback(route.search)) return <LaunchRouter />;
  if (isAdminHostname() || path.startsWith("/admin") || normalizedHash === "#/admin") return <AdminConsole />;
  if (isBaseHostname()) return <PublicHome />;
  if (tenantSlug && normalizedHash !== "#/lookup" && !path.startsWith("/lookup")) return <AdminConsole />;
  return <ViewerApp />;
}
