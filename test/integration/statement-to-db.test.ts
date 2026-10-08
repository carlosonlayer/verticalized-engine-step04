import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStatement, toTransactionRows } from "../../src/workers/finance-month-close/parsers/statement.js";
import { createTestDatabase } from "../helpers/db.js";

/**
 * Integração: arquivo real (sintético) → leitor → linhas → PostgreSQL com a migração real.
 * Prova que o que os leitores produzem é aceito pelas regras do banco (sinal, evidência,
 * FITID único, centavos bigint) e que os centavos voltam do banco idênticos.
 */
const FIX = join(import.meta.dirname, "..", "fixtures", "statements");
const FIXTURES = readdirSync(FIX).sort();

let db: pg.Client;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase("vtest_statement_to_db"));
});
afterAll(async () => {
  await drop?.();
});

async function seedWork(fileName: string, bytes: Buffer) {
  const user = (await db.query(`insert into auth.users(email) values ('t@t.com') returning id`)).rows[0].id;
  const ws = (await db.query(`insert into workspaces(owner_id) values ($1) returning id`, [user])).rows[0].id;
  const work = (await db.query(`insert into works(workspace_id, created_by) values ($1,$2) returning id`, [ws, user])).rows[0].id;
  const doc = (
    await db.query(
      `insert into documents(work_id, role, file_name, mime, sha256, size_bytes, extraction_method, extraction_status)
       values ($1,'statement',$2,'text/plain',$3,$4,$5,'ok') returning id`,
      [work, fileName, createHash("sha256").update(bytes).digest("hex"), bytes.length, fileName.endsWith(".ofx") ? "ofx" : "csv"],
    )
  ).rows[0].id;
  return { work, doc };
}

describe.each(FIXTURES)("fixture %s → banco", (fileName) => {
  it("todas as movimentações são aceitas pelas regras do banco e voltam idênticas", async () => {
    const bytes = readFileSync(join(FIX, fileName));
    const parsed = parseStatement(bytes);
    if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    const st = parsed.statement;

    await db.query("begin");
    try {
      const { work, doc } = await seedWork(fileName, bytes);
      const rows = toTransactionRows(st, { workId: work, documentId: doc, fileName });

      for (const r of rows) {
        await db.query(
          `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction,
                                    balance_after_cents, fitid, evidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [r.work_id, r.document_id, r.seq, r.date, r.description, r.amount_cents, r.direction,
           r.balance_after_cents, r.fitid, JSON.stringify(r.evidence)],
        );
      }

      const { rows: back } = await db.query(
        `select seq, to_char(date, 'YYYY-MM-DD') as date, amount_cents::text as cents, direction,
                balance_after_cents::text as bal, fitid, evidence
         from transactions where work_id = $1 order by seq`,
        [work],
      );
      expect(back).toHaveLength(st.transactions.length);
      back.forEach((b, i) => {
        const t = st.transactions[i];
        expect(b.seq).toBe(t.seq);
        expect(b.date).toBe(t.date); // data idêntica, sem deslocamento de fuso
        expect(BigInt(b.cents)).toBe(BigInt(t.amountCents)); // centavos idênticos, via bigint
        expect(b.direction).toBe(t.direction);
        expect(b.bal === null ? null : Number(b.bal)).toBe(t.balanceAfterCents);
        expect(b.fitid).toBe(t.fitid);
        expect(b.evidence[0]).toMatchObject({ method: "structured", verified: true, page: 1, line: t.source.line });
      });

      // soma calculada pelo banco = soma calculada pelo código
      const { rows: sum } = await db.query(
        `select coalesce(sum(amount_cents), 0)::text as total from transactions where work_id = $1`,
        [work],
      );
      expect(BigInt(sum[0].total)).toBe(BigInt(st.transactions.reduce((s, t) => s + t.amountCents, 0)));

      // nenhum CPF completo foi parar no banco
      const { rows: leak } = await db.query(
        `select count(*)::int as n from transactions
         where work_id = $1 and (description ~ '\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}' or evidence::text ~ '\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}')`,
        [work],
      );
      expect(leak[0].n).toBe(0);
    } finally {
      await db.query("rollback");
    }
  });
});

describe("consistência entre formatos", () => {
  it("OFX e CSV do mesmo mês: mesma soma, mesmo saldo final", () => {
    const ofx = parseStatement(readFileSync(join(FIX, "ofx-sgml-cp1252.ofx")));
    const csv = parseStatement(readFileSync(join(FIX, "csv-tradicional-cp1252.csv")));
    if (!ofx.ok || !csv.ok) throw new Error("fixture inválida");
    const sum = (xs: { amountCents: number }[]) => xs.reduce((s, t) => s + t.amountCents, 0);
    expect(sum(ofx.statement.transactions)).toBe(sum(csv.statement.transactions));
    // saldo inicial (CSV) + movimentos = saldo final (OFX) — base do check de saldo do STEP 04
    expect(csv.statement.openingBalanceCents! + sum(csv.statement.transactions)).toBe(ofx.statement.closingBalanceCents);
  });
});
