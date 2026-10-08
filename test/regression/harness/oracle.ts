import { maskSensitive } from "../../../src/lib/mask.js";
import {
  DISCLAIMER,
  type Evidence,
  type WorkerOutcome,
  type WorkResult,
} from "../../../src/workers/finance-month-close/contract.js";
import { parseStatement } from "../../../src/workers/finance-month-close/parsers/statement.js";
import { asArray, type FindingPattern } from "./case-schema.js";
import type { LoadedCase } from "./load.js";

/**
 * WORKER-ORÁCULO — só para autoteste do juiz. NÃO é implementação do produto.
 *
 * Monta, a partir do gabarito do caso, a resposta que um Worker perfeito daria.
 * O extrato OFX é lido pelo leitor REAL do STEP 02 (evidências reais); documentos e
 * achados vêm do gabarito. Se o juiz reprovar o oráculo, o gabarito está incoerente.
 */
export function oracleWorker(lc: LoadedCase): WorkerOutcome {
  const { def, sources } = lc;
  const exp = def.expect;
  if (exp.outcome.kind === "rejected") {
    return { kind: "rejected", code: exp.outcome.code, file: exp.outcome.file, message: "Extrato protegido por senha. Remova a senha e envie de novo." };
  }

  const stFile = def.input.statement;
  const stDocId = "doc-statement";

  // ---------------------------------------------------------------- movimentações
  type Tx = WorkResult["transactions"][number];
  let txs: Tx[];
  let closing: number | null = null;
  let opening: number | null = null;
  if (sources[stFile].kind === "ofx") {
    const p = parseStatement(lc.files[stFile]);
    if (!p.ok) throw new Error(`oráculo: extrato inválido em ${def.id}: ${p.error.message}`);
    closing = p.statement.closingBalanceCents;
    txs = p.statement.transactions.map((t) => ({
      id: `tx-${t.seq}`, fitid: t.fitid, date: t.date, description: t.description, amount_cents: t.amountCents,
      kind: "normal", status: "missing_receipt",
      evidence: [{ document_id: stDocId, file_name: stFile, page: 1, line: t.source.line, excerpt: t.source.excerpt, method: "structured", verified: true }],
    }));
  } else {
    const truth = sources[stFile].statementTruth!;
    const lines = sources[stFile].textLines!;
    opening = truth.openingCents;
    closing = truth.openingCents + truth.transactions.reduce((s, t) => s + t.cents, 0);
    txs = truth.transactions.filter((t) => t.present).map((t, i) => {
      const ln = lines.findIndex((l) => l.startsWith(t.date.split("-").reverse().join("/")) && l.includes(t.desc)) + 1;
      return {
        id: `tx-${i + 1}`, fitid: null, date: t.date, description: maskSensitive(t.desc), amount_cents: t.cents,
        kind: "normal" as const, status: "missing_receipt" as const,
        evidence: [{ document_id: stDocId, file_name: stFile, page: 1, line: ln, excerpt: maskSensitive(lines[ln - 1]), method: "text" as const, verified: true }],
      };
    });
  }
  const refHits = (t: Tx, ref: string) =>
    ref === "*" || (ref.startsWith("fitid:") ? t.fitid === ref.slice(6) : `tx:${t.date}|${t.amount_cents}` === ref);
  const txOf = (ref: string) => txs.find((t) => refHits(t, ref))!;

  // ---------------------------------------------------------------- documentos
  type Doc = WorkResult["documents"][number];
  const ignored = new Set(exp.ignoredFiles ?? []);
  const docs: Doc[] = [{
    id: stDocId, file_name: stFile, role: "statement", doc_type: "bank_statement", legibility: "ok",
    counterparty_name: null, amount_cents: null, date: null, status: "statement", evidence: [],
  }];
  def.input.documents.filter((f) => !ignored.has(f)).forEach((file, i) => {
    const truth = def.documentsTruth[file];
    const src = sources[file];
    const method = src.kind.startsWith("png") ? "vision" : "text";
    const lines = src.textLines ?? [];
    const amountLine = lines.findIndex((l) => /^Valor/.test(l)) + 1 || 1;
    const evidence: Evidence[] = truth.legibility === "illegible"
      ? []
      : [{ document_id: `doc-${i + 1}`, file_name: file, page: 1, line: method === "vision" ? null : amountLine, excerpt: maskSensitive(lines[amountLine - 1] ?? ""), method, verified: method !== "vision" }];
    docs.push({
      id: `doc-${i + 1}`, file_name: file, role: "supporting", doc_type: truth.docType, legibility: truth.legibility,
      counterparty_name: truth.counterparty, amount_cents: truth.amountCents, date: truth.date,
      status: truth.legibility === "illegible" ? "illegible" : "without_transaction", evidence,
    });
  });
  const docOf = (file: string | string[]) => docs.find((d) => d.file_name === asArray(file)[0])!;
  const docEv = (d: Doc): Evidence[] =>
    d.evidence.length ? d.evidence : [{ document_id: d.id, file_name: d.file_name, page: 1, line: null, excerpt: "(ilegível)", method: "vision", verified: false }];

  // ---------------------------------------------------------------- pares
  type Match = WorkResult["matches"][number];
  const matches: Match[] = [];
  for (const p of [...(exp.confirmedMatches ?? []), ...(exp.optionalConfirmations ?? [])]) {
    const t = txOf(p.tx);
    const d = docOf(p.doc);
    matches.push({ id: `m-${matches.length + 1}`, transaction_ids: [t.id], document_ids: [d.id], rule: "exact", status: "confirmed", score: 0.95, amount_diff_cents: 0 });
    t.status = "matched";
    d.status = "matched";
  }
  for (const pm of exp.requiredPendingMatches ?? []) {
    const ts = pm.tx.map(txOf);
    const ds = pm.docs.map((f) => docOf(f));
    const diff = Math.abs(ts.reduce((s, t) => s + t.amount_cents, 0)) - ds.reduce((s, d) => s + (d.amount_cents ?? 0), 0);
    matches.push({ id: `m-${matches.length + 1}`, transaction_ids: ts.map((t) => t.id), document_ids: ds.map((d) => d.id), rule: pm.rule, status: "needs_confirmation", score: 0.7, amount_diff_cents: diff });
    ts.forEach((t) => (t.status = "needs_confirmation"));
    ds.forEach((d) => (d.status = "needs_confirmation"));
  }

  // ---------------------------------------------------------------- achados
  type Finding = WorkResult["findings"][number];
  const findings: Finding[] = [];
  const addFinding = (p: FindingPattern) => {
    const t = p.tx ? txOf(asArray(p.tx)[0]) : undefined;
    const d = p.doc ? docOf(p.doc) : undefined;
    let evidence: Evidence[] = [...(t?.evidence ?? []), ...(d ? docEv(d) : [])];
    if (p.type === "balance_failure") {
      const lines = sources[stFile].textLines!;
      const truth = sources[stFile].statementTruth!;
      const missingIdx = truth.transactions.findIndex((x) => !x.present);
      const after = truth.transactions.slice(missingIdx + 1).find((x) => x.present)!;
      const ln = lines.findIndex((l) => l.includes(after.desc)) + 1;
      evidence = [{ document_id: stDocId, file_name: stFile, page: 1, line: ln, excerpt: lines[ln - 1], method: "text", verified: true }];
    }
    findings.push({
      id: `f-${findings.length + 1}`, type: p.type, severity: "medium", title: p.type, detail: p.why ?? "",
      transaction_id: t?.id ?? null, document_id: d?.id ?? null,
      expected_cents: p.expectedCents ?? null, found_cents: p.foundCents ?? null, diff_cents: p.diffCents ?? null, evidence,
    });
    if (t && p.type === "amount_divergence") t.status = "divergent";
    if (d && p.type === "amount_divergence") d.status = "needs_confirmation";
    if (d && p.type === "needs_confirmation") d.status = "needs_confirmation";
    if (t && p.type === "needs_confirmation") t.status = "needs_confirmation";
    if (d && p.type === "duplicate_document") d.status = "duplicate";
    if (d && p.type === "payment_duplication") d.status = "needs_confirmation";
    if (t && (p.type === "duplicate_transaction" || p.type === "grouped_payment" || p.type === "paid_with_fees")) t.status = "needs_confirmation";
  };
  for (const p of exp.requiredFindings ?? []) {
    // duplicate_document aponta para a cópia (o 2º arquivo da lista), não para o original confirmado
    if (p.type === "duplicate_document" && Array.isArray(p.doc)) addFinding({ ...p, doc: p.doc[p.doc.length - 1] });
    else addFinding(p);
  }

  // ---------------------------------------------------------------- status finais das movimentações
  for (const te of exp.transactions ?? []) {
    const t = txOf(te.ref);
    if (te.kind) t.kind = te.kind;
    if (te.status) t.status = te.status;
    else if (te.statusAnyOf && !te.statusAnyOf.includes(t.status)) t.status = te.statusAnyOf[0];
  }
  for (const t of txs) {
    if (t.status !== "missing_receipt") continue;
    if (t.kind !== "normal") t.status = "no_receipt_needed";
    else if (t.amount_cents > 0) t.status = "unmatched_credit";
    else if (!findings.some((f) => f.type === "missing_receipt" && f.transaction_id === t.id)) {
      addFinding({ type: "missing_receipt", tx: t.fitid ? `fitid:${t.fitid}` : `tx:${t.date}|${t.amount_cents}` });
    }
  }
  for (const t of txs) {
    if (t.status === "needs_confirmation" && !findings.some((f) => f.transaction_id === t.id) && !matches.some((m) => m.transaction_ids.includes(t.id))) {
      const allowed = (exp.allowedFindings ?? []).find((p) => p.type === "needs_confirmation" && asArray(p.tx).some((r) => refHits(t, r)));
      if (allowed) addFinding({ ...allowed, tx: asArray(allowed.tx).find((r) => refHits(t, r)) });
    }
  }

  // ---------------------------------------------------------------- resumo
  const supporting = docs.filter((d) => d.role === "supporting");
  const count = <T>(xs: T[], p: (x: T) => boolean) => xs.filter(p).length;
  const balanceStatus = exp.balanceCheck ?? "structural_only";
  const sumAll = txs.reduce((s, t) => s + t.amount_cents, 0);
  const result: WorkResult = {
    status: exp.status ?? "completed",
    review_reasons: exp.reviewReasonsInclude ?? [],
    period: { month: "2026-09", account_label: sources[stFile].kind === "ofx" ? "Banco 341 · ••3456" : null },
    summary: {
      transactions_total: txs.length,
      matched: count(txs, (t) => t.status === "matched"),
      needs_confirmation: count(txs, (t) => t.status === "needs_confirmation"),
      missing_receipt: count(txs, (t) => t.status === "missing_receipt"),
      amount_divergences: count(findings, (f) => f.type === "amount_divergence"),
      possible_duplicates: count(findings, (f) => f.type === "duplicate_transaction"),
      no_receipt_needed: count(txs, (t) => t.status === "no_receipt_needed"),
      documents_total: supporting.length,
      documents_without_transaction: count(supporting, (d) => d.status === "without_transaction"),
      illegible_documents: count(supporting, (d) => d.legibility === "illegible"),
      total_in_cents: txs.filter((t) => t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0),
      total_out_cents: txs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + t.amount_cents, 0),
      balance_check: {
        status: balanceStatus,
        opening_cents: opening,
        closing_cents: closing,
        computed_closing_cents: opening !== null ? opening + sumAll : null,
        diff_cents: opening !== null && closing !== null ? closing - (opening + sumAll) : null,
      },
    },
    transactions: txs,
    documents: docs,
    matches,
    findings,
    pending_actions: findings.map((f) => ({ finding_id: f.id, action: `Verificar: ${f.type}`, owner: "user" as const })),
    ignored_files: [...ignored].map((f) => ({ file_name: f, reason: "arquivo idêntico a outro já enviado" })),
    accountant_message: `Olá! Segue o fechamento de setembro: ${txs.length} movimentações, ${findings.length} pendência(s).`,
    disclaimer: DISCLAIMER,
  };
  return { kind: "result", result };
}
