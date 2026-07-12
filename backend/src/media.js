import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { query } from "./db.js";

const mediaCookiePrefix = "inventory_media_";

export function normalizeMediaStorageKey(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) return "";
  const parts = raw.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return "";
  const normalized = parts.join("/");
  return normalized.startsWith("tenants/") ? normalized : "";
}

export function mediaStorageKeyFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("tenants/")) return normalizeMediaStorageKey(raw);

  let pathname = "";
  try {
    pathname = new URL(raw, "https://inventory-media.invalid").pathname;
  } catch {
    return "";
  }
  if (!pathname.startsWith("/media/")) return "";

  try {
    const decoded = pathname
      .slice("/media/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return normalizeMediaStorageKey(decoded);
  } catch {
    return "";
  }
}

function encodedStoragePath(storageKey) {
  return storageKey.split("/").map(encodeURIComponent).join("/");
}

function signingKey() {
  try {
    const key = Buffer.from(config.storage.mediaSigningSecret || "", "base64url");
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

function signatureFor(value) {
  const key = signingKey();
  if (!key) return "";
  return crypto.createHmac("sha256", key).update(value).digest("base64url");
}

function signatureMatches(value, signature) {
  if (!signature) return false;
  const expectedValue = signatureFor(value);
  if (!expectedValue) return false;
  const expected = Buffer.from(expectedValue);
  const provided = Buffer.from(String(signature));
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function mediaError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeDownloadName(value) {
  const base = path.basename(String(value || "packet-source"));
  return base.replace(/[\u0000-\u001f\u007f"\\]/g, "_").slice(0, 180) || "packet-source";
}

function cookieNameForTenant(tenantSlug) {
  const safeSlug = String(tenantSlug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return safeSlug ? `${mediaCookiePrefix}${safeSlug}` : "";
}

function readCookie(request, name) {
  const header = String(request.headers.cookie || "");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function encodeMediaSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signatureFor(encoded);
  return signature ? `${encoded}.${signature}` : "";
}

function decodeMediaSession(token) {
  try {
    const [encoded, signature, extra] = String(token || "").split(".");
    if (!encoded || !signature || extra || !signatureMatches(encoded, signature)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (
      payload?.version !== 1 ||
      !payload.tenantId ||
      !payload.tenantSlug ||
      !payload.userId ||
      !Number.isInteger(payload.expiresAt) ||
      payload.expiresAt <= now
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function appendSetCookie(response, value) {
  const current = response.getHeader("Set-Cookie");
  if (!current) {
    response.setHeader("Set-Cookie", value);
  } else {
    response.setHeader("Set-Cookie", [...(Array.isArray(current) ? current : [current]), value]);
  }
}

export function issueMediaSession(response, context) {
  if (!response || !context?.tenant?.id || !context?.tenant?.slug || !context?.user?.id || !signingKey()) return;

  const tenantSlug = String(context.tenant.slug).toLowerCase();
  const maxAge = config.storage.mediaSessionTtlSeconds;
  const token = encodeMediaSession({
    version: 1,
    tenantId: context.tenant.id,
    tenantSlug,
    userId: context.user.id,
    role: context.membership?.role || "",
    platformAdmin: Boolean(context.identity?.isPlatformAdmin),
    expiresAt: Math.floor(Date.now() / 1000) + maxAge
  });
  if (!token) return;

  const attributes = [
    `${cookieNameForTenant(tenantSlug)}=${encodeURIComponent(token)}`,
    `Path=/media/tenants/${tenantSlug}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (config.env === "production") {
    attributes.push("Secure");
  }
  appendSetCookie(response, attributes.join("; "));
}

export function buildMediaUrl(value) {
  const storageKey = normalizeMediaStorageKey(value);
  if (!storageKey) return "";
  const base = String(config.storage.publicMediaBaseUrl || "/media").replace(/\/+$/, "");
  return `${base}/${encodedStoragePath(storageKey)}`;
}

async function authorizedMediaRecord(session, storageKey) {
  const parts = storageKey.split("/");
  const category = parts[2] || "";

  if (category === "submissions") {
    const submissionResult = await query(
      `
        SELECT 1
        FROM submission_photos photo
        JOIN item_submissions submission ON submission.id = photo.submission_id
        JOIN inventory_session_items item ON item.id = submission.session_item_id
        JOIN inventory_sessions inventory_session ON inventory_session.id = item.session_id
        WHERE photo.storage_key = $1
          AND inventory_session.tenant_id = $2
        LIMIT 1
      `,
      [storageKey, session.tenantId]
    );
    if (submissionResult.rows[0]) return { kind: "evidence" };

    const inventoryReferenceResult = await query(
      `
        SELECT 1
        FROM inventory_item_media reference
        JOIN inventory_items item ON item.id = reference.inventory_item_id
        JOIN media_uploads upload ON upload.id = reference.media_upload_id
        WHERE upload.storage_key = $1
          AND upload.state = 'attached'
          AND item.tenant_id = $2
        LIMIT 1
      `,
      [storageKey, session.tenantId]
    );
    if (inventoryReferenceResult.rows[0]) return { kind: "inventory_reference" };

    const legacyInventoryReferenceResult = await query(
      `
        SELECT 1
        FROM inventory_items
        WHERE tenant_id = $2
          AND legacy_media_metadata = true
          AND strpos(metadata::text, $1) > 0
        LIMIT 1
      `,
      [storageKey, session.tenantId]
    );
    return legacyInventoryReferenceResult.rows[0] ? { kind: "inventory_reference" } : null;
  }

  if (category === "packet-imports") {
    if (!session.platformAdmin && session.role !== "tenant_admin") return false;
    const result = await query(
      `
        SELECT source_name, source_mime_type
        FROM packet_import_batches
        WHERE source_storage_key = $1
          AND tenant_id = $2
        LIMIT 1
      `,
      [storageKey, session.tenantId]
    );
    return result.rows[0] ? {
      kind: "packet_source",
      fileName: safeDownloadName(result.rows[0].source_name),
      mimeType: result.rows[0].source_mime_type || "application/octet-stream"
    } : null;
  }

  return false;
}

async function verifiedStoragePath(storageKey) {
  let root;
  let absolutePath;
  try {
    root = await fs.realpath(config.storage.root);
    absolutePath = await fs.realpath(path.resolve(root, storageKey));
  } catch (error) {
    if (error?.code === "ENOENT") throw mediaError("Media file not found.", 404);
    throw error;
  }
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw mediaError("Media access denied.", 403);
  const file = await fs.stat(absolutePath);
  if (!file.isFile()) throw mediaError("Media file not found.", 404);
  return absolutePath;
}

export function registerMediaRoutes(app) {
  app.get("/media/*", async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

    try {
      const storageKey = normalizeMediaStorageKey(request.params[0]);
      const tenantSlug = storageKey.split("/")[1] || "";
      const cookieName = cookieNameForTenant(tenantSlug);
      const session = decodeMediaSession(readCookie(request, cookieName));

      if (!storageKey || !session || session.tenantSlug !== tenantSlug) {
        throw mediaError("Media access denied.", 403);
      }
      const record = await authorizedMediaRecord(session, storageKey);
      if (!record) {
        throw mediaError("Media access denied.", 403);
      }

      const absolutePath = await verifiedStoragePath(storageKey);
      if (record.kind === "packet_source") {
        response.setHeader("Content-Disposition", `attachment; filename="${record.fileName}"`);
      }
      response.sendFile(absolutePath, error => {
        if (!error) return;
        next(error?.code === "ENOENT" ? mediaError("Media file not found.", 404) : error);
      });
    } catch (error) {
      next(error);
    }
  });
}
