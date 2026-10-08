import type { TX_CATEGORIES } from "../contract.js";
import type { ParsedTransaction } from "../parsers/types.js";

/**
 * CLASSIFICAÇÃO de movimentações — determinística, conservadora, sem LLM.
 *
 * Usa APENAS o que está no extrato: descrição (já mascarada), direção (entrada/saída)
 * e o tipo informado pelo banco (OFX TRNTYPE). Cada categoria vem de uma regra
 * explícita com id; sem regra que case, a categoria é "unknown".
 *
 * "NÃO EXIGE COMPROVANTE" (receiptRequirement = "not_required") existe SOMENTE para
 * fee, investment e own_transfer — e SOMENTE quando uma regra explícita casou.
 * Qualquer dúvida (regras conflitantes, estorno/devolução, direção incompatível)
 * vira "unknown", e saída "unknown" EXIGE comprovante: na dúvida, pergunta-se.
 */
export type Category = (typeof TX_CATEGORIES)[number];

export type ReceiptRequirement = "required" | "not_required" | "optional";

export type Classification = {
  category: Category;
  receiptRequirement: ReceiptRequirement;
  ruleId: string | null; // regra que decidiu (null quando unknown)
  matchedTerm: string | null; // trecho da descrição (ou tipo do banco) que casou — a evidência
  reason: string; // explicação em português
};

export type ClassifiedTransaction = ParsedTransaction & { classification: Classification };

type Direction = "in" | "out";
type Rule = {
  id: string;
  category: Category;
  direction: Direction | "any";
  pattern?: RegExp; // aplicado sobre a descrição normalizada
  bankTypes?: string[]; // aplicado sobre o TRNTYPE
};

// ---------------------------------------------------------------------------
// REGRAS — grupo A (movimentações "do próprio banco/conta"). Ordem não importa:
// se duas categorias diferentes deste grupo casarem, o resultado é "unknown".
// ---------------------------------------------------------------------------
export const SPECIAL_RULES: readonly Rule[] = [
  { id: "FEE_TARIFA", category: "fee", direction: "out", pattern: /\b(TARIFAS?|TAR (PIX|TED|DOC|BANCARIA|PACOTE|MANUT|MANUTENCAO|CESTA|SAQUE|EXTRATO)|CESTA (DE )?SERVICOS)\b/ },
  { id: "FEE_IOF", category: "fee", direction: "out", pattern: /\bIOF\b/ },
  { id: "FEE_JUROS_LIMITE", category: "fee", direction: "out", pattern: /\b(JUROS|ENCARGOS) (DE |DO )?(CHEQUE ESPECIAL|LIMITE|SALDO DEVEDOR|CONTA GARANTIDA)\b/ },
  { id: "FEE_BANK_TYPE", category: "fee", direction: "out", bankTypes: ["FEE", "SRVCHG"] },
  { id: "INVESTMENT_TERMS", category: "investment", direction: "any", pattern: /\b(APLICACAO|APLIC|RESGATE|RESG|CDB|RDB|LCI|LCA|POUPANCA|TESOURO DIRETO|FUNDO DE INVESTIMENTO|RENDE FACIL)\b/ },
  { id: "INVESTMENT_YIELD", category: "investment", direction: "in", pattern: /\bRENDIMENTOS?\b/ },
  { id: "OWN_TRANSFER_TERMS", category: "own_transfer", direction: "any", pattern: /\b(MESMA TITULARIDADE|MESMO TITULAR|CONTAS? PROPRIAS?|ENTRE CONTAS PROPRIAS|TRANSF(ERENCIA)? PROPRIA)\b/ },
  { id: "WITHDRAWAL_TERMS", category: "withdrawal", direction: "out", pattern: /\b(SAQUE|SAQ|RETIRADA)\b/ },
  { id: "WITHDRAWAL_BANK_TYPE", category: "withdrawal", direction: "out", bankTypes: ["ATM", "CASH"] },
];

// grupo B — movimentações comuns (só se nenhuma regra do grupo A casou)
export const REGULAR_RULES: readonly Rule[] = [
  { id: "PAYMENT_TERMS", category: "regular_payment", direction: "out", pattern: /\b(PIX ENVIADO|PIX ENV|PIX TRANSF|PIX PAGAMENTO|PAGTO|PGTO|PAGAMENTO|PAG|BOLETO|TED|DOC|TRANSFERENCIA ENVIADA|TRANSF ENVIADA|COMPRA|DEBITO AUTOMATICO|DEB AUTOM|DEB AUT)\b/ },
  { id: "RECEIPT_TERMS", category: "regular_receipt", direction: "in", pattern: /\b(PIX RECEBIDO|PIX REC|TED RECEBIDA|TED REC|DOC RECEBIDO|TRANSFERENCIA RECEBIDA|TRANSF RECEBIDA|DEPOSITO|DEP|CREDITO|RECEBIMENTO|VENDAS?|LIQUIDACAO)\b/ },
];

// estorno/devolução/cancelamento: sempre "unknown" (precisa de olho humano)
export const REVERSAL_PATTERN = /\b(ESTORNO|ESTORNADO|DEVOLUCAO|DEVOLVIDO|DEVOLVIDA|CANCELAMENTO|CANCELADO|CHARGEBACK)\b/;

/** Única fonte da regra "não exige comprovante". */
export const NOT_REQUIRED_CATEGORIES: readonly Category[] = ["fee", "investment", "own_transfer"];

export function receiptRequirementOf(category: Category, direction: Direction): ReceiptRequirement {
  if (NOT_REQUIRED_CATEGORIES.includes(category)) return "not_required";
  if (category === "regular_payment" || category === "withdrawal") return "required";
  if (category === "regular_receipt") return "optional";
  return direction === "out" ? "required" : "optional"; // unknown: saída sempre pede comprovante
}

/** Descrição → MAIÚSCULAS, sem acento, só letras/números/espaço. */
export function normalizeDescription(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function ruleHit(rule: Rule, text: string, bankType: string | null, dir: Direction): string | null {
  if (rule.direction !== "any" && rule.direction !== dir) return null;
  if (rule.bankTypes && bankType && rule.bankTypes.includes(bankType.toUpperCase())) return `TRNTYPE=${bankType.toUpperCase()}`;
  if (rule.pattern) {
    const m = text.match(rule.pattern);
    if (m) return m[0];
  }
  return null;
}

export function classifyTransaction(tx: Pick<ParsedTransaction, "description" | "direction" | "bankType">): Classification {
  const dir = tx.direction;
  const text = normalizeDescription(tx.description);
  const unknown = (reason: string): Classification => ({
    category: "unknown", receiptRequirement: receiptRequirementOf("unknown", dir), ruleId: null, matchedTerm: null, reason,
  });

  const reversal = text.match(REVERSAL_PATTERN);
  if (reversal) return { ...unknown(`Estorno/devolução ("${reversal[0]}") precisa de conferência humana.`), matchedTerm: reversal[0] };

  const hits = SPECIAL_RULES.map((r) => ({ r, term: ruleHit(r, text, tx.bankType, dir) })).filter((h) => h.term !== null);
  const categories = [...new Set(hits.map((h) => h.r.category))];
  if (categories.length > 1) {
    return unknown(`Regras conflitantes (${hits.map((h) => h.r.id).join(", ")}): sem evidência suficiente para decidir.`);
  }
  if (categories.length === 1) {
    const h = hits[0];
    return {
      category: h.r.category,
      receiptRequirement: receiptRequirementOf(h.r.category, dir),
      ruleId: h.r.id,
      matchedTerm: h.term,
      reason: REASONS[h.r.category],
    };
  }

  for (const r of REGULAR_RULES) {
    const term = ruleHit(r, text, tx.bankType, dir);
    if (term) {
      return { category: r.category, receiptRequirement: receiptRequirementOf(r.category, dir), ruleId: r.id, matchedTerm: term, reason: REASONS[r.category] };
    }
  }
  return unknown("Nenhuma regra reconheceu esta movimentação.");
}

/**
 * Classifica todas as movimentações. NÃO altera nenhum dado: devolve cópias com o campo
 * `classification` acrescentado — mesmo número de itens, mesma ordem, mesmo valor,
 * mesma data, mesmo sinal, mesmo seq/fitid.
 */
export function classifyTransactions(txs: readonly ParsedTransaction[]): ClassifiedTransaction[] {
  return txs.map((tx) => ({ ...tx, classification: classifyTransaction(tx) }));
}

const REASONS: Record<Category, string> = {
  fee: "Tarifa, IOF ou encargo cobrado pelo próprio banco: não exige comprovante.",
  investment: "Aplicação, resgate ou rendimento: dinheiro do próprio titular, não exige comprovante.",
  own_transfer: "Transferência entre contas do mesmo titular: não exige comprovante.",
  withdrawal: "Saque: exige comprovante ou justificativa do uso do dinheiro.",
  regular_payment: "Pagamento a terceiro: exige comprovante.",
  regular_receipt: "Recebimento: documento opcional.",
  unknown: "Sem evidência suficiente para classificar.",
};

/** Categoria fina (STEP 04) → `kind` do contrato (STEP 03). */
export function categoryToKind(c: Category): "normal" | "fee" | "own_transfer" | "investment" {
  return c === "fee" || c === "own_transfer" || c === "investment" ? c : "normal";
}
