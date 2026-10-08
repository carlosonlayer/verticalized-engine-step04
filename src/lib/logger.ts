import pino, { type Logger } from "pino";

/**
 * Log estruturado em JSON, no formato que o Cloud Logging entende (campo "severity").
 *
 * REGRA DO PROJETO: logs carregam IDs, contagens, tempos e códigos de erro.
 * Nunca conteúdo de documento, descrição de movimentação, nome, trecho ou corpo
 * de chamada ao Gemini. A lista REDACT_PATHS é só a rede de segurança —
 * o código não deve nem tentar logar esses campos.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "authorization",
  "*.authorization",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "content",
  "*.content",
  "excerpt",
  "*.excerpt",
  "description",
  "*.description",
  "text",
  "*.text",
  "evidence",
  "*.evidence",
  "body",
  "*.body",
];

const SEVERITY: Record<string, string> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export function createLogger(level: string = "info", destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      messageKey: "message",
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ severity: SEVERITY[label] ?? "DEFAULT", level: label }),
      },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    destination,
  );
}
