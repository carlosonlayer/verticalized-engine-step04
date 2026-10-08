import type { ParsedStatement, ParsedTransaction } from "../parsers/types.js";
import { validateStructure, type StatementIssue, type StructuralReport } from "./validate.js";

/**
 * VALIDAÇÃO DE SALDO — determinística, em centavos inteiros (BigInt), tolerância ZERO.
 *
 * Como o status é decidido (nesta ordem):
 *
 *   1. Erro estrutural (sinal contraditório, valor não inteiro, FITID repetido…)  → "failed"
 *   2. Saldo por linha disponível em TODAS as movimentações:
 *        - detecta a ordem do arquivo (crescente ou mais-recente-primeiro) pela própria aritmética;
 *        - qualquer linha que não fecha                                             → "failed" (aponta a linha)
 *        - linhas fecham + saldo inicial E final explícitos e coerentes             → "passed"
 *        - linhas fecham, mas falta saldo inicial ou final                          → "structural_only"
 *   3. Saldo inicial E final explícitos (sem saldo por linha):
 *        inicial + Σ movimentos = final  → "passed";  senão → "failed"
 *   4. OFX com período declarado e coerente, todas as movimentações dentro dele,
 *      FITID em todas e sem repetição                                                → "structural_only"
 *   5. Nada disso                                                                    → "not_available"
 *
 * Nunca inventamos saldo inicial. "passed" exige prova completa: âncora no início e no fim.
 */
export type BalanceStatus = "passed" | "failed" | "structural_only" | "not_available";
export type BalanceMethod = "opening_closing" | "running_balance" | "structural" | "none";
export type RowOrder = "ascending" | "descending" | "single" | "unknown";

export type BalanceResult = {
  status: BalanceStatus;
  method: BalanceMethod;
  order: RowOrder | null; // só quando há saldo por linha
  openingCents: number | null;
  closingCents: number | null;
  computedClosingCents: number | null; // inicial + Σ movimentos (só quando há saldo inicial)
  diffCents: number | null; // final − calculado (só quando há os dois)
  sumCents: number; // Σ movimentos
  firstBroken: { seq: number; line: number } | null; // primeira linha onde a conta não fecha
  issues: StatementIssue[]; // inclui os da validação estrutural
  structural: StructuralReport;
};

const big = (n: number) => BigInt(n);
const num = (b: bigint) => {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError("centavos fora do intervalo seguro");
  return n;
};

export function checkBalance(st: ParsedStatement): BalanceResult {
  const structural = validateStructure(st);
  const issues: StatementIssue[] = [...structural.issues];
  const txs = st.transactions;
  const opening = st.openingBalanceCents;
  const closing = st.closingBalanceCents;

  const base = (partial: Partial<BalanceResult> & Pick<BalanceResult, "status" | "method">): BalanceResult => ({
    order: null,
    openingCents: opening,
    closingCents: closing,
    computedClosingCents: null,
    diffCents: null,
    sumCents: 0,
    firstBroken: null,
    issues,
    structural,
    ...partial,
  });

  // 1. dados estruturalmente inválidos: não há conta confiável a fazer
  if (!structural.ok) return base({ status: "failed", method: "structural" });

  const sum = txs.reduce((acc, t) => acc + big(t.amountCents), 0n);
  const computed = opening !== null ? big(opening) + sum : null;
  const diff = computed !== null && closing !== null ? big(closing) - computed : null;
  const totals = {
    sumCents: num(sum),
    computedClosingCents: computed !== null ? num(computed) : null,
    diffCents: diff !== null ? num(diff) : null,
  };

  // 2. saldo por linha
  const withBalance = txs.filter((t) => t.balanceAfterCents !== null).length;
  if (txs.length > 0 && withBalance === txs.length) {
    const rb = checkRunningBalance(txs);
    if (!rb.consistent) {
      // Localização: com saldo inicial, refaz a conta em ordem cronológica e aponta a primeira
      // linha cujo saldo declarado diverge do calculado (pares sozinhos não distinguem se o erro
      // está na linha i−1 ou na i). Sem saldo inicial, fica a primeira quebra entre pares.
      let at = rb.firstBroken!;
      if (opening !== null && rb.order !== "unknown") {
        const chrono = rb.order === "descending" ? [...txs].reverse() : txs;
        let expected = big(opening);
        for (const t of chrono) {
          expected += big(t.amountCents);
          if (big(t.balanceAfterCents!) !== expected) {
            at = t;
            break;
          }
        }
      }
      issues.push({
        code: rb.order === "unknown" ? "RUNNING_BALANCE_ORDER_UNKNOWN" : "RUNNING_BALANCE_BROKEN",
        severity: "error",
        message: rb.order === "unknown"
          ? "Não foi possível determinar a ordem das linhas pelo saldo: o extrato tem linhas que não fecham."
          : `O saldo não fecha na linha ${at.source.line} (${at.date}).`,
        seq: at.seq,
        line: at.source.line,
      });
      return base({ status: "failed", method: "running_balance", order: rb.order, ...totals, firstBroken: ref(at) });
    }
    // linhas fecham entre si; agora as âncoras
    const chrono = rb.order === "descending" ? [...txs].reverse() : txs;
    const first = chrono[0];
    const last = chrono[chrono.length - 1];
    if (opening !== null && big(opening) + big(first.amountCents) !== big(first.balanceAfterCents!)) {
      issues.push({ code: "RUNNING_BALANCE_OPENING_MISMATCH", severity: "error", message: "Saldo inicial + primeira movimentação não bate com o saldo da primeira linha.", seq: first.seq, line: first.source.line });
      return base({ status: "failed", method: "running_balance", order: rb.order, ...totals, firstBroken: ref(first) });
    }
    if (closing !== null && big(last.balanceAfterCents!) !== big(closing)) {
      issues.push({ code: "RUNNING_BALANCE_CLOSING_MISMATCH", severity: "error", message: "Saldo da última linha não bate com o saldo final informado.", seq: last.seq, line: last.source.line });
      return base({ status: "failed", method: "running_balance", order: rb.order, ...totals, firstBroken: ref(last) });
    }
    if (diff !== null && diff !== 0n) {
      issues.push({ code: "OPENING_CLOSING_MISMATCH", severity: "error", message: `Saldo inicial + movimentos difere do saldo final em ${num(diff)} centavos.` });
      return base({ status: "failed", method: "running_balance", order: rb.order, ...totals });
    }
    if (opening !== null && closing !== null) return base({ status: "passed", method: "running_balance", order: rb.order, ...totals });
    issues.push({ code: "NO_BALANCE_ANCHOR", severity: "warning", message: "As linhas fecham entre si, mas falta saldo inicial ou final para provar que nenhuma linha se perdeu nas pontas." });
    return base({ status: "structural_only", method: "running_balance", order: rb.order, ...totals });
  }
  if (withBalance > 0) {
    issues.push({ code: "RUNNING_BALANCE_PARTIAL", severity: "warning", message: `Só ${withBalance} de ${txs.length} linhas têm saldo; a verificação linha a linha não foi usada.` });
  }

  // 3. saldo inicial e final explícitos
  if (opening !== null && closing !== null) {
    if (diff === 0n) return base({ status: "passed", method: "opening_closing", ...totals });
    issues.push({ code: "OPENING_CLOSING_MISMATCH", severity: "error", message: `Saldo inicial + movimentos difere do saldo final em ${num(diff!)} centavos.` });
    return base({ status: "failed", method: "opening_closing", ...totals });
  }

  // 4. structural_only (OFX)
  const reasons: StatementIssue[] = [];
  if (st.format !== "ofx") reasons.push({ code: "NO_BALANCE_ANCHOR", severity: "warning", message: "Extrato sem saldo inicial e final explícitos." });
  if (!structural.periodDeclared) reasons.push({ code: "PERIOD_NOT_DECLARED", severity: "warning", message: "O extrato não declara o período coberto." });
  if (!structural.fitidsComplete) reasons.push({ code: "FITIDS_INCOMPLETE", severity: "warning", message: "Nem toda movimentação tem identificador único do banco (FITID)." });
  const blocked = reasons.length > 0 || !structural.periodConsistent || !structural.allWithinPeriod || !structural.fitidsUnique;
  if (!blocked) return base({ status: "structural_only", method: "structural", ...totals });

  issues.push(...reasons);
  return base({ status: "not_available", method: "none", ...totals });
}

// ---------------------------------------------------------------------------
// Saldo linha a linha + detecção de ordem
// ---------------------------------------------------------------------------

type RunningCheck = { consistent: boolean; order: RowOrder; firstBroken: ParsedTransaction | null };

/**
 * Descobre a ordem pelas contas, não pela aparência:
 *   crescente:            saldo[i−1] + valor[i] = saldo[i]
 *   mais recente primeiro: saldo[i+1] + valor[i] = saldo[i]
 * Ganha a orientação em que mais pares fecham. Empate: a ordem das datas desempata.
 */
export function checkRunningBalance(txs: ParsedTransaction[]): RunningCheck {
  const n = txs.length;
  if (n === 1) return { consistent: true, order: "single", firstBroken: null };
  const b = txs.map((t) => big(t.balanceAfterCents!));
  const a = txs.map((t) => big(t.amountCents));

  const ascBreaks: number[] = [];
  for (let i = 1; i < n; i++) if (b[i - 1] + a[i] !== b[i]) ascBreaks.push(i);
  const descBreaks: number[] = [];
  for (let i = n - 2; i >= 0; i--) if (b[i + 1] + a[i] !== b[i]) descBreaks.push(i);

  const dates = txs.map((t) => t.date);
  const nonDecreasing = dates.every((d, i) => i === 0 || dates[i - 1] <= d);
  const nonIncreasing = dates.every((d, i) => i === 0 || dates[i - 1] >= d);

  let order: RowOrder;
  if (ascBreaks.length < descBreaks.length) order = "ascending";
  else if (descBreaks.length < ascBreaks.length) order = "descending";
  else if (nonDecreasing && !nonIncreasing) order = "ascending";
  else if (nonIncreasing && !nonDecreasing) order = "descending";
  else order = "unknown";

  if (order === "ascending") {
    return ascBreaks.length === 0
      ? { consistent: true, order, firstBroken: null }
      : { consistent: false, order, firstBroken: txs[ascBreaks[0]] };
  }
  if (order === "descending") {
    // a primeira quebra em ordem CRONOLÓGICA é a de maior índice no arquivo
    return descBreaks.length === 0
      ? { consistent: true, order, firstBroken: null }
      : { consistent: false, order, firstBroken: txs[descBreaks[0]] };
  }
  return { consistent: false, order, firstBroken: txs[Math.min(ascBreaks[0] ?? 0, descBreaks[descBreaks.length - 1] ?? 0)] };
}

function ref(t: ParsedTransaction) {
  return { seq: t.seq, line: t.source.line };
}

/** Formato do contrato (summary.balance_check). */
export function toContractBalanceCheck(r: BalanceResult) {
  return {
    status: r.status,
    opening_cents: r.openingCents,
    closing_cents: r.closingCents,
    computed_closing_cents: r.computedClosingCents,
    diff_cents: r.diffCents,
  };
}
