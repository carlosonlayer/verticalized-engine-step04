import { z } from "zod";

/**
 * Configuração do processo, validada na inicialização.
 * Se faltar algo obrigatório em produção, o servidor NÃO sobe — melhor falhar
 * no deploy do que falhar no meio do trabalho de um usuário.
 * A mensagem de erro lista só os NOMES das variáveis, nunca os valores.
 */
const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    APP_VERSION: z.string().default("dev"),

    // CORS: lista de origens do frontend, separadas por vírgula.
    CORS_ORIGINS: csv,

    // Supabase — projeto EXCLUSIVO da VERTICALIZED (nunca o da Ízis).
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),

    // Gemini — usado a partir do STEP 05. Opcional até lá.
    GEMINI_API_KEY: z.string().min(10).optional(),
    GEMINI_MODEL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "obrigatória em produção" });
    }
    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({ code: "custom", path: ["CORS_ORIGINS"], message: "obrigatória em produção" });
    }
    if (env.CORS_ORIGINS.includes("*")) {
      ctx.addIssue({ code: "custom", path: ["CORS_ORIGINS"], message: "'*' não é permitido" });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  constructor(public readonly variables: string[]) {
    super(`Configuração inválida: ${variables.join(", ")}`);
    this.name = "EnvError";
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "?")))];
    throw new EnvError(vars);
  }
  return parsed.data;
}
