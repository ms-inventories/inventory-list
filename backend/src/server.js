import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import { assertProductionConfig, config } from "./config.js";
import { closePool, query } from "./db.js";
import { registerMediaRoutes } from "./media.js";
import {
  startProvisioningWorker,
  stopProvisioningWorker
} from "./provisioning.js";
import { registerRoutes } from "./routes.js";

assertProductionConfig();

if (config.env === "production" && config.storage.mediaSigningSecretIsEphemeral) {
  console.warn("MEDIA_SIGNING_SECRET is not configured; using a process-local signing key. Set a persistent secret before scaling beyond one API instance.");
}

async function verifyProductionDependencies() {
  await query("SELECT 1");

  await fs.mkdir(config.storage.root, { recursive: true });
  const probePath = path.join(config.storage.root, `.startup-probe-${crypto.randomUUID()}`);
  await fs.writeFile(probePath, "ready", { flag: "wx" });
  await fs.unlink(probePath);
}

if (config.env === "production") {
  await verifyProductionDependencies();
}

const app = express();
if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);

function requestIdFromHeader(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = String(candidate || "").trim();
  return /^[A-Za-z0-9._-]{8,80}$/.test(normalized) ? normalized : "";
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (!config.corsOrigins.length || config.corsOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const baseDomain = config.baseDomain.toLowerCase();
    return url.protocol === "https:" && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`));
  } catch {
    return false;
  }
}

app.use((request, response, next) => {
  const requestId = requestIdFromHeader(request.headers["x-request-id"]) || crypto.randomUUID();
  request.requestId = requestId;
  response.setHeader("X-Request-ID", requestId);
  next();
});
app.use(express.json({ limit: "20mb" }));
registerMediaRoutes(app);
app.use(cors({
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin not allowed"), false);
  },
  credentials: true
}));

registerRoutes(app);

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`inventory-list-api listening on ${config.port}`);
  startProvisioningWorker();
});

let closing = null;
const close = signal => {
  if (closing) return closing;
  closing = (async () => {
    console.log(`shutting down from ${signal}`);
    await new Promise(resolve => server.close(resolve));
    await stopProvisioningWorker();
    await closePool();
    process.exit(0);
  })();
  return closing;
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
