import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedTransaction } from "../../src/workers/finance-month-close/parsers/types.js";
import { analyzeStatement } from "../../src/workers/finance-month-close/statement/analyze.js";
import { checkBalance } from "../../src/workers/finance-month-close/statement/balance.js";
import { classifyTransactions, NOT_REQUIRED_CATEGORIES } from "../../src/workers/finance-month-close/statement/classify.js";
import { deepFreeze, mkStatement, mkTxs, prng, withRunning, type TxSpec } from "../helpers/statement.js";

/**
 * PROPRIEDADES — valem para QUALQUER extrato válido, não só para os exemplos.
 * Gerador determinístico: mesma sequência em toda execução (falha é reproduzível).
 */
const RUNS = 400;
const DESCS = [
  "PIX ENVIADO FORNECEDOR", "PIX RECEBIDO CLIENTE", "TARIFA PACOTE", "IOF", "APLICACAO CDB", "RESGATE CDB",
  "TRANSF MESMA TITULARIDADE", "SAQUE ATM", "PAGTO BOLETO", "XPTO", "ESTORNO TARIFA", "DEPOSITO",
];

function randomStatement(seed: number) {
  const r = prng(seed);
  const n = r.int(0, 60);
  const opening = r.int(-5_000_000, 50_000_000);
  const specs: TxSpec[] = Array.from({ length: n }, (_, i) => {
    let cents = r.int(-9_999_999, 9_999_999);
    if (cents === 0) cents = 1;
    return { date: `2026-09-${String(1 + (i % 30)).padStart(2, "0")}`, cents, desc: r.pick(DESCS), fitid: `F${seed}-${i}` };
  });
  const closing = opening + specs.reduce((s, t) => s + t.cents, 0);
  return { r, opening, closing, specs };
}

describe("propriedade: inicial + Σ movimentos = final (centavos inteiros)", () => {
  it(`passa em ${RUNS} extratos aleatórios corretos`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const { opening, closing, specs } = randomStatement(seed);
      const res = checkBalance(mkStatement({ opening, closing, txs: specs }));
      expect(res.status, `seed ${seed}`).toBe("passed");
      expect(res.diffCents).toBe(0);
      expect(Number.isSafeInteger(res.sumCents)).toBe(true);
    }
  });

  it(`falha em ${RUNS} extratos com o saldo final alterado em k centavos, e informa exatamente k`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const { r, opening, closing, specs } = randomStatement(seed);
      let k = r.int(-1000, 1000);
      if (k === 0) k = 1;
      const res = checkBalance(mkStatement({ opening, closing: closing + k, txs: specs }));
      expect(res.status, `seed ${seed}`).toBe("failed");
      expect(res.diffCents).toBe(k);
    }
  });

  it("saldo por linha: crescente e invertido passam; uma linha corrompida falha exatamente nela", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const { r, opening, closing, specs } = randomStatement(seed);
      if (specs.length < 2) continue;
      const asc = withRunning(opening, specs);
      expect(checkBalance(mkStatement({ opening, closing, txs: asc })).status, `asc seed ${seed}`).toBe("passed");
      const desc = checkBalance(mkStatement({ opening, closing, txs: [...asc].reverse() }));
      expect(desc.status, `desc seed ${seed}`).toBe("passed");
      expect(desc.order).toBe("descending");

      const j = r.int(0, asc.length - 1);
      const bad = asc.map((t, i) => (i === j ? { ...t, bal: t.bal! + r.int(1, 500) } : t));
      const res = checkBalance(mkStatement({ opening, closing, txs: bad }));
      expect(res.status, `corrupt seed ${seed}`).toBe("failed");
      expect(res.firstBroken?.seq, `corrupt seed ${seed} j=${j}`).toBe(j + 1);
    }
  });
});

describe("invariantes da classificação: nada some, nada é inventado, nada muda", () => {
  it(`em ${RUNS} extratos aleatórios`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const { specs } = randomStatement(seed);
      const input = deepFreeze(mkTxs(specs)); // congelado: qualquer escrita lança erro
      const snapshot = JSON.stringify(input);
      const out = classifyTransactions(input);

      expect(out).toHaveLength(input.length); // nenhuma desaparece / nenhuma inventada
      expect(JSON.stringify(input)).toBe(snapshot); // entrada intacta
      out.forEach((o, i) => {
        const t: ParsedTransaction = input[i];
        expect(o.seq).toBe(t.seq); // IDs estáveis
        expect(o.fitid).toBe(t.fitid);
        expect(o.date).toBe(t.date); // datas iguais
        expect(o.amountCents).toBe(t.amountCents); // valores iguais
        expect(o.direction).toBe(t.direction); // sinal não muda
        expect(o.description).toBe(t.description);
        expect(o.balanceAfterCents).toBe(t.balanceAfterCents);
        expect(o.source).toEqual(t.source);
        const { classification, ...rest } = o;
        expect(rest).toEqual(t); // exatamente os mesmos campos + classification
        if (classification.receiptRequirement === "not_required") {
          expect(NOT_REQUIRED_CATEGORIES).toContain(classification.category);
          expect(classification.ruleId).not.toBeNull();
        }
      });
    }
  });

  it("é determinística (mesma entrada → mesma saída)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const txs = mkTxs(randomStatement(seed).specs);
      expect(classifyTransactions(txs)).toEqual(classifyTransactions(txs));
    }
  });

  it("analyzeStatement não altera o extrato e mantém todas as movimentações", () => {
    const st = deepFreeze(mkStatement({ opening: 1000, closing: 700, txs: [{ date: "2026-09-01", cents: -100 }, { date: "2026-09-02", cents: -200 }] }));
    const a = analyzeStatement(st);
    expect(a.transactions.map((t) => t.seq)).toEqual([1, 2]);
    expect(a.balance.status).toBe("passed");
  });
});

describe("S — nenhum ponto flutuante na lógica financeira (varredura do código)", () => {
  const files = [
    "src/workers/finance-month-close/statement/balance.ts",
    "src/workers/finance-month-close/statement/validate.ts",
    "src/workers/finance-month-close/statement/classify.ts",
    "src/workers/finance-month-close/statement/analyze.ts",
  ];
  it.each(files)("%s", (f) => {
    const code = readFileSync(join(import.meta.dirname, "..", "..", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of [/parseFloat/, /toFixed/, /Math\.round/, /Math\.floor/, /Math\.ceil/, /\/\s*100\b/, /\*\s*100\b/, /\bNumber\.parseFloat\b/]) {
      expect(code, `${f} contém ${forbidden}`).not.toMatch(forbidden);
    }
  });
  it("balance.ts soma em BigInt", () => {
    const code = readFileSync(join(import.meta.dirname, "..", "..", files[0]), "utf8");
    expect(code).toMatch(/BigInt\(/);
    expect(code).toMatch(/0n/);
  });
});
