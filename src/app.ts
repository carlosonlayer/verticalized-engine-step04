import cors from "cors";
import express, { type Express } from "express";
import type { Logger } from "pino";
import type { Env } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import { errorHandler, notFound, requestContext, securityHeaders } from "./middleware/http.js";
import { healthRouter } from "./routes/health.js";

const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp({ env, logger }: { env: Env; logger: Logger }): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // Cloud Run fica atrás de um proxy do Google

  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use(
    cors({
      origin(origin, cb) {
        // Sem Origin = chamada servidor-a-servidor (curl, health check) → permitido.
        if (!origin) return cb(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        if (env.NODE_ENV !== "production" && DEV_ORIGIN.test(origin)) return cb(null, true);
        return cb(new AppError("CORS_FORBIDDEN", "Origem não permitida.", 403));
      },
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
      maxAge: 600,
    }),
  );
  // JSON pequeno: arquivos chegam por multipart (STEP 07), não por JSON.
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(env.APP_VERSION));
  // STEP 07: app.use(workRouter(...))

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
