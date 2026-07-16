import crypto from "node:crypto";

const AUTHENTIK_ORIGIN = process.env.MVP_AUTHENTIK_ORIGIN || "https://auth.876en.org";
const API_ORIGIN = process.env.MVP_API_ORIGIN || "https://api.876en.org";
const TENANT_ORIGIN = process.env.MVP_TENANT_ORIGIN || "https://ms.876en.org";
const TENANT_SLUG = process.env.MVP_TENANT_SLUG || "ms";
const CLIENT_ID = process.env.MVP_OIDC_CLIENT_ID || "kqEeiCB9UgmaDlU5dUi3YziORFIIGxbAxz7S9mLC";
const OIDC_SCOPE = process.env.MVP_OIDC_SCOPE || "openid profile email groups ak_user_uuid";
const ADMIN_USERNAME = requiredEnv("MVP_ADMIN_USERNAME");
const ADMIN_PASSWORD = requiredEnv("MVP_ADMIN_PASSWORD");
const AUTHENTIK_ADMIN_USERNAME = requiredEnv("MVP_AUTHENTIK_ADMIN_USERNAME");
const AUTHENTIK_ADMIN_PASSWORD = requiredEnv("MVP_AUTHENTIK_ADMIN_PASSWORD");
const TEST_RUN = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const TEST_EMAIL = process.env.MVP_TEST_EMAIL || `inventory-smoke-${TEST_RUN}@876en.org`;
const TEST_NAME = `Inventory Smoke ${TEST_RUN}`;
const TEST_PASSWORD = crypto.randomBytes(24).toString("base64url") + "!7a";
const REQUEST_TIMEOUT_MS = 20_000;
const VALID_ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function requiredEnv(name) {
  const value = String(process.env[name] || "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(options = {}) {
  return {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
}

class CookieSession {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
  }

  absorb(response) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : [];
    for (const raw of values) {
      const pair = String(raw || "").split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
  }

  csrfToken() {
    return this.cookies.get("authentik_csrf") || this.cookies.get("csrftoken") || "";
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  async fetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookies.size) headers.set("Cookie", this.cookieHeader());
    if (options.method && options.method !== "GET" && options.method !== "HEAD") {
      const csrf = this.csrfToken();
      if (csrf) {
        headers.set("X-Authentik-CSRF", csrf);
        headers.set("X-CSRFToken", csrf);
      }
      headers.set("Origin", this.origin);
      headers.set("Referer", `${this.origin}/`);
    }
    const response = await fetch(url, withTimeout({
      ...options,
      headers,
      redirect: options.redirect || "manual"
    }));
    this.absorb(response);
    return response;
  }
}

async function responseData(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    return JSON.parse(text);
  }
  return { textLength: text.length };
}

function safeStageFailure(response, data) {
  const component = data?.component || "unknown";
  const errorKeys = data?.response_errors && typeof data.response_errors === "object"
    ? Object.keys(data.response_errors)
    : [];
  return `Authentik flow failed (${response.status}, ${component}${errorKeys.length ? `, ${errorKeys.join(",")}` : ""})`;
}

async function solveAuthentication(username, password) {
  const session = new CookieSession(AUTHENTIK_ORIGIN);
  const flowUrl = `${AUTHENTIK_ORIGIN}/api/v3/flows/executor/default-authentication-flow/?query=`;
  let response = await session.fetch(flowUrl, { headers: { Accept: "application/json" } });
  let initialRedirects = 0;
  const initialRedirectPaths = [];
  while (response.status >= 300 && response.status < 400 && initialRedirects < 5) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Authentik flow redirect omitted its destination (${response.status})`);
    const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
    initialRedirectPaths.push(nextUrl.pathname);
    if (nextUrl.origin !== new URL(AUTHENTIK_ORIGIN).origin) {
      throw new Error(`Authentik flow redirected to an unexpected origin (${response.status})`);
    }
    response = await session.fetch(nextUrl, { headers: { Accept: "application/json" } });
    initialRedirects += 1;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Authentik flow redirect loop (${initialRedirectPaths.join(" -> ") || "unknown"}; cookies: ${[...session.cookies.keys()].join(",") || "none"})`
    );
  }
  let challenge = await responseData(response);
  if (!response.ok) throw new Error(safeStageFailure(response, challenge));

  for (let step = 0; step < 10; step += 1) {
    const component = challenge?.component;
    if (component === "xak-flow-redirect" || component === "ak-stage-session-end") {
      return session;
    }
    if (component === "ak-stage-access-denied" || component === "ak-stage-flow-error") {
      throw new Error(safeStageFailure(response, challenge));
    }

    let body;
    if (component === "ak-stage-identification") {
      body = { component, uid_field: username, password };
    } else if (component === "ak-stage-password") {
      body = { component, password };
    } else if (component === "ak-stage-autosubmit" || component === "ak-stage-user-login") {
      body = { component };
    } else {
      throw new Error(`Authentik requires unsupported authentication step ${component || "unknown"}`);
    }

    response = await session.fetch(flowUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let stageRedirects = 0;
    const stageRedirectPaths = [];
    while (response.status >= 300 && response.status < 400 && stageRedirects < 5) {
      const meResponse = await session.fetch(`${AUTHENTIK_ORIGIN}/api/v3/core/users/me/`, {
        headers: { Accept: "application/json" }
      });
      const me = await responseData(meResponse);
      if (meResponse.ok && me?.user && me.user.is_anonymous !== true) return session;

      const location = response.headers.get("location");
      if (!location) throw new Error(`Authentik stage redirect omitted its destination (${response.status})`);
      const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
      if (nextUrl.origin !== new URL(AUTHENTIK_ORIGIN).origin) {
        throw new Error(`Authentik stage redirected to an unexpected origin (${response.status})`);
      }
      stageRedirectPaths.push(nextUrl.pathname);
      response = await session.fetch(nextUrl, { headers: { Accept: "application/json" } });
      stageRedirects += 1;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Authentik stage redirect loop (${stageRedirectPaths.join(" -> ") || "unknown"}; cookies: ${[...session.cookies.keys()].join(",") || "none"})`
      );
    }
    challenge = await responseData(response);
    if (!response.ok) throw new Error(safeStageFailure(response, challenge));
  }
  throw new Error("Authentik authentication did not finish within ten stages");
}

async function oidcAccessToken(username, password) {
  const session = await solveAuthentication(username, password);
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const authorizeQuery = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${TENANT_ORIGIN}/`,
    response_type: "code",
    scope: OIDC_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  let response = await session.fetch(
    `${AUTHENTIK_ORIGIN}/application/o/authorize/?${authorizeQuery}`,
    { headers: { Accept: "text/html,application/xhtml+xml" } }
  );
  let redirects = 0;
  while (response.status >= 300 && response.status < 400 && redirects < 8) {
    const location = response.headers.get("location");
    if (!location) throw new Error("OIDC redirect omitted its destination");
    const nextUrl = new URL(location, AUTHENTIK_ORIGIN);
    if (nextUrl.origin === new URL(TENANT_ORIGIN).origin && nextUrl.searchParams.has("code")) {
      if (nextUrl.searchParams.get("state") !== state) throw new Error("OIDC state mismatch");
      const tokenResponse = await fetch(`${AUTHENTIK_ORIGIN}/application/o/token/`, withTimeout({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: `${TENANT_ORIGIN}/`,
          code: nextUrl.searchParams.get("code"),
          code_verifier: verifier
        })
      }));
      const tokenData = await responseData(tokenResponse);
      if (!tokenResponse.ok || !tokenData?.access_token) {
        throw new Error(`OIDC token exchange failed (${tokenResponse.status})`);
      }
      return tokenData.access_token;
    }
    response = await session.fetch(nextUrl, { headers: { Accept: "text/html,application/xhtml+xml" } });
    redirects += 1;
  }
  throw new Error(`OIDC authorization did not return a code (${response.status})`);
}

async function appRequest(path, { token, method = "GET", body } = {}) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Tenant-Slug": TENANT_SLUG,
    Origin: TENANT_ORIGIN
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ORIGIN}${path}`, withTimeout({
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  const data = await responseData(response);
  if (!response.ok) {
    const code = data?.code || data?.publicCode || "unknown";
    throw new Error(`Inventory API ${method} ${path} failed (${response.status}, ${code})`);
  }
  return data;
}

async function authentikRequest(session, path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await session.fetch(`${AUTHENTIK_ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await responseData(response);
  if (!response.ok) throw new Error(`Authentik API ${method} ${path} failed (${response.status})`);
  return data;
}

async function findAuthentikUser(session, email) {
  const data = await authentikRequest(
    session,
    `/api/v3/core/users/?email=${encodeURIComponent(email)}&page_size=20`
  );
  const matches = (data?.results || []).filter(user => String(user.email || "").toLowerCase() === email.toLowerCase());
  if (matches.length > 1) throw new Error("Authentik returned duplicate exact-email users");
  return matches[0] || null;
}

async function ensureTenantGroupTagged(session, tenant) {
  const groupName = `876en-${tenant.slug}`;
  const data = await authentikRequest(
    session,
    `/api/v3/core/groups/?name=${encodeURIComponent(groupName)}&page_size=20`
  );
  const matches = (data?.results || []).filter(group => group.name === groupName);
  if (matches.length !== 1) throw new Error("Expected exactly one Authentik tenant group");
  const group = matches[0];
  if (group.is_superuser !== false || group.parents?.length || group.roles?.length) {
    throw new Error("Existing Authentik tenant group is privileged and cannot be adopted");
  }
  const attributes = {
    ...(group.attributes || {}),
    inventory_list_managed: true,
    inventory_tenant_id: tenant.id,
    inventory_tenant_slug: tenant.slug
  };
  if (
    group.attributes?.inventory_list_managed !== true
    || String(group.attributes?.inventory_tenant_id || "").toLowerCase() !== String(tenant.id).toLowerCase()
    || String(group.attributes?.inventory_tenant_slug || "").toLowerCase() !== tenant.slug
  ) {
    await authentikRequest(session, `/api/v3/core/groups/${group.pk}/`, {
      method: "PATCH",
      body: { attributes, is_superuser: false }
    });
  }
}

function isSmokeEmail(email) {
  return /^inventory-smoke-\d+-[0-9a-f]{8}@876en\.org$/i.test(String(email || ""));
}

function isOwnedSmokeMember(member) {
  const match = /^inventory-smoke-(\d+-[0-9a-f]{8})@876en\.org$/i.exec(String(member?.email || ""));
  return Boolean(
    match
    && member?.userId
    && member?.accountType === "authentik"
    && member?.displayName === `Inventory Smoke ${match[1]}`
  );
}

function assertOwnedSmokeIdentity(identity, member) {
  if (!identity) return;
  if (
    !isOwnedSmokeMember(member)
    || identity.name !== member.displayName
    || identity.attributes?.inventory_list_managed !== true
    || String(identity.attributes?.inventory_app_user_id || "").toLowerCase()
      !== String(member.userId).toLowerCase()
  ) {
    throw new Error("Refusing to clean an Authentik identity without exact smoke-test ownership tags");
  }
}

async function waitForMember(token, memberId, predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let member = null;
  while (Date.now() < deadline) {
    const data = await appRequest("/api/tenant/members", { token });
    member = (data?.members || []).find(candidate => candidate.id === memberId) || null;
    if (member && predicate(member)) return member;
    if (member?.provisioning?.status === "failed") {
      throw new Error(`${label} failed (${member.provisioning.safeError || "unknown"})`);
    }
    await sleep(2_000);
  }
  throw new Error(`${label} did not finish within ${timeoutMs / 1000} seconds`);
}

async function cleanupStaleSmokeAccounts(token, session) {
  const data = await appRequest("/api/tenant/members", { token });
  const staleCandidates = (data?.members || []).filter(member => isSmokeEmail(member.email));
  const staleMembers = staleCandidates.filter(isOwnedSmokeMember);
  if (staleMembers.length !== staleCandidates.length) {
    throw new Error("Refusing to clean a smoke-like membership without an exact generated name and account type");
  }
  for (const member of staleMembers) {
    const identity = await findAuthentikUser(session, member.email);
    assertOwnedSmokeIdentity(identity, member);
    if (
      member.status !== "disabled"
      || member.provisioning?.desiredState !== "disabled"
      || member.provisioning?.status !== "succeeded"
    ) {
      await appRequest(`/api/tenant/members/${member.id}/disable`, { token, method: "POST" });
      await waitForMember(
        token,
        member.id,
        current => current.status === "disabled"
          && current.provisioning?.status === "succeeded"
          && current.provisioning?.desiredState === "disabled",
        "Stale smoke-account cleanup"
      );
    }
    if (identity?.pk) {
      await authentikRequest(session, `/api/v3/core/users/${identity.pk}/`, { method: "DELETE" });
    }
  }
  return staleMembers.length;
}

async function verifyResponsiveTeamUi(token, expectedName) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const viewports = [
      { width: 1440, height: 900 },
      { width: 412, height: 915, isMobile: true, hasTouch: true }
    ];
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile === true,
        hasTouch: viewport.hasTouch === true
      });
      const page = await context.newPage();
      await page.addInitScript(({ accessToken }) => {
        localStorage.setItem("inventory.auth.session", JSON.stringify({
          accessToken,
          expiresAt: Date.now() + 30 * 60 * 1000,
          createdAt: Date.now(),
          manual: true
        }));
      }, { accessToken: token });
      await page.goto(`${TENANT_ORIGIN}/#/admin`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.getByRole("heading", { name: "Leader Dashboard", exact: true }).waitFor({
        state: "visible",
        timeout: 30_000
      });
      const menu = page.getByRole("button", { name: "Open workspace menu", exact: true });
      if (await menu.count()) await menu.click();
      await page.getByRole("button", { name: "Team", exact: true }).click();
      await page.getByRole("heading", { name: "Team", exact: true }).waitFor({ state: "visible" });
      await page.getByText(expectedName, { exact: true }).first().waitFor({ state: "visible" });
      await page.getByText("Add teammate", { exact: true }).first().waitFor({ state: "visible" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`Team UI overflows the ${viewport.width}px production viewport`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function runFieldSessionSmoke(token) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const completed = [];
  const sessionName = `MVP field smoke ${TEST_RUN}`;
  const packetLine = `MVP-SMOKE-${TEST_RUN} RADIO SET LIN SMK${TEST_RUN.slice(-6).toUpperCase()}`;
  const helperName = `Smoke Helper ${TEST_RUN}`;
  let session = null;
  let sessionClosed = false;
  let crewContext = null;
  try {
    const createdSession = await appRequest("/api/inventory/sessions", {
      token,
      method: "POST",
      body: { name: sessionName, packetSource: "Production MVP smoke", status: "active" }
    });
    session = createdSession?.session || null;
    if (!session?.id) throw new Error("Field smoke did not create an inventory session");

    const imported = await appRequest(`/api/inventory/sessions/${session.id}/items/bulk`, {
      token,
      method: "POST",
      body: {
        items: [{ packetLine, expectedQty: 1, locationHint: "Smoke test staging area" }],
        importBatch: {
          sourceName: `mvp-field-smoke-${TEST_RUN}.txt`,
          sourceMimeType: "text/plain",
          extractedText: packetLine
        }
      }
    });
    const sessionItem = imported?.sessionItems?.[0];
    if (!sessionItem?.id || !imported?.importBatch?.id) {
      throw new Error("Field smoke packet import did not persist its row and source history");
    }
    completed.push("packet-imported");

    const crew = await appRequest(`/api/inventory/sessions/${session.id}/crew-access`, {
      token,
      method: "POST",
      body: { displayName: helperName }
    });
    if (!/^\d{4}$/.test(crew?.code || "") || !crew?.inviteToken || !crew?.access?.id) {
      throw new Error("Field smoke crew invite was incomplete");
    }
    completed.push("crew-invited");

    crewContext = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true
    });
    const crewPage = await crewContext.newPage();
    const joinUrl = `${TENANT_ORIGIN}/#/join?invite=${encodeURIComponent(crew.inviteToken)}`;
    await crewPage.goto(joinUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await crewPage.getByRole("heading", { name: "Join inventory", exact: true }).waitFor({ state: "visible" });
    await crewPage.getByLabel("4-digit code").fill(crew.code);
    await crewPage.getByRole("button", { name: "Join inventory", exact: true }).click();
    await crewPage.getByRole("heading", { name: "Inventory Dashboard", exact: true }).waitFor({
      state: "visible",
      timeout: 30_000
    });
    const crewOverflow = await crewPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (crewOverflow > 1) throw new Error("Crew dashboard overflows the 412px production viewport");
    if (await crewPage.getByRole("button", { name: "Team", exact: true }).count()) {
      throw new Error("Temporary crew session exposed leader-only Team navigation");
    }
    completed.push("crew-joined-mobile");

    const activeInventory = crewPage.getByRole("region", { name: "Active inventory", exact: true });
    await activeInventory.getByRole("button", { name: "Open session", exact: true }).click();
    const itemRow = crewPage.locator(".session-item").filter({ hasText: packetLine });
    await itemRow.waitFor({ state: "visible" });
    await itemRow.getByRole("button", { name: "Claim item", exact: true }).click();
    const proofDrawer = crewPage.getByRole("dialog", { name: packetLine, exact: true });
    await proofDrawer.waitFor({ state: "visible" });
    await proofDrawer.getByRole("button", { name: "Found / accounted for", exact: true }).click();
    await proofDrawer.getByPlaceholder("Where you found or checked it").fill("Production smoke cage A1");
    await proofDrawer.getByLabel("Serial number (if serialized)", { exact: true }).fill(`SMOKE-${TEST_RUN.slice(-8).toUpperCase()}`);
    await proofDrawer.getByLabel("Add item photos").setInputFiles({
      name: `mvp-smoke-${TEST_RUN}.png`,
      mimeType: "image/png",
      buffer: VALID_ONE_PIXEL_PNG
    });
    await proofDrawer.getByRole("button", { name: "Submit proof", exact: true }).click();
    await proofDrawer.waitFor({ state: "hidden", timeout: 30_000 });
    completed.push("item-claimed");
    completed.push("proof-submitted");

    const reviewContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    try {
      const reviewPage = await reviewContext.newPage();
      await reviewPage.addInitScript(({ accessToken }) => {
        localStorage.setItem("inventory.auth.session", JSON.stringify({
          accessToken,
          expiresAt: Date.now() + 30 * 60 * 1000,
          createdAt: Date.now(),
          manual: true
        }));
      }, { accessToken: token });
      await reviewPage.goto(`${TENANT_ORIGIN}/#/admin`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await reviewPage.getByRole("heading", { name: "Leader Dashboard", exact: true }).waitFor({ state: "visible" });
      const workspaceMenu = reviewPage.getByRole("button", { name: "Open workspace menu", exact: true });
      if (await workspaceMenu.isVisible()) await workspaceMenu.click();
      await reviewPage.getByRole("button", { name: "Review Queue", exact: true }).click();
      await reviewPage.getByRole("heading", { name: "Review Queue", exact: true }).waitFor({ state: "visible" });
      const reviewCard = reviewPage.locator(".review-card").filter({ hasText: packetLine });
      await reviewCard.waitFor({ state: "visible", timeout: 30_000 });
      const evidenceImage = reviewCard.locator(".proof-photo-thumbnail img").first();
      await evidenceImage.waitFor({ state: "visible", timeout: 30_000 });
      await evidenceImage.evaluate(async image => {
        if (!(image instanceof HTMLImageElement)) {
          throw new Error("Proof evidence did not render as an image");
        }
        await image.decode();
        if (image.naturalWidth < 1) {
          throw new Error("Uploaded proof image did not render in the leader review queue");
        }
      });
      await reviewCard.getByRole("button", { name: "Approve", exact: true }).click();
      await reviewCard.waitFor({ state: "hidden", timeout: 30_000 });
    } finally {
      await reviewContext.close();
    }

    const sessionDetail = await appRequest(`/api/inventory/sessions/${session.id}`, { token });
    const approvedItem = (sessionDetail?.items || []).find(item => item.id === sessionItem.id);
    const approvedSubmission = approvedItem?.submissions?.find(submission => submission.status === "found");
    if (approvedItem?.status !== "approved" || approvedSubmission?.reviewState !== "approved") {
      throw new Error("Leader approval did not update the item and proof state");
    }
    completed.push("proof-approved");

    const closed = await appRequest(`/api/inventory/sessions/${session.id}`, {
      token,
      method: "PATCH",
      body: { status: "closed" }
    });
    sessionClosed = closed?.session?.status === "closed";
    if (!sessionClosed || Number(closed?.crewAccessRevoked || 0) < 1) {
      throw new Error("Session closeout did not revoke its temporary crew access");
    }
    completed.push("session-closed");

    const revokedStatus = await crewPage.evaluate(async ({ apiOrigin, tenantSlug }) => {
      const response = await fetch(`${apiOrigin}/api/me`, {
        credentials: "include",
        headers: { "X-Tenant-Slug": tenantSlug }
      });
      return response.status;
    }, { apiOrigin: API_ORIGIN, tenantSlug: TENANT_SLUG });
    if (revokedStatus !== 401) throw new Error("Closed-session crew credential still reaches the API");
    const crewList = await appRequest(`/api/inventory/sessions/${session.id}/crew-access`, { token });
    const closedGrant = (crewList?.crew || []).find(access => access.id === crew.access.id);
    if (closedGrant?.status !== "revoked") throw new Error("Crew grant did not record closeout revocation");

    const reuseContext = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    try {
      const reusePage = await reuseContext.newPage();
      await reusePage.goto(joinUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await reusePage.getByLabel("4-digit code").fill(crew.code);
      await reusePage.getByRole("button", { name: "Join inventory", exact: true }).click();
      await reusePage.getByRole("status").filter({ hasText: "invalid or no longer available" }).waitFor({
        state: "visible",
        timeout: 20_000
      });
    } finally {
      await reuseContext.close();
    }
    completed.push("temporary-access-cleaned");
    return completed;
  } finally {
    if (crewContext) await crewContext.close().catch(() => {});
    if (session?.id && !sessionClosed) {
      try {
        const queue = await appRequest("/api/inventory/review-queue", { token });
        for (const submission of (queue?.submissions || []).filter(entry => entry.session?.id === session.id)) {
          await appRequest(`/api/submissions/${submission.id}/review`, {
            token,
            method: "PATCH",
            body: { decision: "rejected", note: "Automatic smoke-test cleanup" }
          });
        }
        await appRequest(`/api/inventory/sessions/${session.id}`, {
          token,
          method: "PATCH",
          body: { status: "closed" }
        });
      } catch {
        // Preserve the original failure. The named closed-session audit row makes
        // any exceptional cleanup follow-up easy to locate without leaking data.
      }
    }
    await browser.close();
  }
}

let adminToken = "";
let authentikAdminSession = null;
let createdMember = null;
let createdAuthentikUser = null;
let primaryError = null;
const checks = [];

try {
  adminToken = await oidcAccessToken(ADMIN_USERNAME, ADMIN_PASSWORD);
  const adminMe = await appRequest("/api/me", { token: adminToken });
  if (adminMe?.membership?.role !== "tenant_admin" && adminMe?.isPlatformAdmin !== true) {
    throw new Error("Smoke administrator does not have leader access");
  }
  checks.push("leader-login");

  const tenantData = await appRequest("/api/tenant", { token: adminToken });
  if (!tenantData?.tenant?.id || tenantData.tenant.slug !== TENANT_SLUG) {
    throw new Error("Inventory API returned the wrong tenant during smoke setup");
  }
  authentikAdminSession = await solveAuthentication(
    AUTHENTIK_ADMIN_USERNAME,
    AUTHENTIK_ADMIN_PASSWORD
  );
  const authentikMe = await authentikRequest(authentikAdminSession, "/api/v3/core/users/me/");
  if (authentikMe?.user?.is_superuser !== true && authentikMe?.is_superuser !== true) {
    throw new Error("Authentik smoke administrator is not a superuser");
  }
  await ensureTenantGroupTagged(authentikAdminSession, tenantData.tenant);
  checks.push("tenant-group-tagged");
  const staleCleanupCount = await cleanupStaleSmokeAccounts(adminToken, authentikAdminSession);
  if (staleCleanupCount) checks.push("stale-smoke-cleaned");

  const create = await appRequest("/api/tenant/members", {
    token: adminToken,
    method: "POST",
    body: { email: TEST_EMAIL, displayName: TEST_NAME, role: "contributor" }
  });
  createdMember = create?.member || null;
  if (!createdMember?.id) throw new Error("Permanent member creation did not return a membership");
  checks.push("member-requested");

  createdMember = await waitForMember(
    adminToken,
    createdMember.id,
    member => member.status === "active"
      && member.provisioning?.status === "succeeded"
      && member.provisioning?.step === "complete"
      && Boolean(member.provisioning?.enrollmentSentAt),
    "Permanent account provisioning"
  );
  checks.push("account-provisioned");
  checks.push("enrollment-sent");
  await verifyResponsiveTeamUi(adminToken, TEST_NAME);
  checks.push("responsive-team-ui");

  createdAuthentikUser = await findAuthentikUser(authentikAdminSession, TEST_EMAIL);
  if (!createdAuthentikUser?.pk) throw new Error("Provisioned Authentik identity was not found");
  checks.push("identity-found");

  await authentikRequest(authentikAdminSession, `/api/v3/core/users/${createdAuthentikUser.pk}/set_password/`, {
    method: "POST",
    body: { password: TEST_PASSWORD }
  });
  checks.push("password-set-for-smoke");

  const memberToken = await oidcAccessToken(TEST_EMAIL, TEST_PASSWORD);
  const memberMe = await appRequest("/api/me", { token: memberToken });
  if (memberMe?.membership?.role !== "contributor") {
    throw new Error("Provisioned teammate did not receive contributor access");
  }
  checks.push("member-login");

  checks.push(...await runFieldSessionSmoke(adminToken));
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  if (createdMember?.id && adminToken) {
    try {
      await appRequest(`/api/tenant/members/${createdMember.id}/disable`, {
        token: adminToken,
        method: "POST"
      });
      await waitForMember(
        adminToken,
        createdMember.id,
        member => member.status === "disabled"
          && member.provisioning?.status === "succeeded"
          && member.provisioning?.desiredState === "disabled",
        "Permanent account cleanup"
      );
      checks.push("membership-disabled");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    if (!authentikAdminSession) {
      authentikAdminSession = await solveAuthentication(
        AUTHENTIK_ADMIN_USERNAME,
        AUTHENTIK_ADMIN_PASSWORD
      );
    }
    createdAuthentikUser ||= await findAuthentikUser(authentikAdminSession, TEST_EMAIL);
    if (createdAuthentikUser?.pk) {
      assertOwnedSmokeIdentity(createdAuthentikUser, createdMember);
      await authentikRequest(authentikAdminSession, `/api/v3/core/users/${createdAuthentikUser.pk}/`, {
        method: "DELETE"
      });
      const remaining = await findAuthentikUser(authentikAdminSession, TEST_EMAIL);
      if (remaining) throw new Error("Tagged Authentik smoke identity still exists after cleanup");
      checks.push("identity-deleted");
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length) {
    const cleanupMessage = cleanupErrors.map(error => error.message).join("; ");
    primaryError = primaryError
      ? new Error(`${primaryError.message}; cleanup: ${cleanupMessage}`)
      : new Error(`Cleanup failed: ${cleanupMessage}`);
  }
}

if (primaryError) {
  console.error(JSON.stringify({ ok: false, checks, error: primaryError.message }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks }));
}
