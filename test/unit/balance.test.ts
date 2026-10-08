import { describe, expect, it } from "vitest";
import { checkBalance, checkRunningBalance, toContractBalanceCheck } from "../../src/workers/finance-month-close/statement/balance.js";
import { mkStatement, mkTxs, withRunning } from "../helpers/statement.js";

const SEP = { periodStart: "2026-09-01", periodEnd: "2026-09-30" };
const codes = (r: ReturnType<typeof checkBalance>) => r.issues.map((i) => i.code);

describe("A — saldo correto", () => {
  it("saldo inicial + movimentos = saldo final → passed (opening_closing)", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing: 805_120, txs: [
      { date: "2026-09-01", cents: -125_000 }, { date: "2026-09-02", cents: -4_890 }, { date: "2026-09-03", cents: 500_000 },
      { date: "2026-09-10", cents: -78_000 }, { date: "2026-09-15", cents: -485_000 }, { date: "2026-09-30", cents: -1_990 },
    ] }));
    expect(r.status).toBe("passed");
    expect(r.method).toBe("opening_closing");
    expect(r.computedClosingCents).toBe(805_120);
    expect(r.diffCents).toBe(0);
    expect(r.sumCents).toBe(-194_880);
  });

  it("saldo por linha + saldo inicial e final explícitos → passed (running_balance)", () => {
    const txs = withRunning(200_000, [{ date: "2026-09-02", cents: -150_000 }, { date: "2026-09-05", cents: 300_000 }, { date: "2026-09-09", cents: -1_250 }]);
    const r = checkBalance(mkStatement({ opening: 200_000, closing: 348_750, txs }));
    expect(r.status).toBe("passed");
    expect(r.method).toBe("running_balance");
    expect(r.order).toBe("ascending");
  });

  it("mês sem movimentação com saldo inicial = final → passed", () => {
    const r = checkBalance(mkStatement({ opening: 50_000, closing: 50_000, txs: [] }));
    expect(r.status).toBe("passed");
    expect(r.sumCents).toBe(0);
  });

  it("formato do contrato (summary.balance_check)", () => {
    const r = checkBalance(mkStatement({ opening: 100, closing: 50, txs: [{ date: "2026-09-01", cents: -50 }] }));
    expect(toContractBalanceCheck(r)).toEqual({ status: "passed", opening_cents: 100, closing_cents: 50, computed_closing_cents: 50, diff_cents: 0 });
  });
});

describe("B / T — saldo incorreto, sem arredondamento", () => {
  it("diferença de 1 centavo → failed, com a diferença EXATA", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing: 805_121, txs: [{ date: "2026-09-01", cents: -194_880 }] }));
    expect(r.status).toBe("failed");
    expect(r.diffCents).toBe(1);
    expect(codes(r)).toContain("OPENING_CLOSING_MISMATCH");
  });

  it("diferença de −1 centavo → failed (sinal da diferença preservado)", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing: 805_119, txs: [{ date: "2026-09-01", cents: -194_880 }] }));
    expect(r.status).toBe("failed");
    expect(r.diffCents).toBe(-1);
  });

  it("diferenças abaixo de R$ 1,00 não são arredondadas para zero", () => {
    for (const d of [1, 49, 50, 51, 99]) {
      const r = checkBalance(mkStatement({ opening: 0, closing: 10_000 + d, txs: [{ date: "2026-09-01", cents: 10_000 }] }));
      expect(r.status, `diferença de ${d} centavos`).toBe("failed");
      expect(r.diffCents).toBe(d);
    }
  });

  it("linha perdida (padrão C07): saldo não fecha e aponta a linha seguinte", () => {
    // 6 movimentações; a 4ª (−1.990,00) se perdeu, mas os saldos das linhas são os reais
    const all = withRunning(1_000_000, [
      { date: "2026-09-01", cents: -125_000 }, { date: "2026-09-05", cents: -32_000 }, { date: "2026-09-10", cents: 450_000 },
      { date: "2026-09-15", cents: -199_000 }, { date: "2026-09-20", cents: -78_000 }, { date: "2026-09-25", cents: -4_500 },
    ]);
    const closing = all[all.length - 1].bal!;
    const present = all.filter((_, i) => i !== 3);
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing, txs: present }));
    expect(r.status).toBe("failed");
    expect(r.method).toBe("running_balance");
    expect(r.firstBroken).toEqual({ seq: 4, line: 13 }); // a linha de 20/09 (4ª presente)
    expect(codes(r)).toContain("RUNNING_BALANCE_BROKEN");
    expect(r.diffCents).toBe(-199_000); // final − (inicial + soma lida) = exatamente a linha perdida
  });
});

describe("C / D / E — sem saldo inicial, structural_only, not_available", () => {
  const ofxTxs = [
    { date: "2026-09-01", cents: -125_000, fitid: "A" },
    { date: "2026-09-03", cents: 500_000, fitid: "B" },
  ];

  it("D: OFX com período, FITIDs e só saldo final → structural_only (não inventa saldo inicial)", () => {
    const r = checkBalance(mkStatement({ format: "ofx", ...SEP, closing: 805_120, txs: ofxTxs }));
    expect(r.status).toBe("structural_only");
    expect(r.method).toBe("structural");
    expect(r.openingCents).toBeNull();
    expect(r.computedClosingCents).toBeNull();
    expect(r.diffCents).toBeNull();
  });

  it("C: CSV só com saldo final → not_available (sem saldo inicial, não dá para provar)", () => {
    const r = checkBalance(mkStatement({ closing: 375_000, txs: [{ date: "2026-09-01", cents: -125_000 }] }));
    expect(r.status).toBe("not_available");
    expect(r.openingCents).toBeNull();
    expect(codes(r)).toContain("NO_BALANCE_ANCHOR");
  });

  it("C: saldo por linha coerente mas sem saldo inicial → structural_only (pontas não provadas)", () => {
    const txs = withRunning(1_000_000, [{ date: "2026-09-01", cents: -100 }, { date: "2026-09-02", cents: -200 }]);
    const r = checkBalance(mkStatement({ closing: 999_700, txs }));
    expect(r.status).toBe("structural_only");
    expect(r.method).toBe("running_balance");
    expect(codes(r)).toContain("NO_BALANCE_ANCHOR");
  });

  it("C: saldo por linha + só saldo inicial → structural_only", () => {
    const txs = withRunning(1_000_000, [{ date: "2026-09-01", cents: -100 }, { date: "2026-09-02", cents: -200 }]);
    expect(checkBalance(mkStatement({ opening: 1_000_000, txs })).status).toBe("structural_only");
  });

  it.each([
    ["sem período declarado", { format: "ofx" as const, closing: 1, txs: ofxTxs }, "PERIOD_NOT_DECLARED"],
    ["sem FITID", { format: "ofx" as const, ...SEP, closing: 1, txs: ofxTxs.map((t) => ({ ...t, fitid: null })) }, "FITIDS_INCOMPLETE"],
    ["movimentação fora do período", { format: "ofx" as const, ...SEP, closing: 1, txs: [...ofxTxs, { date: "2026-10-01", cents: -1, fitid: "C" }] }, "OUT_OF_DECLARED_PERIOD"],
    ["CSV sem saldos", { txs: [{ date: "2026-09-01", cents: -100 }] }, "NO_BALANCE_ANCHOR"],
  ])("E: %s → not_available, com o motivo", (_l, st, code) => {
    const r = checkBalance(mkStatement(st));
    expect(r.status).toBe("not_available");
    expect(r.method).toBe("none");
    expect(codes(r)).toContain(code);
  });

  it("saldo por linha parcial não é usado (e fica registrado)", () => {
    const r = checkBalance(mkStatement({ opening: 1000, closing: 700, txs: [{ date: "2026-09-01", cents: -100, bal: 900 }, { date: "2026-09-02", cents: -200 }] }));
    expect(r.status).toBe("passed");
    expect(r.method).toBe("opening_closing");
    expect(codes(r)).toContain("RUNNING_BALANCE_PARTIAL");
  });
});

describe("F / G — ordem das linhas", () => {
  const specs = [
    { date: "2026-09-01", cents: -125_000 }, { date: "2026-09-05", cents: -32_000 },
    { date: "2026-09-10", cents: 450_000 }, { date: "2026-09-20", cents: -78_000 },
  ];
  const asc = withRunning(1_000_000, specs);
  const closing = asc[asc.length - 1].bal!;

  it("F: ordem crescente detectada pela aritmética", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing, txs: asc }));
    expect(r.order).toBe("ascending");
    expect(r.status).toBe("passed");
  });

  it("G: mais recente primeiro detectado e aceito (mesmo saldo)", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing, txs: [...asc].reverse() }));
    expect(r.order).toBe("descending");
    expect(r.status).toBe("passed");
  });

  it("G: ordem é decidida pelo saldo, não pela data (datas embaralhadas no mesmo dia)", () => {
    const sameDay = withRunning(0, [{ date: "2026-09-05", cents: 100 }, { date: "2026-09-05", cents: -30 }, { date: "2026-09-05", cents: 50 }]);
    expect(checkRunningBalance(mkTxs(sameDay)).order).toBe("ascending");
    expect(checkRunningBalance(mkTxs([...sameDay].reverse())).order).toBe("descending");
  });

  it("G: quebra em extrato mais-recente-primeiro aponta a primeira quebra em ordem CRONOLÓGICA", () => {
    const all = withRunning(1_000_000, [...specs, { date: "2026-09-25", cents: -4_500 }, { date: "2026-09-28", cents: -1_000 }]);
    const missing = all.filter((_, i) => i !== 2); // some a linha de 10/09
    const desc = [...missing].reverse();
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing: all[all.length - 1].bal!, txs: desc }));
    expect(r.status).toBe("failed");
    expect(r.order).toBe("descending");
    const broken = mkTxs(desc).find((t) => t.seq === r.firstBroken!.seq)!;
    expect(broken.date).toBe("2026-09-20"); // primeira linha DEPOIS da perdida, no tempo
  });

  it("saldo errado na PRIMEIRA linha aponta a primeira linha (achado pela propriedade, seed 35)", () => {
    const bad = asc.map((t, i) => (i === 0 ? { ...t, bal: t.bal! + 7 } : t));
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing, txs: bad }));
    expect(r.status).toBe("failed");
    expect(r.firstBroken?.seq).toBe(1);
  });

  it("sem saldo inicial, a localização é a primeira quebra entre pares (limitação documentada)", () => {
    const bad = asc.map((t, i) => (i === 0 ? { ...t, bal: t.bal! + 7 } : t));
    const r = checkBalance(mkStatement({ closing, txs: bad }));
    expect(r.status).toBe("failed");
    expect(r.firstBroken?.seq).toBe(2);
  });

  it("linha única: ordem 'single'", () => {
    const r = checkBalance(mkStatement({ opening: 100, closing: 50, txs: [{ date: "2026-09-01", cents: -50, bal: 50 }] }));
    expect(r.order).toBe("single");
    expect(r.status).toBe("passed");
  });

  it("saldo da primeira linha incoerente com o saldo inicial → failed", () => {
    const r = checkBalance(mkStatement({ opening: 999, closing, txs: asc }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("RUNNING_BALANCE_OPENING_MISMATCH");
  });

  it("saldo da última linha incoerente com o saldo final → failed", () => {
    const r = checkBalance(mkStatement({ opening: 1_000_000, closing: closing + 1, txs: asc }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("RUNNING_BALANCE_CLOSING_MISMATCH");
  });
});

describe("H / I / J — sinais e zero", () => {
  it("H: só saídas (negativas)", () => {
    const r = checkBalance(mkStatement({ opening: 1000, closing: 700, txs: [{ date: "2026-09-01", cents: -100 }, { date: "2026-09-02", cents: -200 }] }));
    expect(r.status).toBe("passed");
    expect(r.sumCents).toBe(-300);
  });
  it("I: só entradas (positivas)", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: 300, txs: [{ date: "2026-09-01", cents: 100 }, { date: "2026-09-02", cents: 200 }] }));
    expect(r.status).toBe("passed");
    expect(r.sumCents).toBe(300);
  });
  it("H: saldo negativo (cheque especial) é válido", () => {
    const r = checkBalance(mkStatement({ opening: -50_000, closing: -60_000, txs: [{ date: "2026-09-01", cents: -10_000 }] }));
    expect(r.status).toBe("passed");
  });
  it("J: movimentação de valor zero → failed (AMOUNT_INVALID)", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: 0, txs: [{ date: "2026-09-01", cents: 0, direction: "out" }] }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("AMOUNT_INVALID");
  });
  it("J: saldos iguais a zero são válidos", () => {
    expect(checkBalance(mkStatement({ opening: 0, closing: 0, txs: [] })).status).toBe("passed");
  });
});

describe("U — sinais inconsistentes e dados inválidos → failed (nunca passed)", () => {
  it("saída com valor positivo", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: 100, txs: [{ date: "2026-09-01", cents: 100, direction: "out" }] }));
    expect(r.status).toBe("failed");
    expect(r.method).toBe("structural");
    expect(codes(r)).toContain("SIGN_INCONSISTENT");
  });
  it("entrada com valor negativo", () => {
    const r = checkBalance(mkStatement({ opening: 100, closing: 0, txs: [{ date: "2026-09-01", cents: -100, direction: "in" }] }));
    expect(codes(r)).toContain("SIGN_INCONSISTENT");
    expect(r.status).toBe("failed");
  });
  it("valor fracionado (float) é recusado, mesmo que a conta 'feche'", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: 10.5, txs: [{ date: "2026-09-01", cents: 10.5 }] }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toEqual(expect.arrayContaining(["AMOUNT_INVALID", "BALANCE_VALUE_INVALID"]));
  });
  it("FITID repetido → failed", () => {
    const r = checkBalance(mkStatement({ format: "ofx", ...SEP, closing: 0, txs: [{ date: "2026-09-01", cents: -1, fitid: "X" }, { date: "2026-09-02", cents: -1, fitid: "X" }] }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("FITID_DUPLICATE");
  });
  it("data inexistente → failed", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: -1, txs: [{ date: "2026-02-30", cents: -1 }] }));
    expect(codes(r)).toContain("DATE_INVALID");
  });
});

describe("W — período inconsistente", () => {
  it("período invertido → OFX não pode ser structural_only", () => {
    const r = checkBalance(mkStatement({ format: "ofx", periodStart: "2026-09-30", periodEnd: "2026-09-01", closing: 0, txs: [{ date: "2026-09-10", cents: -1, fitid: "A" }] }));
    expect(r.status).toBe("not_available");
    expect(codes(r)).toContain("PERIOD_INVERTED");
  });
  it("movimentações cobrindo mais de 31 dias → failed", () => {
    const r = checkBalance(mkStatement({ opening: 0, closing: -2, txs: [{ date: "2026-09-01", cents: -1 }, { date: "2026-10-02", cents: -1 }] }));
    expect(r.status).toBe("failed");
    expect(codes(r)).toContain("PERIOD_TOO_LONG");
  });
  it("saldo final datado antes da última movimentação gera aviso", () => {
    const r = checkBalance(mkStatement({ format: "ofx", ...SEP, closing: 0, closingDate: "2026-09-10", txs: [{ date: "2026-09-20", cents: -1, fitid: "A" }] }));
    expect(codes(r)).toContain("CLOSING_DATE_BEFORE_LAST_TX");
  });
});
