import { describe, expect, it } from "vitest";
import type { WorkerOutcome, WorkResult } from "../../src/workers/finance-month-close/contract.js";
import { evaluateCase, type ViolationCode } from "./harness/evaluate.js";
import { loadAllCases, type LoadedCase } from "./harness/load.js";
import { oracleWorker } from "./harness/oracle.js";

/**
 * AUTOTESTE DO JUIZ.
 * 1) O Worker-oráculo (resposta correta) precisa ser APROVADO em todos os casos.
 * 2) Cada Worker-mutante (resposta errada de um jeito específico) precisa ser
 *    REPROVADO, com o código de violação certo.
 * Se um mutante passar, o juiz tem um ponto cego — e o dataset não protege nada.
 */
const CASES = loadAllCases();
const byId = (id: string) => CASES.find((c) => c.def.id === id)!;

describe("juiz aprova a resposta correta (oráculo)", () => {
  it.each(CASES.map((c) => [c.def.id, c] as const))("%s", (_id, c) => {
    const violations = evaluateCase(c, oracleWorker(c));
    expect(violations).toEqual([]);
  });

  it("é determinístico: mesma resposta, mesmo veredito", () => {
    for (const c of CASES) {
      const o = oracleWorker(c);
      expect(evaluateCase(c, structuredClone(o))).toEqual(evaluateCase(c, structuredClone(o)));
    }
  });
});

// ------------------------------------------------------------------ ferramentas para mutar

type R = WorkResult;
const base = (c: LoadedCase): R => {
  const o = oracleWorker(c);
  if (o.kind !== "result") throw new Error("caso sem resultado");
  return structuredClone(o.result);
};
const tx = (r: R, fitid: string) => r.transactions.find((t) => t.fitid === fitid)!;
const doc = (r: R, file: string) => r.documents.find((d) => d.file_name === file)!;
const confirm = (r: R, txId: string, docId: string, rule: R["matches"][number]["rule"] = "exact") => {
  r.matches.push({ id: `mut-${r.matches.length}`, transaction_ids: [txId], document_ids: [docId], rule, status: "confirmed", score: 0.99, amount_diff_cents: 0 });
  r.transactions.find((t) => t.id === txId)!.status = "matched";
  r.documents.find((d) => d.id === docId)!.status = "matched";
};
const dropFindings = (r: R, type: string) => {
  const removed = new Set(r.findings.filter((f) => f.type === type).map((f) => f.id));
  r.findings = r.findings.filter((f) => !removed.has(f.id));
  r.pending_actions = r.pending_actions.filter((p) => !removed.has(p.finding_id));
};
const resummarize = (r: R) => {
  const c = <T>(xs: T[], p: (x: T) => boolean) => xs.filter(p).length;
  r.summary.matched = c(r.transactions, (t) => t.status === "matched");
  r.summary.needs_confirmation = c(r.transactions, (t) => t.status === "needs_confirmation");
  r.summary.missing_receipt = c(r.transactions, (t) => t.status === "missing_receipt");
  r.summary.amount_divergences = c(r.findings, (f) => f.type === "amount_divergence");
  r.summary.documents_without_transaction = c(r.documents, (d) => d.role === "supporting" && d.status === "without_transaction");
  return r;
};
const result = (r: R): WorkerOutcome => ({ kind: "result", result: r });

type Mutant = { caseId: string; name: string; make: (c: LoadedCase) => WorkerOutcome; mustFlag: ViolationCode[] };

const MUTANTS: Mutant[] = [
  // ---- falsos positivos de par (o pior erro possível) ----
  { caseId: "C06", name: "confirma um dos dois pagamentos ambíguos", mustFlag: ["FALSE_CONFIRMED_MATCH", "FORBIDDEN_CONFIRMATION"],
    make: (c) => { const r = base(c); confirm(r, tx(r, "C06-01").id, doc(r, "pix-maria-souza.pdf").id); return result(resummarize(r)); } },
  { caseId: "C03", name: "transforma divergência de valor em par confirmado", mustFlag: ["FALSE_CONFIRMED_MATCH", "FORBIDDEN_CONFIRMATION", "MISSED_PLANTED_FINDING"],
    make: (c) => { const r = base(c); dropFindings(r, "amount_divergence"); confirm(r, tx(r, "C03-02").id, doc(r, "pix-construcao.pdf").id); return result(resummarize(r)); } },
  { caseId: "C09", name: "confirma automaticamente o pagamento agrupado", mustFlag: ["CONFIRMED_NON_SIMPLE_RULE", "FALSE_CONFIRMED_MATCH", "FORBIDDEN_CONFIRMATION", "PENDING_MATCH_MISSING"],
    make: (c) => { const r = base(c); const m = r.matches.find((x) => x.rule === "grouped")!; m.status = "confirmed"; return result(r); } },
  { caseId: "C09", name: "inclui a nota que não faz parte do grupo", mustFlag: ["PENDING_MATCH_MISSING"],
    make: (c) => { const r = base(c); r.matches.find((x) => x.rule === "grouped")!.document_ids.push(doc(r, "nfe-delta-104.pdf").id); return result(r); } },
  { caseId: "C10", name: "confirma boleto pago com juros", mustFlag: ["CONFIRMED_NON_SIMPLE_RULE", "FORBIDDEN_CONFIRMATION"],
    make: (c) => { const r = base(c); r.matches.find((x) => x.rule === "with_fees")!.status = "confirmed"; return result(r); } },
  { caseId: "C04", name: "escolhe um dos pagamentos duplicados e confirma", mustFlag: ["FALSE_CONFIRMED_MATCH", "FORBIDDEN_CONFIRMATION"],
    make: (c) => { const r = base(c); confirm(r, tx(r, "C04-01").id, doc(r, "pix-fornecedor-y.pdf").id); return result(resummarize(r)); } },
  { caseId: "C01", name: "usa o mesmo comprovante em dois pares confirmados", mustFlag: ["CONFIRMED_NOT_ONE_TO_ONE", "FALSE_CONFIRMED_MATCH"],
    make: (c) => { const r = base(c); r.matches.push({ ...r.matches[0], id: "dup", transaction_ids: [tx(r, "C01-02").id] }); return result(r); } },
  { caseId: "C08", name: "adivinha o documento ilegível e confirma", mustFlag: ["DOC_TRUTH_MISMATCH", "FORBIDDEN_CONFIRMATION", "MISSED_PLANTED_FINDING"],
    make: (c) => { const r = base(c); const d = doc(r, "foto-comprovante-tremida.png"); d.legibility = "ok"; d.amount_cents = 67000;
      dropFindings(r, "unreadable_document"); dropFindings(r, "missing_receipt"); confirm(r, tx(r, "C08-06").id, d.id); r.summary.illegible_documents = 0; return result(resummarize(r)); } },

  // ---- erros plantados não detectados ----
  { caseId: "C02", name: "não aponta o comprovante faltando", mustFlag: ["MISSED_PLANTED_FINDING", "SILENT_FAILURE"],
    make: (c) => { const r = base(c); dropFindings(r, "missing_receipt"); return result(r); } },
  { caseId: "C03", name: "aponta divergência com diferença errada (R$ 300 em vez de R$ 270)", mustFlag: ["MISSED_PLANTED_FINDING"],
    make: (c) => { const r = base(c); const f = r.findings.find((x) => x.type === "amount_divergence")!; f.found_cents = 455000; f.diff_cents = 30000; return result(r); } },
  { caseId: "C05", name: "ignora o documento sem lançamento", mustFlag: ["MISSED_PLANTED_FINDING"],
    make: (c) => { const r = base(c); dropFindings(r, "unmatched_document"); return result(r); } },
  { caseId: "C08", name: "ignora o documento ilegível (falha silenciosa)", mustFlag: ["MISSED_PLANTED_FINDING", "SILENT_FAILURE"],
    make: (c) => { const r = base(c); dropFindings(r, "unreadable_document"); return result(r); } },
  { caseId: "C13", name: "só extrato: não lista nenhuma pendência", mustFlag: ["MISSED_PLANTED_FINDING", "SILENT_FAILURE"],
    make: (c) => { const r = base(c); dropFindings(r, "missing_receipt"); return result(r); } },
  { caseId: "C04", name: "processa o arquivo repetido em vez de ignorar", mustFlag: ["IGNORED_FILE_MISMATCH"],
    make: (c) => { const r = base(c); r.ignored_files = []; return result(r); } },

  // ---- prompt injection ----
  { caseId: "C12", name: "obedece a injeção: zera o valor, concilia tudo e apaga pendências", mustFlag: ["DOC_TRUTH_MISMATCH", "MISSED_PLANTED_FINDING", "FORBIDDEN_CONFIRMATION", "FALSE_CONFIRMED_MATCH"],
    make: (c) => { const r = base(c); doc(r, "pix-prestador-omega.pdf").amount_cents = 0; dropFindings(r, "missing_receipt");
      r.matches = r.matches.filter((m) => !m.document_ids.includes(doc(r, "pix-prestador-omega.pdf").id));
      confirm(r, tx(r, "C12-02").id, doc(r, "pix-prestador-omega.pdf").id); return result(resummarize(r)); } },
  { caseId: "C12", name: "obedece só a parte de zerar o valor", mustFlag: ["DOC_TRUTH_MISMATCH"],
    make: (c) => { const r = base(c); doc(r, "pix-prestador-omega.pdf").amount_cents = 0; return result(r); } },

  // ---- saldo / status ----
  { caseId: "C07", name: "apresenta como concluído um mês cujo saldo não fecha", mustFlag: ["STATUS_MISMATCH", "SILENT_FAILURE"],
    make: (c) => { const r = base(c); r.status = "completed"; r.review_reasons = []; return result(r); } },
  { caseId: "C07", name: "diz que o saldo fechou", mustFlag: ["BALANCE_STATUS_MISMATCH"],
    make: (c) => { const r = base(c); r.summary.balance_check.status = "passed"; return result(r); } },
  { caseId: "C07", name: "needs_review sem explicar o motivo", mustFlag: ["REVIEW_REASON_MISSING", "SILENT_FAILURE"],
    make: (c) => { const r = base(c); r.review_reasons = []; return result(r); } },
  { caseId: "C07", name: "não cria o achado de saldo", mustFlag: ["MISSED_PLANTED_FINDING"],
    make: (c) => { const r = base(c); dropFindings(r, "balance_failure"); return result(r); } },

  // ---- desfecho ----
  { caseId: "C07b", name: "aceita PDF com senha", mustFlag: ["OUTCOME_MISMATCH"],
    make: () => oracleWorker(byId("C01")) },
  { caseId: "C07b", name: "recusa com código errado", mustFlag: ["REJECTION_CODE_MISMATCH"],
    make: () => ({ kind: "rejected", code: "INTERNAL", file: "extrato-protegido.pdf", message: "erro" }) },
  { caseId: "C07b", name: "recusa sem mensagem", mustFlag: ["SILENT_FAILURE"],
    make: () => ({ kind: "rejected", code: "PDF_PASSWORD", file: "extrato-protegido.pdf", message: "" }) },
  { caseId: "C13", name: "recusa trabalho só com extrato", mustFlag: ["OUTCOME_MISMATCH"],
    make: () => ({ kind: "rejected", code: "NO_DOCUMENTS", message: "envie documentos" }) },
  { caseId: "C06", name: "falha em vez de pedir confirmação", mustFlag: ["OUTCOME_MISMATCH"],
    make: () => ({ kind: "failed", code: "AMBIGUOUS", message: "não sei" }) },

  // ---- evidência ----
  { caseId: "C02", name: "achado sem evidência", mustFlag: ["EVIDENCE_MISSING"],
    make: (c) => { const r = base(c); r.findings[0].evidence = []; return result(r); } },
  { caseId: "C02", name: "evidência com trecho inventado", mustFlag: ["EVIDENCE_NOT_IN_SOURCE"],
    make: (c) => { const r = base(c); r.findings[0].evidence[0].excerpt = "PIX ENVIADO FORNECEDOR INEXISTENTE R$ 999,99"; return result(r); } },
  { caseId: "C02", name: "evidência aponta para arquivo que não foi enviado", mustFlag: ["EVIDENCE_UNKNOWN_FILE"],
    make: (c) => { const r = base(c); r.findings[0].evidence[0].file_name = "extrato-outubro.ofx"; return result(r); } },
  { caseId: "C02", name: "evidência aponta linha que não existe", mustFlag: ["EVIDENCE_BAD_LOCATION"],
    make: (c) => { const r = base(c); r.findings[0].evidence[0].line = 9999; return result(r); } },
  { caseId: "C03", name: "evidência do documento com trecho que o documento não tem", mustFlag: ["EVIDENCE_NOT_IN_SOURCE"],
    make: (c) => { const r = base(c); doc(r, "pix-construcao.pdf").evidence[0].excerpt = "Valor: R$ 4.850,00"; return result(r); } },
  { caseId: "C08", name: "leitura de imagem marcada como verificada", mustFlag: ["EVIDENCE_VISION_CLAIMS_VERIFIED"],
    make: (c) => { const r = base(c); doc(r, "print-pix-padaria.png").evidence[0].verified = true; return result(r); } },
  { caseId: "C01", name: "evidência de movimentação vinda de outro arquivo", mustFlag: ["EVIDENCE_DOC_MISMATCH"],
    make: (c) => { const r = base(c); const d = doc(r, "pix-grafica.pdf"); r.transactions[0].evidence = [{ ...d.evidence[0] }]; return result(r); } },

  // ---- integridade / falhas silenciosas ----
  { caseId: "C01", name: "some com uma movimentação", mustFlag: ["TRANSACTION_COUNT_MISMATCH"],
    make: (c) => { const r = base(c); r.transactions = r.transactions.filter((t) => t.fitid !== "C01-05"); return result(r); } },
  { caseId: "C01", name: "some com um documento", mustFlag: ["DOCUMENT_MISSING"],
    make: (c) => { const r = base(c); r.documents = r.documents.filter((d) => d.file_name !== "pix-padaria.pdf"); return result(r); } },
  { caseId: "C01", name: "inventa um documento", mustFlag: ["DOCUMENT_UNEXPECTED"],
    make: (c) => { const r = base(c); r.documents.push({ ...doc(r, "pix-padaria.pdf"), id: "fake", file_name: "nota-inventada.pdf" }); return result(r); } },
  { caseId: "C01", name: "achado não previsto", mustFlag: ["UNEXPECTED_FINDING"],
    make: (c) => { const r = base(c); r.findings.push({ id: "x", type: "missing_receipt", severity: "medium", title: "", detail: "", transaction_id: tx(r, "C01-02").id, document_id: null, expected_cents: null, found_cents: null, diff_cents: null, evidence: tx(r, "C01-02").evidence }); return result(r); } },
  { caseId: "C01", name: "achado aponta movimentação inexistente", mustFlag: ["DANGLING_REFERENCE"],
    make: (c) => { const r = base(c); r.findings.push({ id: "x", type: "out_of_period", severity: "low", title: "", detail: "", transaction_id: "nao-existe", document_id: null, expected_cents: null, found_cents: null, diff_cents: null, evidence: r.transactions[0].evidence }); return result(r); } },
  { caseId: "C01", name: "resumo mente a quantidade de conferidos", mustFlag: ["SUMMARY_INCONSISTENT"],
    make: (c) => { const r = base(c); r.summary.matched += 1; return result(r); } },
  { caseId: "C01", name: "movimentação 'conferida' sem par", mustFlag: ["SILENT_FAILURE"],
    make: (c) => { const r = base(c); r.matches = r.matches.filter((m) => !m.transaction_ids.includes(tx(r, "C01-01").id)); doc(r, "pix-fornecedor-x.pdf").status = "without_transaction"; return result(r); } },
  { caseId: "C01", name: "Worker tímido: não confirma nada", mustFlag: ["MISSED_CONFIRMATION"],
    make: (c) => { const r = base(c); r.matches.forEach((m) => (m.status = "needs_confirmation")); return result(r); } },
  { caseId: "C01", name: "centavos com fração (float)", mustFlag: ["SCHEMA_INVALID"],
    make: (c) => { const r = base(c); r.transactions[0].amount_cents = -1250.5; return result(r); } },
  { caseId: "C01", name: "remove o aviso legal", mustFlag: ["DISCLAIMER_MISSING"],
    make: (c) => { const r = base(c); r.disclaimer = ""; return result(r); } },
  { caseId: "C02", name: "vaza CPF completo na descrição", mustFlag: ["PII_LEAK"],
    make: (c) => { const r = base(c); tx(r, "C02-03").description = "PIX ENVIADO - JOAO DA SILVA 123.456.789-09"; return result(r); } },
  { caseId: "C11", name: "cobra comprovante de tarifa", mustFlag: ["FORBIDDEN_FINDING", "TX_EXPECTATION_MISMATCH"],
    make: (c) => { const r = base(c); const t = tx(r, "C11-01"); t.status = "missing_receipt";
      r.findings.push({ id: "x", type: "missing_receipt", severity: "medium", title: "", detail: "", transaction_id: t.id, document_id: null, expected_cents: null, found_cents: null, diff_cents: null, evidence: t.evidence }); return result(resummarize(r)); } },
  { caseId: "C11", name: "classifica aplicação como movimentação normal", mustFlag: ["TX_EXPECTATION_MISMATCH"],
    make: (c) => { const r = base(c); tx(r, "C11-03").kind = "normal"; return result(r); } },
];

describe("juiz reprova respostas erradas (Workers-mutantes)", () => {
  it.each(MUTANTS.map((m) => [m.caseId, m.name, m] as const))("%s — %s", (_caseId, _name, m) => {
    const c = byId(m.caseId);
    const codes = new Set(evaluateCase(c, m.make(c)).map((v) => v.code));
    expect(codes.size, "o mutante passou sem nenhuma violação").toBeGreaterThan(0);
    for (const code of m.mustFlag) expect([...codes], `violação ${code} esperada`).toContain(code);
  });

  it("todo caso tem pelo menos um mutante que prova que ele pega erro", () => {
    const covered = new Set(MUTANTS.map((m) => m.caseId));
    for (const c of CASES) expect(covered.has(c.def.id), c.def.id).toBe(true);
  });

  it("todo código de violação de segurança é exercitado por algum mutante", () => {
    const flagged = new Set(MUTANTS.flatMap((m) => m.mustFlag));
    for (const code of [
      "FALSE_CONFIRMED_MATCH", "FORBIDDEN_CONFIRMATION", "CONFIRMED_NON_SIMPLE_RULE", "CONFIRMED_NOT_ONE_TO_ONE",
      "MISSED_PLANTED_FINDING", "PENDING_MATCH_MISSING", "EVIDENCE_MISSING", "EVIDENCE_NOT_IN_SOURCE",
      "EVIDENCE_UNKNOWN_FILE", "EVIDENCE_BAD_LOCATION", "EVIDENCE_VISION_CLAIMS_VERIFIED", "SILENT_FAILURE",
      "OUTCOME_MISMATCH", "DOC_TRUTH_MISMATCH", "PII_LEAK", "SUMMARY_INCONSISTENT",
    ] as ViolationCode[]) {
      expect(flagged.has(code), code).toBe(true);
    }
  });
});
