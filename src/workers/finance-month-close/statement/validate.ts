import { compareIso, diffDays, makeIsoDate, type IsoDate } from "../parsers/date.js";
import { isCents } from "../parsers/money.js";
import type { ParsedStatement } from "../parsers/types.js";

/**
 * VALIDAÇÃO ESTRUTURAL do extrato — 100% determinística.
 *
 * O leitor do STEP 02 já garante essas regras para OFX/CSV. Esta camada as verifica
 * DE NOVO porque, a partir do STEP 11, extratos também virão de PDF (com ajuda do
 * Gemini na leitura), e nada que chegue ao cálculo de saldo pode ser aceito sem prova.
 *
 * Severidade:
 *   error   → os dados não são confiáveis; o saldo é "failed".
 *   warning → os dados são coerentes, mas não provam completude (impede structural_only).
 */
export type IssueSeverity = "error" | "warning";
export type StatementIssueCode =
  | "AMOUNT_INVALID"
  | "SIGN_INCONSISTENT"
  | "DATE_INVALID"
  | "SEQ_INVALID"
  | "FITID_DUPLICATE"
  | "BALANCE_VALUE_INVALID"
  | "PERIOD_TOO_LONG"
  | "PERIOD_INVERTED"
  | "OUT_OF_DECLARED_PERIOD"
  | "CLOSING_DATE_BEFORE_LAST_TX"
  // usados pelo cálculo de saldo (balance.ts)
  | "OPENING_CLOSING_MISMATCH"
  | "RUNNING_BALANCE_BROKEN"
  | "RUNNING_BALANCE_OPENING_MISMATCH"
  | "RUNNING_BALANCE_CLOSING_MISMATCH"
  | "RUNNING_BALANCE_ORDER_UNKNOWN"
  | "RUNNING_BALANCE_PARTIAL"
  | "NO_BALANCE_ANCHOR"
  | "FITIDS_INCOMPLETE"
  | "PERIOD_NOT_DECLARED";

export type StatementIssue = {
  code: StatementIssueCode;
  severity: IssueSeverity;
  message: string;
  seq?: number;
  line?: number;
};

export type StructuralReport = {
  ok: boolean; // nenhum issue de severidade "error"
  issues: StatementIssue[];
  fitidsComplete: boolean; // toda movimentação tem FITID
  fitidsUnique: boolean;
  periodDeclared: boolean;
  periodConsistent: boolean; // início ≤ fim
  allWithinPeriod: boolean; // toda movimentação dentro do período declarado (vacuamente true sem período)
};

export const MAX_STATEMENT_DAYS = 31;

export function validateStructure(st: ParsedStatement): StructuralReport {
  const issues: StatementIssue[] = [];
  const err = (code: StatementIssueCode, message: string, seq?: number, line?: number) =>
    issues.push({ code, severity: "error", message, ...(seq !== undefined ? { seq } : {}), ...(line !== undefined ? { line } : {}) });
  const warn = (code: StatementIssueCode, message: string, seq?: number, line?: number) =>
    issues.push({ code, severity: "warning", message, ...(seq !== undefined ? { seq } : {}), ...(line !== undefined ? { line } : {}) });

  const txs = st.transactions;

  // ---- cada movimentação ----
  txs.forEach((t, i) => {
    const line = t.source?.line;
    if (!isCents(t.amountCents) || t.amountCents === 0) {
      err("AMOUNT_INVALID", `Valor inválido (precisa ser inteiro de centavos, diferente de zero): ${t.amountCents}`, t.seq, line);
    } else if ((t.amountCents < 0 ? "out" : "in") !== t.direction) {
      err("SIGN_INCONSISTENT", `Sinal do valor (${t.amountCents}) contradiz a direção "${t.direction}".`, t.seq, line);
    }
    if (!isValidIsoDate(t.date)) err("DATE_INVALID", `Data inválida: ${t.date}`, t.seq, line);
    if (t.balanceAfterCents !== null && !isCents(t.balanceAfterCents)) {
      err("BALANCE_VALUE_INVALID", `Saldo da linha inválido: ${t.balanceAfterCents}`, t.seq, line);
    }
    if (t.seq !== i + 1) err("SEQ_INVALID", `Sequência fora de ordem: esperado ${i + 1}, veio ${t.seq}`, t.seq, line);
  });

  // ---- saldos declarados ----
  if (st.openingBalanceCents !== null && !isCents(st.openingBalanceCents)) err("BALANCE_VALUE_INVALID", `Saldo inicial inválido: ${st.openingBalanceCents}`);
  if (st.closingBalanceCents !== null && !isCents(st.closingBalanceCents)) err("BALANCE_VALUE_INVALID", `Saldo final inválido: ${st.closingBalanceCents}`);

  // ---- FITID ----
  const fitids = txs.map((t) => t.fitid).filter((f): f is string => !!f);
  const fitidsComplete = txs.every((t) => !!t.fitid);
  const dupes = fitids.filter((f, i) => fitids.indexOf(f) !== i);
  for (const d of new Set(dupes)) err("FITID_DUPLICATE", `FITID repetido: ${d}`);
  const fitidsUnique = dupes.length === 0;

  // ---- período ----
  const validDates = txs.map((t) => t.date).filter(isValidIsoDate).sort();
  if (validDates.length > 0) {
    const span = diffDays(validDates[0], validDates[validDates.length - 1]) + 1;
    if (span > MAX_STATEMENT_DAYS) err("PERIOD_TOO_LONG", `Movimentações cobrem ${span} dias (máximo ${MAX_STATEMENT_DAYS}).`);
  }
  const periodDeclared = st.periodStart !== null && st.periodEnd !== null;
  let periodConsistent = true;
  let allWithinPeriod = true;
  if (periodDeclared) {
    if (compareIso(st.periodStart!, st.periodEnd!) > 0) {
      periodConsistent = false;
      warn("PERIOD_INVERTED", `Período declarado invertido: ${st.periodStart} > ${st.periodEnd}.`);
    }
    for (const t of txs) {
      if (!isValidIsoDate(t.date)) continue;
      if (compareIso(t.date, st.periodStart!) < 0 || compareIso(t.date, st.periodEnd!) > 0) {
        allWithinPeriod = false;
        warn("OUT_OF_DECLARED_PERIOD", `Movimentação de ${t.date} fora do período declarado (${st.periodStart} a ${st.periodEnd}).`, t.seq, t.source?.line);
      }
    }
  }
  if (st.closingBalanceDate && validDates.length > 0 && compareIso(st.closingBalanceDate, validDates[validDates.length - 1]) < 0) {
    warn("CLOSING_DATE_BEFORE_LAST_TX", `Saldo final é de ${st.closingBalanceDate}, antes da última movimentação (${validDates[validDates.length - 1]}).`);
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    fitidsComplete,
    fitidsUnique,
    periodDeclared,
    periodConsistent,
    allWithinPeriod,
  };
}

export function isValidIsoDate(d: unknown): d is IsoDate {
  if (typeof d !== "string") return false;
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && makeIsoDate(+m[1], +m[2], +m[3]).ok;
}
