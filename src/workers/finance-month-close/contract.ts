import { z } from "zod";

/**
 * CONTRATO do Worker #001 — Financeiro · Fechar o mês.
 *
 * Este é o formato que o pipeline real (STEP 07) DEVE devolver. O dataset de
 * regressão (test/regression) julga qualquer implementação contra este contrato.
 *
 * Regra: o schema aqui valida ESTRUTURA (tipos, enums, inteiros). As regras de
 * SENTIDO (par confirmado indevidamente, evidência que não existe no arquivo,
 * falha silenciosa) são verificadas pelo juiz do dataset (evaluate.ts) e, no
 * STEP 07, pelos validadores de consistência.
 */

// ---------------------------------------------------------------- entrada

export type WorkFile = { fileName: string; bytes: Uint8Array };
export type MonthCloseInput = { statement: WorkFile; documents: WorkFile[] };

// ---------------------------------------------------------------- saída

const cents = z.number().int().refine(Number.isSafeInteger, "centavos devem ser inteiro seguro");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const EvidenceSchema = z.object({
  document_id: z.string().min(1),
  file_name: z.string().min(1),
  page: z.number().int().min(1),
  line: z.number().int().min(1).nullable(),
  excerpt: z.string(),
  method: z.enum(["structured", "text", "vision"]),
  verified: z.boolean(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const TX_KINDS = ["normal", "fee", "own_transfer", "investment"] as const;
/**
 * Categoria fina da movimentação (STEP 04). Opcional e compatível: `kind` continua sendo
 * o campo julgado pelos casos C01–C13; `category` diz POR QUE (ex.: "withdrawal" e
 * "regular_payment" são ambos kind "normal"). Mapeamento em statement/classify.ts.
 */
export const TX_CATEGORIES = [
  "fee", "own_transfer", "investment", "withdrawal", "regular_payment", "regular_receipt", "unknown",
] as const;
export const TX_STATUSES = [
  "matched", "needs_confirmation", "missing_receipt", "divergent", "no_receipt_needed", "unmatched_credit",
] as const;
export const DOC_STATUSES = ["statement", "matched", "needs_confirmation", "without_transaction", "duplicate", "illegible"] as const;
export const MATCH_RULES = ["exact", "exclusive", "grouped", "partial", "with_fees"] as const;
export const AUTO_CONFIRMABLE_RULES = ["exact", "exclusive"] as const;
export const FINDING_TYPES = [
  "missing_receipt", "amount_divergence", "duplicate_transaction", "payment_duplication", "duplicate_document",
  "unmatched_document", "needs_confirmation", "grouped_payment", "paid_with_fees", "unreadable_document",
  "unverified_extraction", "out_of_period", "balance_failure",
] as const;
export const BALANCE_STATUSES = ["passed", "failed", "structural_only", "not_available"] as const;

export const ResultTransactionSchema = z.object({
  id: z.string().min(1),
  fitid: z.string().nullable(),
  date: isoDate,
  description: z.string(),
  amount_cents: cents.refine((v) => v !== 0, "movimentação não pode ser zero"),
  kind: z.enum(TX_KINDS),
  category: z.enum(TX_CATEGORIES).optional(),
  status: z.enum(TX_STATUSES),
  evidence: z.array(EvidenceSchema),
});

export const ResultDocumentSchema = z.object({
  id: z.string().min(1),
  file_name: z.string().min(1),
  role: z.enum(["statement", "supporting"]),
  doc_type: z.string().nullable(),
  legibility: z.enum(["ok", "partial", "illegible", "unprocessed"]),
  counterparty_name: z.string().nullable(),
  amount_cents: cents.nullable(),
  date: isoDate.nullable(),
  status: z.enum(DOC_STATUSES),
  evidence: z.array(EvidenceSchema),
});

export const ResultMatchSchema = z.object({
  id: z.string().min(1),
  transaction_ids: z.array(z.string()).min(1),
  document_ids: z.array(z.string()).min(1),
  rule: z.enum(MATCH_RULES),
  status: z.enum(["confirmed", "needs_confirmation"]),
  score: z.number().min(0).max(1),
  amount_diff_cents: cents,
});

export const ResultFindingSchema = z.object({
  id: z.string().min(1),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(["high", "medium", "low"]),
  title: z.string(),
  detail: z.string(),
  transaction_id: z.string().nullable(),
  document_id: z.string().nullable(),
  expected_cents: cents.nullable(),
  found_cents: cents.nullable(),
  diff_cents: cents.nullable(),
  evidence: z.array(EvidenceSchema),
});

export const WorkResultSchema = z.object({
  status: z.enum(["completed", "needs_review"]),
  review_reasons: z.array(z.string()),
  period: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), account_label: z.string().nullable() }),
  summary: z.object({
    transactions_total: z.number().int(),
    matched: z.number().int(),
    needs_confirmation: z.number().int(),
    missing_receipt: z.number().int(),
    amount_divergences: z.number().int(),
    possible_duplicates: z.number().int(),
    no_receipt_needed: z.number().int(),
    documents_total: z.number().int(),
    documents_without_transaction: z.number().int(),
    illegible_documents: z.number().int(),
    total_in_cents: cents,
    total_out_cents: cents,
    balance_check: z.object({
      status: z.enum(BALANCE_STATUSES),
      opening_cents: cents.nullable(),
      closing_cents: cents.nullable(),
      computed_closing_cents: cents.nullable(),
      diff_cents: cents.nullable(),
    }),
  }),
  transactions: z.array(ResultTransactionSchema),
  documents: z.array(ResultDocumentSchema),
  matches: z.array(ResultMatchSchema),
  findings: z.array(ResultFindingSchema),
  pending_actions: z.array(
    z.object({ finding_id: z.string(), action: z.string(), owner: z.enum(["user", "accountant", "supplier"]) }),
  ),
  ignored_files: z.array(z.object({ file_name: z.string(), reason: z.string() })),
  accountant_message: z.string(),
  disclaimer: z.string(),
});
export type WorkResult = z.infer<typeof WorkResultSchema>;

/** Desfecho de um trabalho: recusado na entrada (422), falhou, ou produziu resultado. */
export type WorkerOutcome =
  | { kind: "rejected"; code: string; file?: string; message: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "result"; result: WorkResult };

export type MonthCloseWorker = (input: MonthCloseInput) => Promise<WorkerOutcome>;

export const DISCLAIMER =
  "Este fechamento organiza e confere seus documentos. Ele não substitui o trabalho do seu contador e não constitui escrituração contábil.";
