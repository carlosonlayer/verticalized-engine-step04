import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHeader,
  detectDelimiter,
  splitCsv,
} from "../../src/workers/finance-month-close/parsers/csv.js";
import { parseStatement } from "../../src/workers/finance-month-close/parsers/statement.js";
import type { ParsedStatement, StatementResult } from "../../src/workers/finance-month-close/parsers/types.js";

const FIX = join(import.meta.dirname, "..", "fixtures", "statements");
const load = (f: string) => readFileSync(join(FIX, f));
const csv = (s: string) => Buffer.from(s, "utf8");

function okSt(r: StatementResult): ParsedStatement {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.statement;
}
function errOf(r: StatementResult) {
  if (r.ok) throw new Error("esperava erro");
  return r.error;
}

describe("CSV banco tradicional (cp1252, ';', preâmbulo, saldo)", () => {
  const st = okSt(parseStatement(load("csv-tradicional-cp1252.csv")));

  it("encontra o cabeçalho depois do preâmbulo e lê 6 movimentações", () => {
    expect(st.format).toBe("csv");
    expect(st.encoding).toBe("windows-1252");
    expect(st.transactions).toHaveLength(6);
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-125000, -4890, 500000, -78000, -485000, -1990]);
  });
  it("mesmo resultado financeiro do OFX equivalente", () => {
    const ofx = okSt(parseStatement(load("ofx-sgml-cp1252.ofx")));
    expect(st.transactions.map((t) => [t.date, t.amountCents])).toEqual(ofx.transactions.map((t) => [t.date, t.amountCents]));
  });
  it("SALDO ANTERIOR vira saldo inicial; SALDO DO DIA e rodapé não viram movimentação", () => {
    expect(st.openingBalanceCents).toBe(1000000);
    expect(st.warnings.map((w) => w.code).sort()).toEqual(["BALANCE_ROW_SKIPPED", "FOOTER_ROW_SKIPPED"]);
  });
  it("saldo por linha preservado e coerente (saldo anterior + soma = saldo da linha)", () => {
    let running = st.openingBalanceCents!;
    for (const t of st.transactions) {
      running += t.amountCents;
      expect(t.balanceAfterCents).toBe(running);
    }
  });
  it("';' dentro de aspas não quebra a coluna", () => {
    expect(st.transactions[4].description).toBe("PAGTO BOLETO CONSTRUÇÃO; MATERIAIS");
  });
  it("evidência aponta a linha física do arquivo", () => {
    const lines = load("csv-tradicional-cp1252.csv").toString("latin1").split("\r\n");
    for (const t of st.transactions) expect(lines[t.source.line - 1]).toContain(t.date.split("-").reverse().join("/"));
  });
});

describe("CSV banco digital (UTF-8, ',', ponto decimal, identificador)", () => {
  const st = okSt(parseStatement(load("csv-digital-utf8.csv")));
  it("detecta vírgula como separador e ponto como decimal", () => {
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-25000, 320000, -123456, -8990]);
  });
  it("vírgula dentro de aspas na descrição", () => {
    expect(st.transactions[2].description).toBe("Pagamento de boleto efetuado - LUZ, ÁGUA E CIA");
  });
  it("coluna Identificador vira fitid", () => {
    expect(st.transactions.map((t) => t.fitid)).toEqual(["6a1f0c2e-0001", "6a1f0c2e-0002", "6a1f0c2e-0003", "6a1f0c2e-0004"]);
  });
});

describe("CSV com Débito e Crédito em colunas separadas (UTF-8 com BOM)", () => {
  const st = okSt(parseStatement(load("csv-debito-credito-bom.csv")));
  it("débito vira negativo, crédito positivo; BOM não atrapalha o cabeçalho", () => {
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-150000, 300000, -1250]);
    expect(st.openingBalanceCents).toBe(200000);
    expect(st.transactions.map((t) => t.balanceAfterCents)).toEqual([50000, 350000, 348750]);
  });
});

describe("CSV — casos de borda", () => {
  it("coluna 'Tipo' com D/C define o sinal", () => {
    const st = okSt(parseStatement(csv("Data;Descrição;Valor;Tipo\n01/09/2026;ALUGUEL;1.500,00;D\n02/09/2026;VENDA;300,00;C\n")));
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-150000, 30000]);
  });

  it("coluna 'Tipo' que não é D/C (ex.: PIX/TED) é ignorada com aviso", () => {
    const st = okSt(parseStatement(csv("Data;Descrição;Valor;Tipo\n01/09/2026;ALUGUEL;-1.500,00;PIX\n02/09/2026;VENDA;300,00;TED\n")));
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-150000, 30000]);
    expect(st.warnings.map((w) => w.code)).toContain("TYPE_COLUMN_IGNORED");
  });

  it("todos os valores positivos sem indicação de tipo → recusa (não chuta o que é saída)", () => {
    expect(errOf(parseStatement(csv("Data;Descrição;Valor\n01/09/2026;A;100,00\n02/09/2026;B;50,00\n"))).code).toBe("CSV_SIGN_UNKNOWN");
  });

  it("mistura de vírgula e ponto decimal no mesmo arquivo → recusa", () => {
    expect(errOf(parseStatement(csv("Data;Descrição;Valor\n01/09/2026;A;-100,00\n02/09/2026;B;-50.00\n"))).code).toBe(
      "CSV_AMBIGUOUS_NUMBER_FORMAT",
    );
  });

  it("data em formato americano → erro com a linha (não converte errado)", () => {
    const e = errOf(parseStatement(csv("Data;Descrição;Valor\n09/30/2026;A;-100,00\n")));
    expect(e.code).toBe("ROW_INVALID");
    expect(e.line).toBe(2);
  });

  it("valor inválido → erro com a linha", () => {
    const e = errOf(parseStatement(csv("Data;Descrição;Valor\n01/09/2026;A;-100,00\n02/09/2026;B;cem reais\n")));
    expect(e.code).toBe("AMOUNT_INVALID");
    expect(e.line).toBe(3);
  });

  it("débito e crédito na mesma linha → erro", () => {
    expect(errOf(parseStatement(csv("Data;Histórico;Débito;Crédito\n01/09/2026;X;10,00;20,00\n"))).code).toBe("ROW_INVALID");
  });

  it("colunas desconhecidas → CSV_COLUMNS_UNKNOWN com amostra MASCARADA (para o STEP 05)", () => {
    const e = errOf(parseStatement(csv("Quando;O quê;Quanto\n01/09/2026;PIX JOAO 123.456.789-09;-10,00\n")));
    expect(e.code).toBe("CSV_COLUMNS_UNKNOWN");
    expect(e.sample).toBeDefined();
    expect(JSON.stringify(e.sample)).not.toContain("123.456.789-09");
  });

  it("mapeamento explícito (ex.: sugerido pelo Gemini) é validado e aplicado por código", () => {
    const body = csv("Quando;O quê;Quanto\n01/09/2026;PIX;-10,00\n02/09/2026;VENDA;25,50\n");
    const st = okSt(parseStatement(body, { csvMapping: { headerRow: 0, date: 0, description: 1, amount: 2 } }));
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-1000, 2550]);
  });

  it.each([
    [{ headerRow: 0, date: 0, description: 0, amount: 2 }, /mais de um papel/],
    [{ headerRow: 0, date: 0, description: 1, amount: 9 }, /fora do arquivo/],
    [{ headerRow: 0, date: 0, description: 1 }, /UMA forma de valor/],
    [{ headerRow: 0, date: 0, description: 1, amount: 2, debit: 2 }, /mais de um papel|UMA forma/],
  ])("mapeamento inválido é recusado: %j", (mapping, msg) => {
    const e = errOf(parseStatement(csv("a;b;c\n01/09/2026;X;-1,00\n"), { csvMapping: mapping }));
    expect(e.code).toBe("CSV_MAPPING_INVALID");
    expect(e.message).toMatch(msg);
  });

  it("FITID repetido idêntico é removido também no CSV", () => {
    const st = okSt(
      parseStatement(csv("Data,Valor,Identificador,Descrição\n05/09/2026,-1.00,ID1,A\n05/09/2026,-1.00,ID1,A\n06/09/2026,-2.00,ID2,B\n")),
    );
    expect(st.transactions).toHaveLength(2);
    expect(st.removedDuplicates).toHaveLength(1);
  });

  it("CSV vazio ou só com linhas em branco", () => {
    expect(errOf(parseStatement(csv("\n\n  \n"))).code).toBe("CSV_EMPTY");
  });
});

describe("CSV de baixo nível", () => {
  it("detecta o separador mais consistente", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter('Data;Desc;Valor\n01/09/2026;"A, B";-1,00\n')).toBe(";");
  });
  it("aspas escapadas, quebra de linha dentro de aspas e número da linha", () => {
    const rows = splitCsv('a;b\n"x ""y""";"linha1\nlinha2"\nfim;z\n', ";");
    expect(rows[1].cells).toEqual(['x "y"', "linha1\nlinha2"]);
    expect(rows[1].line).toBe(2);
    expect(rows[2].line).toBe(4); // a linha 3 foi consumida dentro das aspas
  });
  it.each([
    ["Data", "date"], ["Data Lançamento", "date"], ["Lançamento", "description"], ["Histórico", "description"],
    ["Descrição", "description"], ["Valor (R$)", "amount"], ["Valor", "amount"], ["Débito", "debit"],
    ["Valor Débito", "debit"], ["Crédito", "credit"], ["Saldo (R$)", "balance"], ["Tipo", "type"], ["D/C", "type"],
    ["Identificador", "id"], ["Ag./Origem", null],
  ])("classifica cabeçalho %j como %s", (h, role) => {
    expect(classifyHeader(h)).toBe(role);
  });
});
