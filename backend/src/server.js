import cors from "cors";
import express from "express";
import { assertProductionConfig, config } from "./config.js";
import { closePool } from "./db.js";
import { registerRoutes } from "./routes.js";

assertProductionConfig();

const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (!config.corsOrigins.length || config.corsOrigins.includes(origin)) {
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
});

const close = async signal => {
  console.log(`shutting down from ${signal}`);
  await new Promise(resolve => server.close(resolve));
  await closePool();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
