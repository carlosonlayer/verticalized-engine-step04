#!/usr/bin/env node
// =====================================================================
// MUTATION TESTING — STEP 04 (saldo + classificação)
//
// Para cada mutação: altera o código-fonte de propósito, roda os testes do STEP 04
// e EXIGE que falhem. Se uma mutação sobreviver (testes passam), os testes têm um
// ponto cego → o script termina com erro.
// O código original é SEMPRE restaurado (inclusive se o script for interrompido).
//
// Uso: npm run test:mutation
// =====================================================================
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = "src/workers/finance-month-close/statement";
const TESTS = [
  "test/unit/balance.test.ts",
  "test/unit/classify.test.ts",
  "test/unit/statement-invariants.test.ts",
  "test/integration/statement-analysis.test.ts",
];

const MUTATIONS = [
  { id: "M01", name: "aceitar saldo com diferença de 1 centavo", file: `${SRC}/balance.ts`,
    find: `if (diff === 0n) return base({ status: "passed", method: "opening_closing"`,
    replace: `if (diff! >= -1n && diff! <= 1n) return base({ status: "passed", method: "opening_closing"` },
  { id: "M02", name: "inverter o sinal de uma movimentação na soma", file: `${SRC}/balance.ts`,
    find: `const sum = txs.reduce((acc, t) => acc + big(t.amountCents), 0n);`,
    replace: `const sum = txs.reduce((acc, t, i) => acc + (i === 0 ? -big(t.amountCents) : big(t.amountCents)), 0n);` },
  { id: "M03", name: "aceitar arredondamento (comparar em reais, não em centavos)", file: `${SRC}/balance.ts`,
    find: `if (diff === 0n) return base({ status: "passed", method: "opening_closing"`,
    replace: `if (diff! / 100n === 0n) return base({ status: "passed", method: "opening_closing"` },
  { id: "M04", name: "classificar tarifa como regular_payment", file: `${SRC}/classify.ts`,
    find: `{ id: "FEE_TARIFA", category: "fee"`, replace: `{ id: "FEE_TARIFA", category: "regular_payment"` },
  { id: "M05", name: "classificar transferência própria como pagamento", file: `${SRC}/classify.ts`,
    find: `{ id: "OWN_TRANSFER_TERMS", category: "own_transfer"`, replace: `{ id: "OWN_TRANSFER_TERMS", category: "regular_payment"` },
  { id: "M06", name: "transformar unknown em categoria arbitrária", file: `${SRC}/classify.ts`,
    find: `return unknown("Nenhuma regra reconheceu esta movimentação.");`,
    replace: `return { category: dir === "out" ? "regular_payment" : "regular_receipt", receiptRequirement: dir === "out" ? "required" : "optional", ruleId: "GUESS", matchedTerm: null, reason: "" };` },
  { id: "M07", name: "ignorar uma movimentação na soma do saldo", file: `${SRC}/balance.ts`,
    find: `const sum = txs.reduce((acc, t) => acc + big(t.amountCents), 0n);`,
    replace: `const sum = txs.slice(1).reduce((acc, t) => acc + big(t.amountCents), 0n);` },
  { id: "M08", name: "inventar uma movimentação na classificação", file: `${SRC}/classify.ts`,
    find: `return txs.map((tx) => ({ ...tx, classification: classifyTransaction(tx) }));`,
    replace: `const out = txs.map((tx) => ({ ...tx, classification: classifyTransaction(tx) })); return out.length ? [...out, { ...out[out.length - 1], seq: out.length + 1 }] : out;` },
  { id: "M09", name: "alterar o valor durante a classificação", file: `${SRC}/classify.ts`,
    find: `return txs.map((tx) => ({ ...tx, classification: classifyTransaction(tx) }));`,
    replace: `return txs.map((tx) => ({ ...tx, amountCents: Math.abs(tx.amountCents), classification: classifyTransaction(tx) }));` },
  // ---- extras ----
  { id: "M10", name: "dispensar comprovante de qualquer coisa que não seja pagamento", file: `${SRC}/classify.ts`,
    find: `if (NOT_REQUIRED_CATEGORIES.includes(category)) return "not_required";`,
    replace: `if (category !== "regular_payment") return "not_required";` },
  { id: "M11", name: "ignorar a ordem (assumir sempre crescente)", file: `${SRC}/balance.ts`,
    find: `if (ascBreaks.length < descBreaks.length) order = "ascending";`, replace: `if (true) order = "ascending";` },
  { id: "M12", name: "inventar saldo inicial a partir do final", file: `${SRC}/balance.ts`,
    find: `const opening = st.openingBalanceCents;`,
    replace: `const opening = st.openingBalanceCents ?? (st.closingBalanceCents !== null ? st.closingBalanceCents - st.transactions.reduce((s, t) => s + t.amountCents, 0) : null);` },
  { id: "M13", name: "transformar erro estrutural em passed", file: `${SRC}/balance.ts`,
    find: `if (!structural.ok) return base({ status: "failed", method: "structural" });`,
    replace: `if (!structural.ok) return base({ status: "passed", method: "structural" });` },
  { id: "M14", name: "não checar sinal x direção", file: `${SRC}/validate.ts`,
    find: `} else if ((t.amountCents < 0 ? "out" : "in") !== t.direction) {`, replace: `} else if (false) {` },
  { id: "M15", name: "estorno deixa de ser unknown", file: `${SRC}/classify.ts`,
    find: `if (reversal) return`, replace: `if (false && reversal) return` },
  { id: "M16", name: "regras conflitantes: escolher a primeira em vez de unknown", file: `${SRC}/classify.ts`,
    find: `if (categories.length > 1) {`, replace: `if (false && categories.length > 1) {` },
];

const vitest = (files) =>
  spawnSync("npx", ["vitest", "run", ...files], { cwd: ROOT, encoding: "utf8", env: process.env });

const originals = new Map();
const restoreAll = () => {
  for (const [f, content] of originals) writeFileSync(join(ROOT, f), content);
};
process.on("SIGINT", () => { restoreAll(); process.exit(130); });

// linha de base: sem mutação, os testes PRECISAM passar
const baseline = vitest(TESTS);
if (baseline.status !== 0) {
  console.error("Linha de base falhou: os testes do STEP 04 não passam sem mutação. Abortando.");
  console.error(baseline.stdout.split("\n").slice(-25).join("\n"));
  process.exit(2);
}

const results = [];
for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  originals.set(m.file, original);
  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    results.push({ ...m, outcome: "INVALID", detail: `trecho alvo encontrado ${occurrences}x (esperado 1)` });
    continue;
  }
  try {
    writeFileSync(path, original.replace(m.find, m.replace));
    const r = vitest(TESTS);
    const failed = (r.stdout.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? (r.status !== 0 ? "?" : "0");
    results.push({ ...m, outcome: r.status !== 0 ? "KILLED" : "SURVIVED", detail: `${failed} teste(s) falharam` });
  } finally {
    writeFileSync(path, original);
  }
}
restoreAll();

console.log("\n=========== MUTATION TESTING — STEP 04 ===========");
for (const r of results) console.log(`${r.outcome.padEnd(9)} ${r.id}  ${r.name.padEnd(62)} ${r.detail}`);
const bad = results.filter((r) => r.outcome !== "KILLED");
console.log(`\n${results.length - bad.length}/${results.length} mutações mortas.`);
console.log(bad.length === 0 ? "RESULTADO: PASS" : "RESULTADO: FAIL");
process.exit(bad.length === 0 ? 0 : 1);
