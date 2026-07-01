import cors from "@fastify/cors";
import Fastify from "fastify";
import { assertProductionConfig, config } from "./config.js";
import { closePool } from "./db.js";
import { registerRoutes } from "./routes.js";

assertProductionConfig();

const fastify = Fastify({
  logger: true
});

await fastify.register(cors, {
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
});

await registerRoutes(fastify);

const close = async signal => {
  fastify.log.info({ signal }, "shutting down");
  await fastify.close();
  await closePool();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await fastify.listen({ port: config.port, host: "0.0.0.0" });
