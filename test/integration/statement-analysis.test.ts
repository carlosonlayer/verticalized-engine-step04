import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IsoDate } from "../../src/workers/finance-month-close/parsers/date.js";
import { parseStatement } from "../../src/workers/finance-month-close/parsers/statement.js";
import type { ParsedStatement } from "../../src/workers/finance-month-close/parsers/types.js";
import { analyzeStatement } from "../../src/workers/finance-month-close/statement/analyze.js";
import { categoryToKind } from "../../src/workers/finance-month-close/statement/classify.js";
import { asArray } from "../regression/harness/case-schema.js";
import { loadAllCases } from "../regression/harness/load.js";

/**
 * INTEGRAÇÃO STEP 02 → STEP 04 → gabarito do STEP 03.
 * Lê os extratos REAIS do dataset com o leitor do STEP 02, roda saldo e classificação,
 * e confere contra o gabarito — SEM alterar o gabarito.
 */
const FIX = join(import.meta.dirname, "..", "fixtures", "statements");
const CASES = loadAllCases();
const ofxCases = CASES.filter((c) => c.sources[c.def.input.statement].kind === "ofx");

function parse(buf: Buffer): ParsedStatement {
  const p = parseStatement(buf);
  if (!p.ok) throw new Error(`${p.error.code}: ${p.error.message}`);
  return p.statement;
}

describe("dataset OFX: saldo = o que o gabarito espera", () => {
  it.each(ofxCases.map((c) => [c.def.id, c] as const))("%s → %s", (_id, c) => {
    const a = analyzeStatement(parse(c.files[c.def.input.statement]));
    expect(a.balance.status).toBe(c.def.expect.balanceCheck);
    expect(a.transactions).toHaveLength(c.def.expect.transactionCount!);
  });
});

describe("dataset OFX: classificação coerente com o gabarito", () => {
  it.each(ofxCases.map((c) => [c.def.id, c] as const))("%s", (_id, c) => {
    const a = analyzeStatement(parse(c.files[c.def.input.statement]));
    const byFitid = new Map(a.transactions.map((t) => [`fitid:${t.fitid}`, t]));

    // kind esperado (quando o gabarito declara)
    for (const te of c.def.expect.transactions ?? []) {
      const t = byFitid.get(te.ref)!;
      if (te.kind) expect(categoryToKind(t.classification.category), te.ref).toBe(te.kind);
      if (te.status === "no_receipt_needed") expect(t.classification.receiptRequirement, te.ref).toBe("not_required");
      if (te.status === "missing_receipt") expect(t.classification.receiptRequirement, te.ref).toBe("required");
      if (te.status === "unmatched_credit") expect(t.classification.receiptRequirement, te.ref).toBe("optional");
    }
    // nenhum erro plantado pode ser escondido por "não exige comprovante"
    const mustAsk = (c.def.expect.requiredFindings ?? []).filter((f) => f.type === "missing_receipt").flatMap((f) => asArray(f.tx));
    for (const ref of mustAsk) expect(byFitid.get(ref)!.classification.receiptRequirement, ref).toBe("required");
    // tudo que é saída e não está declarado como não-exige continua exigindo
    for (const t of a.transactions) {
      if (t.classification.receiptRequirement === "not_required") {
        const declared = (c.def.expect.transactions ?? []).find((te) => te.ref === `fitid:${t.fitid}`);
        expect(declared?.status, `${t.fitid} dispensado sem estar no gabarito`).toBe("no_receipt_needed");
      }
    }
  });
});

describe("C11 — tarifa, IOF, aplicação, resgate e transferência própria", () => {
  const c = CASES.find((x) => x.def.id === "C11")!;
  const a = analyzeStatement(parse(c.files["extrato-setembro.ofx"]));
  const by = (f: string) => a.transactions.find((t) => t.fitid === f)!.classification;

  it.each([
    ["C11-01", "fee"], ["C11-02", "fee"], ["C11-03", "investment"], ["C11-04", "investment"], ["C11-05", "own_transfer"],
  ])("%s → %s, não exige comprovante", (fitid, cat) => {
    expect(by(fitid).category).toBe(cat);
    expect(by(fitid).receiptRequirement).toBe("not_required");
  });
  it("C11-06 (PIX para a contabilidade) → pagamento regular, EXIGE comprovante", () => {
    expect(by("C11-06")).toMatchObject({ category: "regular_payment", receiptRequirement: "required" });
  });
  it("tarifas e IOF somam no saldo (classificação não tira nada do saldo)", () => {
    expect(a.balance.sumCents).toBe(-4890 - 1990 - 500000 + 200000 - 100000 - 78000);
  });
});

describe("C13 — só extrato: exatamente as 4 saídas comuns exigem comprovante", () => {
  it("tarifa e entrada não entram na lista", () => {
    const c = CASES.find((x) => x.def.id === "C13")!;
    const a = analyzeStatement(parse(c.files["extrato-setembro.ofx"]));
    const required = a.transactions.filter((t) => t.classification.receiptRequirement === "required").map((t) => t.fitid);
    expect(required).toEqual(["C13-01", "C13-02", "C13-03", "C13-04"]);
  });
});

describe("C07 — extrato com linha perdida (preparação para o STEP 11)", () => {
  it("montado a partir da verdade do dataset, o saldo é 'failed' e aponta a linha de 20/09", () => {
    const c = CASES.find((x) => x.def.id === "C07")!;
    const src = c.sources["extrato-setembro.pdf"];
    const truth = src.statementTruth!;
    const lines = src.textLines!;
    let bal = truth.openingCents;
    const present: ParsedStatement["transactions"] = [];
    for (const t of truth.transactions) {
      bal += t.cents;
      if (!t.present) continue;
      const ln = lines.findIndex((l) => l.includes(t.desc)) + 1;
      present.push({
        seq: present.length + 1, date: t.date as IsoDate, description: t.desc, amountCents: t.cents,
        direction: t.cents < 0 ? "out" : "in", balanceAfterCents: bal, fitid: null, bankType: null,
        source: { page: 1, line: ln, excerpt: lines[ln - 1] },
      });
    }
    const st: ParsedStatement = {
      format: "csv", encoding: "utf-8", accountLabel: null, currency: "BRL", periodStart: null, periodEnd: null,
      openingBalanceCents: truth.openingCents, closingBalanceCents: bal, closingBalanceDate: null,
      transactions: present, removedDuplicates: [], warnings: [],
    };
    const a = analyzeStatement(st);
    expect(a.balance.status).toBe(c.def.expect.balanceCheck); // "failed" — o gabarito do C07
    expect(lines[a.balance.firstBroken!.line - 1]).toMatch(/^20\/09\/2026 PIX ENVIADO CONTABILIDADE/);
    expect(a.balance.diffCents).toBe(-199000);
  });
});

describe("extratos do STEP 02", () => {
  it("CSV tradicional (saldo anterior + saldo por linha, sem saldo final) → structural_only, ordem crescente", () => {
    const a = analyzeStatement(parse(readFileSync(join(FIX, "csv-tradicional-cp1252.csv"))));
    expect(a.balance).toMatchObject({ status: "structural_only", method: "running_balance", order: "ascending" });
  });
  it("CSV débito/crédito (saldo anterior + saldo por linha) → structural_only", () => {
    expect(analyzeStatement(parse(readFileSync(join(FIX, "csv-debito-credito-bom.csv")))).balance.status).toBe("structural_only");
  });
  it("CSV de banco digital (sem saldos) → not_available", () => {
    expect(analyzeStatement(parse(readFileSync(join(FIX, "csv-digital-utf8.csv")))).balance.status).toBe("not_available");
  });
  it("OFX → structural_only; tipo do banco (TRNTYPE) disponível para a classificação", () => {
    const st = parse(readFileSync(join(FIX, "ofx-sgml-cp1252.ofx")));
    expect(st.transactions.map((t) => t.bankType)).toEqual(["DEBIT", "DEBIT", "CREDIT", "DEBIT", "PAYMENT", "FEE"]);
    const a = analyzeStatement(st);
    expect(a.balance.status).toBe("structural_only");
    expect(a.transactions.map((t) => t.classification.category)).toEqual([
      "regular_payment", "fee", "regular_receipt", "regular_payment", "regular_payment", "fee",
    ]);
  });
  it("CSV mais-recente-primeiro (invertido) → ordem descendente detectada, mesmo resultado", () => {
    const text = readFileSync(join(FIX, "csv-debito-credito-bom.csv"), "utf8").replace(/^﻿/, "").trim().split(/\r\n/);
    const [header, saldoAnterior, ...rows] = text;
    const reversed = Buffer.from([header, ...rows.reverse(), saldoAnterior].join("\r\n"), "utf8");
    const a = analyzeStatement(parse(reversed));
    expect(a.balance.order).toBe("descending");
    expect(a.balance.status).not.toBe("failed");
  });
});

describe("V — múltiplas contas", () => {
  it("o leitor recusa antes; ParsedStatement representa UMA conta por construção", () => {
    const one = `<STMTRS>\n<CURDEF>BRL\n<BANKTRANLIST>\n<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20260905\n<TRNAMT>-1.00\n<FITID>A\n</STMTTRN>\n</BANKTRANLIST>\n</STMTRS>`;
    const r = parseStatement(Buffer.from(`OFXHEADER:100\n\n<OFX>\n${one}\n${one}\n</OFX>\n`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MULTIPLE_ACCOUNTS");
  });
});
