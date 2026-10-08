import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import { AppError } from "./errors.js";

/**
 * Cliente Supabase do BACKEND, com a service role key.
 *
 * - A service role ignora RLS; por isso ela existe SÓ aqui, no servidor.
 * - O frontend nunca lê tabelas diretamente: todas as tabelas têm RLS ligado
 *   e nenhuma policy (= ninguém de fora lê nada).
 * - Isolamento entre usuários é responsabilidade do backend: toda consulta
 *   filtra por workspace_id do usuário autenticado (middleware no STEP 07).
 */
let client: SupabaseClient | null = null;

export function getSupabase(env: Env): SupabaseClient {
  if (client) return client;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError("DB_NOT_CONFIGURED", "Banco de dados não configurado.", 503);
  }
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Usado só em testes. */
export function resetSupabaseClient() {
  client = null;
}
