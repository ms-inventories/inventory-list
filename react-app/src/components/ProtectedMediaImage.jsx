import { createContext, useContext, useEffect, useRef, useState } from "react";
import { appConfig } from "../config.js";
import { renewMediaSession } from "../lib/api.js";

const MediaAuthContext = createContext({ token: "", tenantSlug: "" });
let retrySequence = 0;

const loadingPlaceholder = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">
    <rect width="160" height="120" fill="#f4f6f2"/>
  </svg>
`)}`;
const unavailablePlaceholder = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120" role="img" aria-label="Photo unavailable">
    <rect width="160" height="120" rx="10" fill="#f4f6f2"/>
    <g fill="none" stroke="#657064" stroke-linecap="round" stroke-linejoin="round" stroke-width="5">
      <rect x="55" y="24" width="50" height="48" rx="6"/>
      <circle cx="72" cy="42" r="5"/>
      <path d="m60 65 13-13 10 9 8-8 9 12"/>
    </g>
    <text x="80" y="96" fill="#39423a" font-family="system-ui, sans-serif" font-size="13" font-weight="650" text-anchor="middle">Photo unavailable</text>
  </svg>
`)}`;

function protectedMediaUrl(value, tenantSlug) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:data|blob):/i.test(raw)) return null;

  try {
    const browserUrl = typeof window === "undefined" ? new URL("https://inventory.invalid/") : new URL(window.location.href);
    const parsed = new URL(raw, browserUrl);
    const apiOrigin = new URL(appConfig.apiBaseUrl, browserUrl).origin;
    const allowedOrigins = new Set([browserUrl.origin, apiOrigin]);
    const escapedTenant = String(tenantSlug || "").trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escapedTenant || !allowedOrigins.has(parsed.origin)) return null;
    return new RegExp(`^/media/tenants/${escapedTenant}(?:/|$)`, "i").test(parsed.pathname) ? parsed : null;
  } catch {
    return null;
  }
}

function cacheBustedMediaUrl(source, tenantSlug) {
  const parsed = protectedMediaUrl(source, tenantSlug);
  if (!parsed) return source;
  retrySequence += 1;
  parsed.searchParams.set("media_retry", String(retrySequence));

  const raw = String(source || "").trim();
  if (raw.startsWith("/")) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return parsed.toString();
}

export function MediaAuthProvider({ token = "", tenantSlug = "", children }) {
  return (
    <MediaAuthContext.Provider value={{ token, tenantSlug }}>
      {children}
    </MediaAuthContext.Provider>
  );
}

export default function ProtectedMediaImage({ src, onError, onLoad, alt = "", ...props }) {
  const { token, tenantSlug } = useContext(MediaAuthContext);
  const sourceRef = useRef(src);
  const attemptedSourceRef = useRef("");
  const mountedRef = useRef(true);
  const [displayedSource, setDisplayedSource] = useState(src);
  const [mediaState, setMediaState] = useState("ready");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    sourceRef.current = src;
    attemptedSourceRef.current = "";
    setDisplayedSource(src);
    setMediaState("ready");
  }, [src]);

  function showUnavailable() {
    if (!mountedRef.current) return;
    setDisplayedSource(unavailablePlaceholder);
    setMediaState("unavailable");
  }

  async function handleError(event) {
    onError?.(event);
    const protectedUrl = protectedMediaUrl(src, tenantSlug);
    if (!protectedUrl || attemptedSourceRef.current === src) {
      showUnavailable();
      return;
    }

    attemptedSourceRef.current = src;
    setDisplayedSource(loadingPlaceholder);
    setMediaState("renewing");

    try {
      await renewMediaSession({ token, tenantSlug });
      if (mountedRef.current && sourceRef.current === src) {
        setDisplayedSource(cacheBustedMediaUrl(src, tenantSlug));
        setMediaState("retrying");
      }
    } catch {
      if (sourceRef.current === src) showUnavailable();
    }
  }

  function handleLoad(event) {
    if (displayedSource !== loadingPlaceholder && displayedSource !== unavailablePlaceholder) {
      setMediaState("ready");
    }
    onLoad?.(event);
  }

  return (
    <img
      {...props}
      src={displayedSource || unavailablePlaceholder}
      alt={alt}
      data-media-state={mediaState}
      onError={handleError}
      onLoad={handleLoad}
    />
  );
}
