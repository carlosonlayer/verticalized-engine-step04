import type { IsoDate } from "../../src/workers/finance-month-close/parsers/date.js";
import type { ParsedStatement, ParsedTransaction } from "../../src/workers/finance-month-close/parsers/types.js";

/** Movimentação de teste. Valores SEMPRE em centavos inteiros. */
export type TxSpec = {
  date: string;
  cents: number;
  bal?: number | null;
  fitid?: string | null;
  desc?: string;
  bankType?: string | null;
  direction?: "in" | "out"; // para forçar inconsistência em teste
};

export function mkTxs(specs: TxSpec[]): ParsedTransaction[] {
  return specs.map((s, i) => ({
    seq: i + 1,
    date: s.date as IsoDate,
    description: s.desc ?? (s.cents < 0 ? "PIX ENVIADO FORNECEDOR" : "PIX RECEBIDO CLIENTE"),
    amountCents: s.cents,
    direction: s.direction ?? (s.cents < 0 ? "out" : "in"),
    balanceAfterCents: s.bal ?? null,
    fitid: s.fitid === undefined ? null : s.fitid,
    bankType: s.bankType ?? null,
    source: { page: 1, line: 10 + i, excerpt: `linha ${i + 1}` },
  }));
}

export function mkStatement(p: {
  format?: "ofx" | "csv";
  opening?: number | null;
  closing?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  closingDate?: string | null;
  txs: TxSpec[];
}): ParsedStatement {
  return {
    format: p.format ?? "csv",
    encoding: "utf-8",
    accountLabel: null,
    currency: "BRL",
    periodStart: (p.periodStart ?? null) as IsoDate | null,
    periodEnd: (p.periodEnd ?? null) as IsoDate | null,
    openingBalanceCents: p.opening ?? null,
    closingBalanceCents: p.closing ?? null,
    closingBalanceDate: (p.closingDate ?? null) as IsoDate | null,
    transactions: mkTxs(p.txs),
    removedDuplicates: [],
    warnings: [],
  };
}

/** Saldos por linha corretos, em ordem crescente, a partir de um saldo inicial. */
export function withRunning(opening: number, specs: TxSpec[]): TxSpec[] {
  let bal = opening;
  return specs.map((s) => {
    bal += s.cents;
    return { ...s, bal };
  });
}

/** Gerador pseudoaleatório determinístico (mesma sequência em toda execução). */
export function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  return {
    int: (min: number, max: number) => min + (next() % (max - min + 1)),
    pick: <T>(xs: readonly T[]) => xs[next() % xs.length],
  };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
