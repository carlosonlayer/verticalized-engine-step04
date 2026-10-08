import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "pino";
import { AppError, Errors } from "../lib/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
    }
  }
}

/** Gera (ou reaproveita) um request id e um logger filho por requisição. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("x-request-id");
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ request_id: req.id });
    res.setHeader("x-request-id", req.id);

    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // Só método, rota, status e tempo. Nunca query string, corpo ou headers.
      req.log.info(
        { http: { method: req.method, route: req.route?.path ?? req.path, status: res.statusCode, ms: Math.round(ms) } },
        "request",
      );
    });
    next();
  };
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => next(Errors.notFound());

/**
 * Tratamento central de erros.
 * - AppError → status e mensagem próprios.
 * - JSON malformado → 400 com código estável.
 * - Qualquer outra coisa → 500 genérico (o detalhe vai para o log, sem conteúdo).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if (err?.type === "entity.parse.failed") {
    appErr = new AppError("INVALID_JSON", "O corpo da requisição não é um JSON válido.", 400);
  } else if (err?.type === "entity.too.large") {
    appErr = new AppError("PAYLOAD_TOO_LARGE", "A requisição é maior do que o permitido.", 413);
  } else {
    appErr = Errors.internal();
  }

  const log = req.log ?? console;
  if (appErr.status >= 500) {
    log.error({ err: { name: err?.name, code: appErr.code, stack: err?.stack } }, "unhandled_error");
  } else {
    log.warn({ err: { code: appErr.code, status: appErr.status } }, "request_error");
  }

  if (res.headersSent) return;
  res.status(appErr.status).json(appErr.toJSON());
};
