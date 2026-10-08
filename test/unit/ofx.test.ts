import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatement } from "../../src/workers/finance-month-close/parsers/statement.js";
import type { ParsedStatement, StatementResult } from "../../src/workers/finance-month-close/parsers/types.js";

const FIX = join(import.meta.dirname, "..", "fixtures", "statements");
const load = (f: string) => readFileSync(join(FIX, f));

function okSt(r: StatementResult): ParsedStatement {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.statement;
}
function errCode(r: StatementResult) {
  if (r.ok) throw new Error("esperava erro");
  return r.error;
}

/** Monta um OFX SGML mínimo para casos de borda. */
function ofx(trns: string, extra: { curdef?: string | null; stmt?: string } = {}) {
  const cur = extra.curdef === null ? "" : `<CURDEF>${extra.curdef ?? "BRL"}\n`;
  const stmt =
    extra.stmt ??
    `<STMTRS>\n${cur}<BANKACCTFROM>\n<BANKID>001\n<ACCTID>99887766\n</BANKACCTFROM>\n<BANKTRANLIST>\n<DTSTART>20260901\n<DTEND>20260930\n${trns}\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>100.00\n<DTASOF>20260930\n</LEDGERBAL>\n</STMTRS>`;
  return Buffer.from(`OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n${stmt}\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n`);
}
const trn = (dt: string, amt: string, id: string, memo = "PIX", type = "DEBIT") =>
  `<STMTTRN>\n<TRNTYPE>${type}\n<DTPOSTED>${dt}\n<TRNAMT>${amt}\n<FITID>${id}\n<MEMO>${memo}\n</STMTTRN>`;

describe("OFX 1.x SGML em Windows-1252 (fixture)", () => {
  const st = okSt(parseStatement(load("ofx-sgml-cp1252.ofx")));

  it("identifica formato e codificação", () => {
    expect(st.format).toBe("ofx");
    expect(st.encoding).toBe("windows-1252");
  });
  it("lê as 6 movimentações em centavos inteiros com sinal correto", () => {
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-125000, -4890, 500000, -78000, -485000, -1990]);
    expect(st.transactions.map((t) => t.direction)).toEqual(["out", "out", "in", "out", "out", "out"]);
    for (const t of st.transactions) expect(Number.isSafeInteger(t.amountCents)).toBe(true);
  });
  it("datas literais, mesmo com fuso no OFX", () => {
    expect(st.transactions.map((t) => t.date)).toEqual([
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-10", "2026-09-15", "2026-09-30",
    ]);
  });
  it("acentos e travessão do cp1252 decodificados corretamente", () => {
    expect(st.transactions[1].description).toBe("TARIFA - TARIFA PACOTE SERVIÇOS");
    expect(st.transactions[2].description).toBe("PIX RECEBIDO - CLIENTE ÁGUA AZUL – SERVIÇO");
  });
  it("NAME igual a MEMO não é duplicado na descrição", () => {
    expect(st.transactions[5].description).toBe("IOF");
  });
  it("CPF mascarado na descrição E no trecho de evidência", () => {
    expect(st.transactions[3].description).toBe("PIX ENVIADO - JOAO DA SILVA ***.456.789-**");
    expect(st.transactions[3].source.excerpt).not.toContain("123.456.789-09");
    expect(st.transactions[3].source.excerpt).toContain("***.456.789-**");
  });
  it("conta aparece só com os 4 últimos dígitos", () => {
    expect(st.accountLabel).toBe("Banco 341 · ••3456");
    expect(JSON.stringify(st)).not.toContain("12345-6");
  });
  it("período declarado, saldo final e ausência de saldo inicial (não inventado)", () => {
    expect(st.periodStart).toBe("2026-09-01");
    expect(st.periodEnd).toBe("2026-09-30");
    expect(st.closingBalanceCents).toBe(805120);
    expect(st.closingBalanceDate).toBe("2026-09-30");
    expect(st.openingBalanceCents).toBeNull();
  });
  it("evidência aponta linha real do arquivo e é rastreável", () => {
    const text = load("ofx-sgml-cp1252.ofx").toString("latin1").split(/\r\n/);
    for (const t of st.transactions) {
      expect(text[t.source.line - 1]).toBe("<STMTTRN>");
      expect(t.source.page).toBe(1);
      expect(t.source.excerpt).toContain(`<FITID>${t.fitid}`);
    }
  });
  it("seq contínuo e FITIDs preservados", () => {
    expect(st.transactions.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(st.transactions.map((t) => t.fitid)).toEqual(["OFX001", "OFX002", "OFX003", "OFX004", "OFX005", "OFX006"]);
    expect(st.warnings).toEqual([]);
  });
});

describe("OFX 2.x XML em UTF-8 (fixture)", () => {
  const st = okSt(parseStatement(load("ofx-xml-utf8.ofx")));
  it("lê tags com fechamento e decodifica entidades XML", () => {
    expect(st.encoding).toBe("utf-8");
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-25000, 150050, -9990]);
    expect(st.transactions[0].description).toBe("Compra no débito - Padaria Pão & Café");
    expect(st.closingBalanceCents).toBe(315060);
    expect(st.accountLabel).toBe("Banco 260 · ••5432");
  });
});

describe("OFX — casos de borda", () => {
  it("valor com vírgula decimal (alguns bancos exportam assim)", () => {
    const st = okSt(parseStatement(ofx(trn("20260905", "-35,90", "A1"))));
    expect(st.transactions[0].amountCents).toBe(-3590);
  });

  it("FITID repetido com conteúdo idêntico → cópia removida e registrada", () => {
    const st = okSt(
      parseStatement(ofx([trn("20260905", "-10.00", "F1"), trn("20260905", "-10.00", "F1"), trn("20260906", "-5.00", "F2")].join("\n"))),
    );
    expect(st.transactions).toHaveLength(2);
    expect(st.removedDuplicates).toEqual([{ fitid: "F1", line: expect.any(Number) }]);
    expect(st.transactions.map((t) => t.seq)).toEqual([1, 2]);
    expect(st.warnings.map((w) => w.code)).toContain("FITID_DUPLICATE_REMOVED");
  });

  it("FITID repetido com conteúdo DIFERENTE → nada é removido, FITIDs ignorados", () => {
    const st = okSt(parseStatement(ofx([trn("20260905", "-10.00", "SAME"), trn("20260906", "-20.00", "SAME")].join("\n"))));
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-1000, -2000]);
    expect(st.transactions.every((t) => t.fitid === null)).toBe(true);
    expect(st.warnings.map((w) => w.code)).toContain("FITID_NOT_UNIQUE");
  });

  it("valor zero é ignorado com aviso (não vira movimentação)", () => {
    const st = okSt(parseStatement(ofx([trn("20260905", "0.00", "Z"), trn("20260906", "-1.00", "N")].join("\n"))));
    expect(st.transactions).toHaveLength(1);
    expect(st.warnings.map((w) => w.code)).toContain("ZERO_AMOUNT_SKIPPED");
  });

  it("tipo DEBIT com valor positivo: mantém o sinal do valor e avisa", () => {
    const st = okSt(parseStatement(ofx(trn("20260905", "50.00", "P", "X", "DEBIT"))));
    expect(st.transactions[0].amountCents).toBe(5000);
    expect(st.warnings.map((w) => w.code)).toContain("SIGN_TYPE_MISMATCH");
  });

  it("movimentação fora do período declarado gera aviso", () => {
    const st = okSt(parseStatement(ofx(trn("20261005", "-1.00", "O"))));
    expect(st.warnings.map((w) => w.code)).toContain("OUT_OF_DECLARED_PERIOD");
  });

  it("moeda ausente → assume BRL com aviso; moeda diferente → recusa", () => {
    expect(okSt(parseStatement(ofx(trn("20260905", "-1.00", "A"), { curdef: null }))).warnings.map((w) => w.code)).toContain(
      "CURRENCY_ASSUMED",
    );
    expect(errCode(parseStatement(ofx(trn("20260905", "-1.00", "A"), { curdef: "USD" }))).code).toBe("CURRENCY_NOT_SUPPORTED");
  });

  it("valor inválido → erro com o número da linha (nada é pulado em silêncio)", () => {
    const e = errCode(parseStatement(ofx(trn("20260905", "abc", "A"))));
    expect(e.code).toBe("AMOUNT_INVALID");
    expect(e.line).toBeGreaterThan(0);
  });

  it("data inválida → erro com linha", () => {
    expect(errCode(parseStatement(ofx(trn("20260231", "-1.00", "A")))).code).toBe("DATE_INVALID");
  });

  it("valor com 3 casas decimais → erro (não arredonda)", () => {
    expect(errCode(parseStatement(ofx(trn("20260905", "-1.005", "A")))).code).toBe("AMOUNT_INVALID");
  });

  it("duas contas no mesmo arquivo → recusa", () => {
    const one = `<STMTRS>\n<CURDEF>BRL\n<BANKTRANLIST>\n${trn("20260905", "-1.00", "A")}\n</BANKTRANLIST>\n</STMTRS>`;
    expect(errCode(parseStatement(ofx("", { stmt: one + "\n" + one }))).code).toBe("MULTIPLE_ACCOUNTS");
  });

  it("OFX de cartão de crédito → recusa com mensagem clara", () => {
    const cc = `<CCSTMTRS>\n<CURDEF>BRL\n<BANKTRANLIST>\n${trn("20260905", "-1.00", "A")}\n</BANKTRANLIST>\n</CCSTMTRS>`;
    expect(errCode(parseStatement(ofx("", { stmt: cc }))).code).toBe("CREDIT_CARD_NOT_SUPPORTED");
  });

  it("STMTTRN sem fechamento → arquivo corrompido", () => {
    expect(errCode(parseStatement(ofx(`<STMTTRN>\n<DTPOSTED>20260905\n<TRNAMT>-1.00\n`))).code).toBe("OFX_INVALID");
  });

  it("mês sem movimentação é válido (0 transações)", () => {
    expect(okSt(parseStatement(ofx(""))).transactions).toEqual([]);
  });
});

describe("parseStatement — roteamento e limites", () => {
  it("PDF ainda não é aceito (STEP 11) — mensagem orienta OFX/CSV", () => {
    const e = errCode(parseStatement(Buffer.from("%PDF-1.7\n...")));
    expect(e.code).toBe("STATEMENT_PDF_NOT_YET_SUPPORTED");
    expect(e.message).toMatch(/OFX ou CSV/);
  });
  it("arquivo vazio e binário são recusados", () => {
    expect(errCode(parseStatement(Buffer.alloc(0))).code).toBe("STATEMENT_EMPTY");
    expect(errCode(parseStatement(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).code).toBe("STATEMENT_FORMAT_UNKNOWN");
  });
  it("mais de 300 movimentações → recusa", () => {
    const many = Array.from({ length: 301 }, (_, i) => trn("20260905", "-1.00", `M${i}`)).join("\n");
    expect(errCode(parseStatement(ofx(many))).code).toBe("TOO_MANY_TRANSACTIONS");
  });
  it("300 movimentações exatas são aceitas", () => {
    const many = Array.from({ length: 300 }, (_, i) => trn("20260905", "-1.00", `M${i}`)).join("\n");
    expect(okSt(parseStatement(ofx(many))).transactions).toHaveLength(300);
  });
  it("período acima de 31 dias → recusa; 31 dias exatos → aceita", () => {
    expect(errCode(parseStatement(ofx([trn("20260901", "-1.00", "A"), trn("20261002", "-1.00", "B")].join("\n")))).code).toBe(
      "PERIOD_TOO_LONG",
    );
    expect(okSt(parseStatement(ofx([trn("20260901", "-1.00", "A"), trn("20261001", "-1.00", "B")].join("\n")))).transactions).toHaveLength(2);
  });
});
