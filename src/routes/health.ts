import { Router } from "express";

/**
 * GET /health — liveness do processo.
 *
 * Decisão: NÃO consulta o banco. Se o Supabase oscilar, o Cloud Run não deve
 * matar instâncias saudáveis (e trabalhos em andamento) por causa disso.
 * Falhas de banco aparecem nos próprios trabalhos, com estado "failed" explícito.
 */
export function healthRouter(version: string) {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "verticalized-engine", version });
  });
  return router;
}
