import { createApp } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    const boot = createLogger("error");
    boot.fatal({ missing: err instanceof EnvError ? err.variables : undefined }, "invalid_configuration");
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  const app = createApp({ env, logger });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, version: env.APP_VERSION, node_env: env.NODE_ENV }, "server_started");
  });

  // Cloud Run envia SIGTERM antes de desligar a instância.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutdown_started");
    server.close(() => {
      logger.info("shutdown_complete");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 9_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
