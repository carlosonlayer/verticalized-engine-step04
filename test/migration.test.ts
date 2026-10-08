import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "./helpers/db.js";

const TABLES = ["workspaces", "works", "documents", "transactions", "matches", "findings", "events"];

const ev = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      document_id: "00000000-0000-0000-0000-000000000001",
      file_name: "extrato_set.ofx",
      page: 1,
      line: 14,
      excerpt: "03/09 PIX ENVIADO FORNECEDOR X -1.250,00",
      method: "structured",
      verified: true,
      ...overrides,
    },
  ]);

let db: pg.Client;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ client: db, drop } = await createTestDatabase("vtest_migration"));
});
afterAll(async () => {
  await drop?.();
});

/** Cria usuário + workspace + trabalho + extrato. Retorna os IDs. */
async function seed() {
  const user = (await db.query(`insert into auth.users(email) values ('t@t.com') returning id`)).rows[0].id;
  const ws = (await db.query(`insert into workspaces(owner_id) values ($1) returning id`, [user])).rows[0].id;
  const work = (
    await db.query(`insert into works(workspace_id, created_by) values ($1,$2) returning id`, [ws, user])
  ).rows[0].id;
  const statement = (
    await db.query(
      `insert into documents(work_id, role, file_name, mime, sha256, size_bytes, extraction_method)
       values ($1,'statement','extrato.ofx','application/x-ofx',$2,1000,'ofx') returning id`,
      [work, "a".repeat(64)],
    )
  ).rows[0].id;
  return { user, ws, work, statement };
}

async function expectReject(sql: string, params: unknown[] = [], match?: RegExp) {
  await db.query("savepoint sp");
  try {
    await expect(db.query(sql, params)).rejects.toThrow(match ?? /.+/);
  } finally {
    await db.query("rollback to savepoint sp");
  }
}

describe("estrutura", () => {
  it("cria as 7 tabelas com RLS ligado", async () => {
    const { rows } = await db.query(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
  });

  it("não tem nenhuma policy (ninguém de fora lê nada)", async () => {
    const { rows } = await db.query(`select count(*)::int as n from pg_policies where schemaname = 'public'`);
    expect(rows[0].n).toBe(0);
  });

  it("anon e authenticated não têm nenhum privilégio nas tabelas", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of TABLES) {
        const { rows } = await db.query(
          `select has_table_privilege($1, $2, 'SELECT') as s, has_table_privilege($1, $2, 'INSERT') as i,
                  has_table_privilege($1, $2, 'UPDATE') as u, has_table_privilege($1, $2, 'DELETE') as d`,
          [role, `public.${t}`],
        );
        expect(rows[0], `${role} em ${t}`).toEqual({ s: false, i: false, u: false, d: false });
      }
    }
  });

  it("todo campo de dinheiro (*_cents) é bigint", async () => {
    const { rows } = await db.query(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and column_name like '%\\_cents'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe("bigint");
  });

  it("não existe coluna para arquivo bruto, texto completo ou resposta do modelo", async () => {
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and (data_type = 'bytea'
         or column_name ~ '(raw|file_content|full_text|llm_response|gemini_response)')`,
    );
    expect(rows).toEqual([]);
  });

  it("todas as chaves primárias (exceto events) são UUID", async () => {
    const { rows } = await db.query(
      `select table_name, data_type from information_schema.columns
       where table_schema = 'public' and column_name = 'id' and table_name <> 'events'`,
    );
    for (const r of rows) expect(r.data_type, r.table_name).toBe("uuid");
  });
});

describe("máquina de estados do trabalho", () => {
  beforeEach(async () => {
    await db.query("begin");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  it("caminho normal: received → processing → validating → completed, com timestamps", async () => {
    const { work } = await seed();
    await db.query(`update works set status='processing' where id=$1`, [work]);
    await db.query(`update works set status='validating' where id=$1`, [work]);
    await db.query(`update works set status='completed' where id=$1`, [work]);
    const { rows } = await db.query(`select status, started_at, completed_at from works where id=$1`, [work]);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].started_at).not.toBeNull();
    expect(rows[0].completed_at).not.toBeNull();
  });

  it("validating → needs_review exige motivo", async () => {
    const { work } = await seed();
    await db.query(`update works set status='processing' where id=$1`, [work]);
    await db.query(`update works set status='validating' where id=$1`, [work]);
    await expectReject(`update works set status='needs_review' where id=$1`, [work], /needs_review_has_reasons/);
    await db.query(`update works set status='needs_review', review_reasons=array['balance_not_available'] where id=$1`, [
      work,
    ]);
  });

  it("processing → failed exige error_code", async () => {
    const { work } = await seed();
    await db.query(`update works set status='processing' where id=$1`, [work]);
    await expectReject(`update works set status='failed' where id=$1`, [work], /failed_has_error/);
    await db.query(`update works set status='failed', error_code='TIMEOUT' where id=$1`, [work]);
  });

  it.each([
    ["received", "completed"],
    ["received", "validating"],
    ["processing", "completed"],
  ])("rejeita salto %s → %s", async (from, to) => {
    const { work } = await seed();
    if (from === "processing") await db.query(`update works set status='processing' where id=$1`, [work]);
    await expectReject(`update works set status=$2 where id=$1`, [work, to], /invalid work status transition/);
  });

  it("estado final não volta atrás", async () => {
    const { work } = await seed();
    await db.query(`update works set status='processing' where id=$1`, [work]);
    await db.query(`update works set status='validating' where id=$1`, [work]);
    await db.query(`update works set status='completed' where id=$1`, [work]);
    await expectReject(`update works set status='processing' where id=$1`, [work], /invalid work status transition/);
  });

  it("trabalho não pode nascer concluído", async () => {
    const { ws, user } = await seed();
    await expectReject(
      `insert into works(workspace_id, created_by, status) values ($1,$2,'completed')`,
      [ws, user],
      /must be created with status received/,
    );
  });
});

describe("regras de dados", () => {
  beforeEach(async () => {
    await db.query("begin");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  const insertTx = (work: string, doc: string, seq: number, amount: number, direction: string, evidence = ev()) =>
    db.query(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, evidence)
       values ($1,$2,$3,'2026-09-03','PIX ENVIADO FORNECEDOR X',$4,$5,$6::jsonb) returning id`,
      [work, doc, seq, amount, direction, evidence],
    );

  it("saída negativa e entrada positiva são aceitas", async () => {
    const { work, statement } = await seed();
    await insertTx(work, statement, 1, -125000, "out");
    await insertTx(work, statement, 2, 50000, "in");
  });

  it("rejeita saída com valor positivo, entrada negativa e valor zero", async () => {
    const { work, statement } = await seed();
    await expectReject(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, evidence)
       values ($1,$2,1,'2026-09-03','x',125000,'out',$3::jsonb)`,
      [work, statement, ev()],
      /sign_matches_direction/,
    );
    await expectReject(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, evidence)
       values ($1,$2,1,'2026-09-03','x',-1,'in',$3::jsonb)`,
      [work, statement, ev()],
      /sign_matches_direction/,
    );
    await expectReject(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, evidence)
       values ($1,$2,1,'2026-09-03','x',0,'out',$3::jsonb)`,
      [work, statement, ev()],
    );
  });

  it("rejeita movimentação sem evidência ou com evidência malformada", async () => {
    const { work, statement } = await seed();
    for (const bad of ["[]", ev({ method: "llm_guess" }), ev({ verified: "yes" }), '[{"excerpt":"x"}]']) {
      await expectReject(
        `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, evidence)
         values ($1,$2,1,'2026-09-03','x',-100,'out',$3::jsonb)`,
        [work, statement, bad],
        /evidence/,
      );
    }
  });

  it("rejeita FITID repetido no mesmo trabalho", async () => {
    const { work, statement } = await seed();
    await db.query(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, fitid, evidence)
       values ($1,$2,1,'2026-09-03','x',-100,'out','F1',$3::jsonb)`,
      [work, statement, ev()],
    );
    await expectReject(
      `insert into transactions(work_id, document_id, seq, date, description, amount_cents, direction, fitid, evidence)
       values ($1,$2,2,'2026-09-03','x',-100,'out','F1',$3::jsonb)`,
      [work, statement, ev()],
      /transactions_fitid_unique/,
    );
  });

  it("rejeita achado sem evidência", async () => {
    const { work } = await seed();
    await expectReject(
      `insert into findings(work_id, type, severity, title, explanation, evidence)
       values ($1,'missing_receipt','medium','t','e','[]'::jsonb)`,
      [work],
      /evidence/,
    );
  });

  it("rejeita achado com diferença incoerente (4.850 − 4.580 ≠ 300)", async () => {
    const { work } = await seed();
    await expectReject(
      `insert into findings(work_id, type, severity, title, explanation, expected_cents, found_cents, diff_cents, evidence)
       values ($1,'amount_divergence','high','t','e',485000,458000,30000,$2::jsonb)`,
      [work, ev()],
      /diff_consistent/,
    );
    await db.query(
      `insert into findings(work_id, type, severity, title, explanation, expected_cents, found_cents, diff_cents, evidence)
       values ($1,'amount_divergence','high','t','e',485000,458000,27000,$2::jsonb)`,
      [work, ev()],
    );
  });

  it("par agrupado/parcial nunca nasce confirmado", async () => {
    const { work, statement } = await seed();
    const tx = (await insertTx(work, statement, 1, -100, "out")).rows[0].id;
    const doc = (
      await db.query(
        `insert into documents(work_id, role, file_name, mime, sha256, size_bytes) values ($1,'supporting','nf.pdf','application/pdf',$2,10) returning id`,
        [work, "b".repeat(64)],
      )
    ).rows[0].id;
    await expectReject(
      `insert into matches(work_id, group_key, transaction_id, document_id, rule, status, score)
       values ($1,'g1',$2,$3,'grouped','confirmed',0.99)`,
      [work, tx, doc],
      /auto_confirm_only_simple_rules/,
    );
    await db.query(
      `insert into matches(work_id, group_key, transaction_id, document_id, rule, status, score)
       values ($1,'g1',$2,$3,'grouped','needs_confirmation',0.99)`,
      [work, tx, doc],
    );
  });

  it("só 1 extrato por trabalho e nenhum arquivo repetido (mesmo hash)", async () => {
    const { work } = await seed();
    await expectReject(
      `insert into documents(work_id, role, file_name, mime, sha256, size_bytes) values ($1,'statement','e2.ofx','x',$2,10)`,
      [work, "c".repeat(64)],
      /one_statement_per_work/,
    );
    await expectReject(
      `insert into documents(work_id, role, file_name, mime, sha256, size_bytes) values ($1,'supporting','copia.ofx','x',$2,10)`,
      [work, "a".repeat(64)],
      /documents_work_id_sha256_key/,
    );
  });

  it("rejeita arquivo acima de 10 MB", async () => {
    const { work } = await seed();
    await expectReject(
      `insert into documents(work_id, role, file_name, mime, sha256, size_bytes) values ($1,'supporting','grande.pdf','application/pdf',$2,10485761)`,
      [work, "d".repeat(64)],
      /size_bytes/,
    );
  });

  it("rejeita evento fora da lista", async () => {
    const { ws } = await seed();
    await expectReject(`insert into events(workspace_id, name) values ($1,'page_view')`, [ws], /name/);
  });

  it("apagar o trabalho apaga tudo que pertence a ele", async () => {
    const { work, ws, statement } = await seed();
    const tx = (await insertTx(work, statement, 1, -100, "out")).rows[0].id;
    await db.query(
      `insert into findings(work_id, type, severity, title, explanation, transaction_id, evidence)
       values ($1,'missing_receipt','medium','t','e',$2,$3::jsonb)`,
      [work, tx, ev()],
    );
    await db.query(`insert into events(workspace_id, work_id, name) values ($1,$2,'work_created')`, [ws, work]);
    await db.query(`delete from works where id=$1`, [work]);
    for (const t of ["documents", "transactions", "findings", "matches", "events"]) {
      const { rows } = await db.query(`select count(*)::int as n from ${t} where work_id=$1`, [work]);
      expect(rows[0].n, t).toBe(0);
    }
  });
});

describe("acesso por papel", () => {
  it("anon não consegue ler; service_role consegue (ignora RLS)", async () => {
    await db.query("begin");
    try {
      await seed();
      await db.query("savepoint sp");
      await db.query("set local role anon");
      await expect(db.query("select * from works")).rejects.toThrow(/permission denied/);
      await db.query("rollback to savepoint sp");
      await db.query("set local role service_role");
      const { rows } = await db.query("select count(*)::int as n from works");
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    } finally {
      await db.query("rollback");
    }
  });
});

