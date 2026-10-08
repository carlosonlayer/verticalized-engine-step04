import { maskSensitive } from "../../../src/lib/mask.js";
import {
  AUTO_CONFIRMABLE_RULES,
  DISCLAIMER,
  WorkResultSchema,
  type Evidence,
  type WorkerOutcome,
  type WorkResult,
} from "../../../src/workers/finance-month-close/contract.js";
import { decodeBankFile } from "../../../src/workers/finance-month-close/parsers/encoding.js";
import { asArray, type FindingPattern } from "./case-schema.js";
import type { LoadedCase } from "./load.js";

/**
 * JUIZ do dataset de regressão.
 *
 * Recebe um caso (entrada + gabarito) e o desfecho produzido por QUALQUER implementação
 * do Worker, e devolve a lista de violações. Lista vazia = caso aprovado.
 *
 * Cada violação tem um código estável — os testes de autoverificação do juiz
 * (harness.test.ts) usam esses códigos para provar que cada tipo de erro é pego.
 */
export type ViolationCode =
  | "OUTCOME_MISMATCH"
  | "REJECTION_CODE_MISMATCH"
  | "SCHEMA_INVALID"
  | "STATUS_MISMATCH"
  | "REVIEW_REASON_MISSING"
  | "BALANCE_STATUS_MISMATCH"
  | "TRANSACTION_COUNT_MISMATCH"
  | "UNRESOLVED_REFERENCE"
  | "TX_EXPECTATION_MISMATCH"
  | "DOCUMENT_MISSING"
  | "DOCUMENT_UNEXPECTED"
  | "IGNORED_FILE_MISMATCH"
  | "DOC_TRUTH_MISMATCH"
  | "FALSE_CONFIRMED_MATCH"
  | "CONFIRMED_NON_SIMPLE_RULE"
  | "CONFIRMED_NOT_ONE_TO_ONE"
  | "FORBIDDEN_CONFIRMATION"
  | "MISSED_CONFIRMATION"
  | "PENDING_MATCH_MISSING"
  | "MISSED_PLANTED_FINDING"
  | "UNEXPECTED_FINDING"
  | "FORBIDDEN_FINDING"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_UNKNOWN_FILE"
  | "EVIDENCE_DOC_MISMATCH"
  | "EVIDENCE_BAD_LOCATION"
  | "EVIDENCE_METHOD_INVALID"
  | "EVIDENCE_NOT_IN_SOURCE"
  | "EVIDENCE_VISION_CLAIMS_VERIFIED"
  | "DANGLING_REFERENCE"
  | "SUMMARY_INCONSISTENT"
  | "SILENT_FAILURE"
  | "PII_LEAK"
  | "DISCLAIMER_MISSING";

export type Violation = { code: ViolationCode; message: string };

const CPF_RE = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

export function evaluateCase(lc: LoadedCase, outcome: WorkerOutcome): Violation[] {
  const v: Violation[] = [];
  const add = (code: ViolationCode, message: string) => v.push({ code, message });
  const exp = lc.def.expect;

  // ------------------------------------------------------------------ desfecho
  if (exp.outcome.kind === "rejected") {
    if (outcome.kind !== "rejected") {
      add("OUTCOME_MISMATCH", `esperava recusa (${exp.outcome.code}), veio "${outcome.kind}"`);
    } else {
      if (outcome.code !== exp.outcome.code) add("REJECTION_CODE_MISMATCH", `código ${outcome.code} ≠ ${exp.outcome.code}`);
      if (outcome.file !== exp.outcome.file) add("REJECTION_CODE_MISMATCH", `arquivo ${outcome.file} ≠ ${exp.outcome.file}`);
      if (!outcome.message?.trim()) add("SILENT_FAILURE", "recusa sem mensagem para o usuário");
    }
    return v;
  }
  if (outcome.kind !== "result") {
    add("OUTCOME_MISMATCH", `esperava resultado, veio "${outcome.kind}" (${outcome.code})`);
    return v;
  }

  const parsed = WorkResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 5)) add("SCHEMA_INVALID", `${i.path.join(".")}: ${i.message}`);
    return v;
  }
  const r: WorkResult = parsed.data;

  // ------------------------------------------------------------------ índices
  const txById = new Map(r.transactions.map((t) => [t.id, t]));
  const docById = new Map(r.documents.map((d) => [d.id, d]));
  const docByFile = new Map(r.documents.map((d) => [d.file_name, d]));
  const fileOfDoc = (id: string | null) => (id ? docById.get(id)?.file_name : undefined);

  const txMatchesRef = (txId: string | null | undefined, ref: string): boolean => {
    if (ref === "*") return true;
    const t = txId ? txById.get(txId) : undefined;
    if (!t) return false;
    if (ref.startsWith("fitid:")) return t.fitid === ref.slice(6);
    const [d, c] = ref.slice(3).split("|");
    return t.date === d && t.amount_cents === Number(c);
  };
  const docMatches = (docId: string | null | undefined, files: string[]): boolean =>
    files.includes("*") ? !!docId && docById.has(docId) : files.includes(fileOfDoc(docId ?? null) ?? "\u0000");
  const resolveTx = (ref: string) => r.transactions.filter((t) => txMatchesRef(t.id, ref));

  // ------------------------------------------------------------------ status / saldo
  if (exp.status && r.status !== exp.status) add("STATUS_MISMATCH", `status ${r.status} ≠ ${exp.status}`);
  for (const reason of exp.reviewReasonsInclude ?? []) {
    if (!r.review_reasons.includes(reason)) add("REVIEW_REASON_MISSING", `review_reasons sem "${reason}"`);
  }
  if (exp.balanceCheck && r.summary.balance_check.status !== exp.balanceCheck) {
    add("BALANCE_STATUS_MISMATCH", `balance ${r.summary.balance_check.status} ≠ ${exp.balanceCheck}`);
  }
  if (r.disclaimer !== DISCLAIMER) add("DISCLAIMER_MISSING", "disclaimer ausente ou alterado");

  // ------------------------------------------------------------------ movimentações
  if (exp.transactionCount !== undefined && r.transactions.length !== exp.transactionCount) {
    add("TRANSACTION_COUNT_MISMATCH", `${r.transactions.length} movimentações ≠ ${exp.transactionCount}`);
  }
  const allTxRefs = new Set<string>([
    ...(exp.transactions ?? []).map((t) => t.ref),
    ...(exp.confirmedMatches ?? []).map((m) => m.tx),
    ...(exp.requiredPendingMatches ?? []).flatMap((m) => m.tx),
    ...(exp.requiredFindings ?? []).flatMap((f) => asArray(f.tx)),
  ]);
  for (const ref of allTxRefs) {
    if (ref === "*") continue;
    const n = resolveTx(ref).length;
    if (n === 0) add("UNRESOLVED_REFERENCE", `movimentação ${ref} não aparece no resultado`);
    if (n > 1) add("UNRESOLVED_REFERENCE", `referência ${ref} ambígua no resultado (${n})`);
  }
  for (const te of exp.transactions ?? []) {
    const [t] = resolveTx(te.ref);
    if (!t) continue;
    if (te.kind && t.kind !== te.kind) add("TX_EXPECTATION_MISMATCH", `${te.ref}: kind ${t.kind} ≠ ${te.kind}`);
    if (te.status && t.status !== te.status) add("TX_EXPECTATION_MISMATCH", `${te.ref}: status ${t.status} ≠ ${te.status}`);
    if (te.statusAnyOf && !te.statusAnyOf.includes(t.status)) {
      add("TX_EXPECTATION_MISMATCH", `${te.ref}: status ${t.status} ∉ ${te.statusAnyOf.join("|")}`);
    }
  }

  // ------------------------------------------------------------------ documentos
  const ignoredExpected = new Set(exp.ignoredFiles ?? []);
  const ignoredActual = new Set(r.ignored_files.map((f) => f.file_name));
  for (const f of ignoredExpected) if (!ignoredActual.has(f)) add("IGNORED_FILE_MISMATCH", `${f} deveria ser ignorado (arquivo repetido)`);
  for (const f of ignoredActual) if (!ignoredExpected.has(f)) add("IGNORED_FILE_MISMATCH", `${f} foi ignorado sem motivo esperado`);

  const inputFiles = new Set([lc.def.input.statement, ...lc.def.input.documents]);
  for (const f of lc.def.input.documents) {
    if (ignoredActual.has(f)) continue;
    if (!docByFile.has(f)) add("DOCUMENT_MISSING", `documento ${f} sumiu do resultado (nem processado nem ignorado)`);
  }
  if (!docByFile.has(lc.def.input.statement)) add("DOCUMENT_MISSING", "o extrato não aparece em documents");
  for (const d of r.documents) if (!inputFiles.has(d.file_name)) add("DOCUMENT_UNEXPECTED", `documento inventado: ${d.file_name}`);

  for (const [file, truth] of Object.entries(lc.def.documentsTruth)) {
    const d = docByFile.get(file);
    if (!d || ignoredActual.has(file)) continue;
    if (d.amount_cents !== truth.amountCents) add("DOC_TRUTH_MISMATCH", `${file}: valor ${d.amount_cents} ≠ ${truth.amountCents}`);
    if (truth.legibility === "illegible" && d.legibility !== "illegible" && d.legibility !== "unprocessed") {
      add("DOC_TRUTH_MISMATCH", `${file}: documento ilegível marcado como "${d.legibility}"`);
    }
    if (truth.date && d.date !== null && d.date !== truth.date) add("DOC_TRUTH_MISMATCH", `${file}: data ${d.date} ≠ ${truth.date}`);
  }
  for (const de of exp.documents ?? []) {
    const d = docByFile.get(de.file);
    if (!d) continue;
    if (de.amountCents !== undefined && d.amount_cents !== de.amountCents) add("DOC_TRUTH_MISMATCH", `${de.file}: valor ${d.amount_cents} ≠ ${de.amountCents}`);
    if (de.legibility && d.legibility !== de.legibility) add("DOC_TRUTH_MISMATCH", `${de.file}: legibilidade ${d.legibility} ≠ ${de.legibility}`);
    if (de.status && d.status !== de.status) add("DOC_TRUTH_MISMATCH", `${de.file}: status ${d.status} ≠ ${de.status}`);
  }

  // ------------------------------------------------------------------ pares (matches)
  const confirmed = r.matches.filter((m) => m.status === "confirmed");
  const pairOk = (m: (typeof r.matches)[number], p: { tx: string; doc: string | string[] }) =>
    m.transaction_ids.length === 1 && m.document_ids.length === 1 &&
    txMatchesRef(m.transaction_ids[0], p.tx) && docMatches(m.document_ids[0], asArray(p.doc));

  const allowedConfirmed = [...(exp.confirmedMatches ?? []), ...(exp.optionalConfirmations ?? [])];
  for (const m of confirmed) {
    if (!(AUTO_CONFIRMABLE_RULES as readonly string[]).includes(m.rule)) {
      add("CONFIRMED_NON_SIMPLE_RULE", `par ${m.id} com regra "${m.rule}" foi confirmado automaticamente`);
    }
    if (!allowedConfirmed.some((p) => pairOk(m, p))) {
      add("FALSE_CONFIRMED_MATCH", `par confirmado sem respaldo no gabarito: tx=${m.transaction_ids.join(",")} doc=${m.document_ids.map((d) => fileOfDoc(d)).join(",")}`);
    }
  }
  for (const fc of exp.forbiddenConfirmations ?? []) {
    for (const m of confirmed) {
      if (m.transaction_ids.some((t) => txMatchesRef(t, fc.tx)) && m.document_ids.some((d) => docMatches(d, [fc.doc]))) {
        add("FORBIDDEN_CONFIRMATION", `confirmação proibida: ${fc.tx} × ${fc.doc}`);
      }
    }
  }
  for (const p of exp.confirmedMatches ?? []) {
    if (!confirmed.some((m) => pairOk(m, p))) add("MISSED_CONFIRMATION", `par esperado não confirmado: ${p.tx} × ${asArray(p.doc).join("|")}`);
  }
  for (const pm of exp.requiredPendingMatches ?? []) {
    const ok = r.matches.some(
      (m) =>
        m.status === "needs_confirmation" && m.rule === pm.rule &&
        m.transaction_ids.length === pm.tx.length && pm.tx.every((ref) => m.transaction_ids.some((t) => txMatchesRef(t, ref))) &&
        m.document_ids.length === pm.docs.length && pm.docs.every((f) => m.document_ids.some((d) => fileOfDoc(d) === f)),
    );
    if (!ok) add("PENDING_MATCH_MISSING", `par "${pm.rule}" a confirmar não proposto: ${pm.tx.join(",")} × ${pm.docs.join(",")}`);
  }
  // confirmação 1:1
  const seenTx = new Set<string>();
  const seenDoc = new Set<string>();
  for (const m of confirmed) {
    for (const t of m.transaction_ids) {
      if (seenTx.has(t)) add("CONFIRMED_NOT_ONE_TO_ONE", `movimentação ${t} em mais de um par confirmado`);
      seenTx.add(t);
    }
    for (const d of m.document_ids) {
      if (seenDoc.has(d)) add("CONFIRMED_NOT_ONE_TO_ONE", `documento ${fileOfDoc(d)} em mais de um par confirmado`);
      seenDoc.add(d);
    }
  }

  // ------------------------------------------------------------------ achados (findings)
  const fMatches = (f: (typeof r.findings)[number], p: FindingPattern) =>
    f.type === p.type &&
    (p.tx === undefined || asArray(p.tx).some((ref) => txMatchesRef(f.transaction_id, ref))) &&
    (p.doc === undefined || docMatches(f.document_id, asArray(p.doc))) &&
    (p.expectedCents === undefined || f.expected_cents === p.expectedCents) &&
    (p.foundCents === undefined || f.found_cents === p.foundCents) &&
    (p.diffCents === undefined || f.diff_cents === p.diffCents);

  const used = new Set<string>();
  for (const p of exp.requiredFindings ?? []) {
    const hit = r.findings.find((f) => !used.has(f.id) && fMatches(f, p));
    if (hit) used.add(hit.id);
    else add("MISSED_PLANTED_FINDING", `achado obrigatório não encontrado: ${p.type} ${JSON.stringify({ tx: p.tx, doc: p.doc, expectedCents: p.expectedCents, foundCents: p.foundCents, diffCents: p.diffCents })}`);
  }
  for (const f of r.findings) {
    if (used.has(f.id)) continue;
    if (!(exp.allowedFindings ?? []).some((p) => fMatches(f, p))) {
      add("UNEXPECTED_FINDING", `achado não previsto: ${f.type} tx=${f.transaction_id} doc=${fileOfDoc(f.document_id)}`);
    }
  }
  for (const p of exp.forbiddenFindings ?? []) {
    for (const f of r.findings) if (fMatches(f, p)) add("FORBIDDEN_FINDING", `achado proibido: ${p.type} ${JSON.stringify({ tx: p.tx, doc: p.doc })}`);
  }

  // ------------------------------------------------------------------ evidências
  const checkEvidence = (owner: string, list: Evidence[], required: boolean, onlyFile?: string) => {
    if (required && list.length === 0) add("EVIDENCE_MISSING", `${owner} sem evidência`);
    for (const e of list) {
      if (!inputFiles.has(e.file_name)) {
        add("EVIDENCE_UNKNOWN_FILE", `${owner}: evidência aponta para arquivo que não foi enviado (${e.file_name})`);
        continue;
      }
      if (onlyFile && e.file_name !== onlyFile) add("EVIDENCE_DOC_MISMATCH", `${owner}: evidência deveria vir de ${onlyFile}`);
      const doc = docById.get(e.document_id);
      if (!doc || doc.file_name !== e.file_name) add("EVIDENCE_DOC_MISMATCH", `${owner}: document_id não corresponde a ${e.file_name}`);
      const src = lc.sources[e.file_name];
      const expectedMethod = src.kind === "ofx" ? "structured" : src.kind === "pdf_text" ? "text" : src.kind.startsWith("png") ? "vision" : null;
      if (expectedMethod && e.method !== expectedMethod) add("EVIDENCE_METHOD_INVALID", `${owner}: método ${e.method} para ${src.kind} (esperado ${expectedMethod})`);
      if (e.method === "vision" && e.verified) add("EVIDENCE_VISION_CLAIMS_VERIFIED", `${owner}: leitura por imagem marcada como verificada`);
      if (e.page !== 1) add("EVIDENCE_BAD_LOCATION", `${owner}: página ${e.page} não existe em ${e.file_name}`);
      const sourceText = sourceTextOf(lc, e.file_name);
      if (sourceText && e.method !== "vision") {
        const lineCount = sourceText.split(/\r\n|\n|\r/).length;
        if (e.line !== null && (e.line < 1 || e.line > lineCount)) add("EVIDENCE_BAD_LOCATION", `${owner}: linha ${e.line} fora de ${e.file_name}`);
        if (!normalize(sourceText).includes(normalize(e.excerpt.replace(/…$/, "")))) {
          add("EVIDENCE_NOT_IN_SOURCE", `${owner}: trecho não existe em ${e.file_name}: "${e.excerpt.slice(0, 60)}"`);
        }
      }
    }
  };
  for (const t of r.transactions) checkEvidence(`movimentação ${t.id}`, t.evidence, true, lc.def.input.statement);
  for (const d of r.documents) {
    const needs = d.role === "supporting" && (d.legibility === "ok" || d.legibility === "partial");
    checkEvidence(`documento ${d.file_name}`, d.evidence, needs, d.file_name);
  }
  for (const f of r.findings) checkEvidence(`achado ${f.type}/${f.id}`, f.evidence, true);

  // ------------------------------------------------------------------ referências soltas
  for (const f of r.findings) {
    if (f.transaction_id && !txById.has(f.transaction_id)) add("DANGLING_REFERENCE", `achado ${f.id} → movimentação inexistente`);
    if (f.document_id && !docById.has(f.document_id)) add("DANGLING_REFERENCE", `achado ${f.id} → documento inexistente`);
  }
  for (const m of r.matches) {
    for (const t of m.transaction_ids) if (!txById.has(t)) add("DANGLING_REFERENCE", `par ${m.id} → movimentação inexistente`);
    for (const d of m.document_ids) if (!docById.has(d)) add("DANGLING_REFERENCE", `par ${m.id} → documento inexistente`);
  }
  const findingIds = new Set(r.findings.map((f) => f.id));
  for (const pa of r.pending_actions) if (!findingIds.has(pa.finding_id)) add("DANGLING_REFERENCE", `pendência → achado inexistente ${pa.finding_id}`);

  // ------------------------------------------------------------------ resumo coerente com as linhas
  const s = r.summary;
  const count = <T>(xs: T[], p: (x: T) => boolean) => xs.filter(p).length;
  const supporting = r.documents.filter((d) => d.role === "supporting");
  const checks: [string, number, number][] = [
    ["transactions_total", s.transactions_total, r.transactions.length],
    ["matched", s.matched, count(r.transactions, (t) => t.status === "matched")],
    ["needs_confirmation", s.needs_confirmation, count(r.transactions, (t) => t.status === "needs_confirmation")],
    ["missing_receipt", s.missing_receipt, count(r.transactions, (t) => t.status === "missing_receipt")],
    ["no_receipt_needed", s.no_receipt_needed, count(r.transactions, (t) => t.status === "no_receipt_needed")],
    ["amount_divergences", s.amount_divergences, count(r.findings, (f) => f.type === "amount_divergence")],
    ["possible_duplicates", s.possible_duplicates, count(r.findings, (f) => f.type === "duplicate_transaction")],
    ["documents_total", s.documents_total, supporting.length],
    ["documents_without_transaction", s.documents_without_transaction, count(supporting, (d) => d.status === "without_transaction")],
    ["illegible_documents", s.illegible_documents, count(supporting, (d) => d.legibility === "illegible")],
    ["total_in_cents", s.total_in_cents, r.transactions.filter((t) => t.amount_cents > 0).reduce((a, t) => a + t.amount_cents, 0)],
    ["total_out_cents", s.total_out_cents, r.transactions.filter((t) => t.amount_cents < 0).reduce((a, t) => a + t.amount_cents, 0)],
  ];
  for (const [name, got, want] of checks) if (got !== want) add("SUMMARY_INCONSISTENT", `summary.${name}=${got}, mas as linhas dão ${want}`);

  // ------------------------------------------------------------------ falhas silenciosas
  if (r.status === "completed" && !["passed", "structural_only"].includes(s.balance_check.status)) {
    add("SILENT_FAILURE", `concluído normalmente com saldo "${s.balance_check.status}"`);
  }
  if (r.status === "completed" && r.review_reasons.length > 0) add("SILENT_FAILURE", "concluído com motivos de revisão pendentes");
  if (r.status === "needs_review" && r.review_reasons.length === 0) add("SILENT_FAILURE", "needs_review sem motivo");
  for (const d of supporting) {
    if ((d.legibility === "illegible" || d.legibility === "unprocessed") &&
        !r.findings.some((f) => f.document_id === d.id && (f.type === "unreadable_document" || f.type === "unverified_extraction"))) {
      add("SILENT_FAILURE", `documento ${d.file_name} ${d.legibility} sem pendência`);
    }
  }
  for (const t of r.transactions) {
    const inConfirmed = confirmed.some((m) => m.transaction_ids.includes(t.id));
    if (t.status === "matched" && !inConfirmed) add("SILENT_FAILURE", `movimentação ${t.id} "matched" sem par confirmado`);
    if (inConfirmed && t.status !== "matched") add("SILENT_FAILURE", `movimentação ${t.id} em par confirmado mas status "${t.status}"`);
    if (t.status === "missing_receipt" && !r.findings.some((f) => f.type === "missing_receipt" && f.transaction_id === t.id)) {
      add("SILENT_FAILURE", `movimentação ${t.id} sem comprovante e sem pendência`);
    }
    if (t.status === "divergent" && !r.findings.some((f) => f.type === "amount_divergence" && f.transaction_id === t.id)) {
      add("SILENT_FAILURE", `movimentação ${t.id} divergente sem achado`);
    }
    if (t.kind === "normal" && t.amount_cents < 0 && t.status === "unmatched_credit") add("SILENT_FAILURE", `saída ${t.id} marcada como entrada`);
    if (t.kind === "normal" && t.amount_cents > 0 && t.status === "missing_receipt") add("SILENT_FAILURE", `entrada ${t.id} cobrando comprovante`);
  }
  for (const d of supporting) {
    const inConfirmed = confirmed.some((m) => m.document_ids.includes(d.id));
    if (d.status === "matched" && !inConfirmed) add("SILENT_FAILURE", `documento ${d.file_name} "matched" sem par confirmado`);
    if (inConfirmed && d.status !== "matched") add("SILENT_FAILURE", `documento ${d.file_name} em par confirmado mas status "${d.status}"`);
  }

  // ------------------------------------------------------------------ dado pessoal
  if (CPF_RE.test(JSON.stringify(r))) add("PII_LEAK", "CPF completo no resultado");

  return v;
}

// ---------------------------------------------------------------------- helpers

export function normalize(s: string): string {
  return maskSensitive(s).replace(/\s+/g, " ").trim().toUpperCase();
}

/** Texto de referência de um arquivo de entrada (para conferir trechos de evidência). */
export function sourceTextOf(lc: LoadedCase, file: string): string | null {
  const src = lc.sources[file];
  if (!src) return null;
  if (src.kind === "ofx") return decodeBankFile(lc.files[file]).text;
  if (src.kind === "pdf_text" && src.textLines) return src.textLines.join("\n");
  return null;
}
