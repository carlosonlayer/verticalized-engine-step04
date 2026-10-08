import { Writable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { EnvError, loadEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger("info", stream) };
}

const prodEnv = loadEnv({
  NODE_ENV: "production",
  APP_VERSION: "test-1",
  CORS_ORIGINS: "https://app.verticalized.com.br",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
});

describe("GET /health", () => {
  it("responde 200 com status ok e versão", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "verticalized-engine", version: "test-1" });
  });

  it("envia cabeçalhos de segurança e request id", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).get("/health").set("x-request-id", "req-abc-12345");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toBe("req-abc-12345");
  });

  it("não depende do banco (sobe mesmo sem Supabase configurado em dev)", async () => {
    const app = createApp({ env: loadEnv({ NODE_ENV: "development" }), logger: capture().logger });
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("tratamento de erros", () => {
  it("rota inexistente → 404 no formato padrão", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).get("/nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "NOT_FOUND", message: expect.any(String) });
  });

  it("JSON malformado → 400 INVALID_JSON", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).post("/qualquer").set("content-type", "application/json").send("{oops");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});

describe("CORS", () => {
  it("aceita a origem configurada", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).get("/health").set("origin", "https://app.verticalized.com.br");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.verticalized.com.br");
  });

  it("recusa origem desconhecida em produção", async () => {
    const app = createApp({ env: prodEnv, logger: capture().logger });
    const res = await request(app).get("/health").set("origin", "https://site-qualquer.com");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CORS_FORBIDDEN");
  });

  it("recusa localhost em produção, aceita em desenvolvimento", async () => {
    const prod = createApp({ env: prodEnv, logger: capture().logger });
    expect((await request(prod).get("/health").set("origin", "http://localhost:5173")).status).toBe(403);
    const dev = createApp({ env: loadEnv({ NODE_ENV: "development" }), logger: capture().logger });
    expect((await request(dev).get("/health").set("origin", "http://localhost:5173")).status).toBe(200);
  });
});

describe("configuração", () => {
  it("produção sem Supabase e sem CORS não sobe, e o erro lista só os nomes", () => {
    try {
      loadEnv({ NODE_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: "segredo-que-nao-pode-vazar-123" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const err = e as EnvError;
      expect(err.variables.sort()).toEqual(["CORS_ORIGINS", "SUPABASE_URL"]);
      expect(err.message).not.toContain("segredo-que-nao-pode-vazar");
    }
  });

  it("CORS '*' é proibido em produção", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        CORS_ORIGINS: "*",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
      }),
    ).toThrow(EnvError);
  });

  it("aplica padrões em desenvolvimento", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe("development");
    expect(env.CORS_ORIGINS).toEqual([]);
  });
});

describe("logs", () => {
  it("formato do Cloud Logging (severity) e sem conteúdo de documento", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        work_id: "w1",
        tx: { description: "PIX ENVIADO JOAO DA SILVA", excerpt: "CPF 123.456.789-00", amount_cents: -125000 },
        content: "texto inteiro do extrato",
      },
      "work_progress",
    );
    const line = JSON.parse(lines[0]);
    expect(line.severity).toBe("INFO");
    expect(line.message).toBe("work_progress");
    expect(line.work_id).toBe("w1");
    const raw = lines.join("");
    expect(raw).not.toContain("JOAO DA SILVA");
    expect(raw).not.toContain("123.456.789-00");
    expect(raw).not.toContain("texto inteiro do extrato");
  });

  it("log de acesso não inclui query string nem Authorization", async () => {
    const { lines, logger } = capture();
    const app = createApp({ env: prodEnv, logger });
    await request(app).get("/health?cpf=12345678900").set("authorization", "Bearer tok_secreto_123");
    const raw = lines.join("");
    expect(raw).toContain('"route":"/health"');
    expect(raw).not.toContain("12345678900");
    expect(raw).not.toContain("tok_secreto_123");
  });
});
