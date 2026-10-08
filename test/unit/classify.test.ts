import { describe, expect, it } from "vitest";
import {
  categoryToKind,
  classifyTransaction,
  NOT_REQUIRED_CATEGORIES,
  receiptRequirementOf,
} from "../../src/workers/finance-month-close/statement/classify.js";

const c = (description: string, direction: "in" | "out", bankType: string | null = null) =>
  classifyTransaction({ description, direction, bankType });

describe("K — tarifa", () => {
  it.each([
    ["TARIFA - TARIFA PACOTE SERVICOS", "FEE_TARIFA"],
    ["TARIFA BANCARIA", "FEE_TARIFA"],
    ["TAR PIX ENVIADO", "FEE_TARIFA"],
    ["CESTA DE SERVIÇOS", "FEE_TARIFA"],
    ["JUROS CHEQUE ESPECIAL", "FEE_JUROS_LIMITE"],
    ["ENCARGOS LIMITE", "FEE_JUROS_LIMITE"],
  ])("%s → fee (%s), não exige comprovante", (desc, rule) => {
    const r = c(desc, "out");
    expect(r.category).toBe("fee");
    expect(r.ruleId).toBe(rule);
    expect(r.receiptRequirement).toBe("not_required");
    expect(r.matchedTerm).toBeTruthy();
  });
  it("tipo FEE informado pelo banco (OFX) → fee, mesmo com descrição vaga", () => {
    expect(c("PACOTE MENSAL", "out", "FEE")).toMatchObject({ category: "fee", ruleId: "FEE_BANK_TYPE", matchedTerm: "TRNTYPE=FEE" });
    expect(c("PACOTE MENSAL", "out", "SRVCHG").category).toBe("fee");
  });
  it("'TAXA' genérica NÃO é tarifa bancária (ex.: taxa de condomínio é pagamento)", () => {
    expect(c("PAGTO TAXA CONDOMINIO", "out").category).toBe("regular_payment");
    expect(c("TAXA CONDOMINIO", "out").category).toBe("unknown");
  });
  it("'TAR' solto não basta (precisa ser 'TAR PIX', 'TAR PACOTE'…)", () => {
    expect(c("TAR", "out").category).toBe("unknown");
  });
  it("tarifa como ENTRADA não é tarifa (é estorno ou outra coisa) → nunca 'não exige comprovante' por isso", () => {
    expect(c("TARIFA", "in").category).not.toBe("fee");
  });
});

describe("L — IOF", () => {
  it.each(["IOF", "IOF SOBRE OPERACAO", "IOF ADICIONAL"])("%s → fee", (d) => {
    expect(c(d, "out")).toMatchObject({ category: "fee", ruleId: "FEE_IOF", receiptRequirement: "not_required" });
  });
  it("IOF com tipo FEE do banco: mesma categoria, sem conflito", () => {
    expect(c("IOF", "out", "FEE").category).toBe("fee");
  });
});

describe("M / N — aplicação e resgate", () => {
  it.each([
    ["APLICACAO - APLICACAO CDB DI", "out"],
    ["APLIC AUTOMATICA", "out"],
    ["APLICAÇÃO POUPANÇA", "out"],
    ["RESGATE - RESGATE CDB DI", "in"],
    ["RESG AUTOMATICO", "in"],
    ["RENDIMENTO POUPANCA", "in"],
    ["TESOURO DIRETO", "out"],
  ] as const)("%s (%s) → investment, não exige comprovante", (d, dir) => {
    expect(c(d, dir)).toMatchObject({ category: "investment", receiptRequirement: "not_required" });
  });
  it("'APLICATIVO' não é aplicação (palavra inteira)", () => {
    expect(c("COMPRA APLICATIVO", "out").category).toBe("regular_payment");
  });
  it("rendimento como SAÍDA não é investimento por essa regra", () => {
    expect(c("RENDIMENTO", "out").category).toBe("unknown");
  });
});

describe("O — transferência entre contas próprias", () => {
  it.each(["TRANSF ENTRE CONTAS MESMA TITULARIDADE", "TED MESMO TITULAR", "TRANSFERENCIA CONTA PROPRIA", "PIX CONTAS PROPRIAS"])(
    "%s → own_transfer, não exige comprovante",
    (d) => {
      expect(c(d, "out")).toMatchObject({ category: "own_transfer", ruleId: "OWN_TRANSFER_TERMS", receiptRequirement: "not_required" });
    },
  );
  it("'ENTRE CONTAS' sozinho NÃO basta (pode ser para terceiro no mesmo banco)", () => {
    const r = c("TRANSF ENTRE CONTAS", "out");
    expect(r.category).not.toBe("own_transfer");
    expect(r.receiptRequirement).toBe("required");
  });
  it("entrada de conta própria também é own_transfer", () => {
    expect(c("TED RECEBIDA MESMA TITULARIDADE", "in").category).toBe("own_transfer");
  });
});

describe("saque", () => {
  it.each([["SAQUE ATM", null], ["SAQ BANCO 24H", null], ["RETIRADA CAIXA", null], ["CAIXA ELETRONICO", "ATM"]] as const)(
    "%s → withdrawal, EXIGE comprovante",
    (d, bt) => {
      expect(c(d, "out", bt)).toMatchObject({ category: "withdrawal", receiptRequirement: "required" });
    },
  );
});

describe("P / Q — pagamento e recebimento regulares", () => {
  it.each(["PIX ENVIADO - FORNECEDOR X LTDA", "PAGTO BOLETO - IMOBILIARIA LAR LTDA", "TED 341 FORNECEDOR", "COMPRA CARTAO DEBITO MERCADO", "DEBITO AUTOMATICO LUZ", "PAGAMENTO DE BOLETO"])(
    "%s → regular_payment, exige comprovante",
    (d) => {
      expect(c(d, "out")).toMatchObject({ category: "regular_payment", receiptRequirement: "required" });
    },
  );
  it.each(["PIX RECEBIDO - CLIENTE ALFA LTDA", "TED RECEBIDA EMPRESA", "DEPOSITO EM DINHEIRO", "CREDITO CIELO", "VENDAS CARTAO"])(
    "%s → regular_receipt, documento opcional",
    (d) => {
      expect(c(d, "in")).toMatchObject({ category: "regular_receipt", receiptRequirement: "optional" });
    },
  );
});

describe("R — unknown conservador", () => {
  it.each([["XPTO 123", "out"], ["MOVIMENTACAO DIVERSA", "out"], ["", "out"]] as const)("%j → unknown; saída EXIGE comprovante", (d, dir) => {
    const r = c(d, dir);
    expect(r).toMatchObject({ category: "unknown", receiptRequirement: "required", ruleId: null });
  });
  it("entrada desconhecida → unknown, documento opcional", () => {
    expect(c("XPTO 123", "in")).toMatchObject({ category: "unknown", receiptRequirement: "optional" });
  });
  it.each(["ESTORNO TARIFA", "DEVOLUCAO PIX", "PIX ENVIADO CANCELADO", "ESTORNO IOF"])("estorno/devolução %s → unknown (nunca 'não exige comprovante')", (d) => {
    for (const dir of ["in", "out"] as const) {
      const r = c(d, dir);
      expect(r.category).toBe("unknown");
      expect(r.receiptRequirement).not.toBe("not_required");
    }
  });
  it("regras de categorias diferentes ao mesmo tempo → unknown (não escolhe uma)", () => {
    const r = c("TARIFA APLICACAO CDB", "out");
    expect(r.category).toBe("unknown");
    expect(r.reason).toMatch(/conflitantes/);
    expect(r.receiptRequirement).toBe("required");
  });
  it("saque com tipo FEE do banco é conflito → unknown", () => {
    expect(c("SAQUE", "out", "FEE").category).toBe("unknown");
  });
});

describe("regra 'não exige comprovante'", () => {
  it("só fee, investment e own_transfer", () => {
    expect([...NOT_REQUIRED_CATEGORIES].sort()).toEqual(["fee", "investment", "own_transfer"]);
  });
  it.each(["withdrawal", "regular_payment", "unknown"] as const)("%s em saída sempre exige", (cat) => {
    expect(receiptRequirementOf(cat, "out")).toBe("required");
  });
  it("toda classificação 'not_required' tem regra e termo de evidência", () => {
    for (const d of ["TARIFA", "IOF", "APLICACAO", "RESGATE", "MESMA TITULARIDADE"]) {
      for (const dir of ["in", "out"] as const) {
        const r = c(d, dir);
        if (r.receiptRequirement === "not_required") {
          expect(r.ruleId).not.toBeNull();
          expect(r.matchedTerm).not.toBeNull();
        }
      }
    }
  });
});

describe("compatibilidade com o contrato (kind)", () => {
  it.each([
    ["fee", "fee"], ["investment", "investment"], ["own_transfer", "own_transfer"],
    ["withdrawal", "normal"], ["regular_payment", "normal"], ["regular_receipt", "normal"], ["unknown", "normal"],
  ] as const)("%s → kind %s", (cat, kind) => {
    expect(categoryToKind(cat)).toBe(kind);
  });
  it("acentos e maiúsculas não mudam o resultado", () => {
    expect(c("Aplicação poupança", "out").category).toBe("investment");
    expect(c("tarifa pacote serviços", "out").category).toBe("fee");
  });
});
