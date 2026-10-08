import { describe, expect, it } from "vitest";
import { MAX_ABS_CENTS, formatCents, parseMoney, type DecimalMode } from "../../src/workers/finance-month-close/parsers/money.js";

const ok = (input: string, mode: DecimalMode = ",") => {
  const r = parseMoney(input, mode);
  if (!r.ok) throw new Error(`esperava sucesso para "${input}": ${r.message}`);
  return r.cents;
};
const code = (input: string, mode: DecimalMode = ",") => {
  const r = parseMoney(input, mode);
  if (r.ok) throw new Error(`esperava erro para "${input}", veio ${r.cents}`);
  return r.code;
};

describe("parseMoney — formato brasileiro (modo ',')", () => {
  it.each([
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["0,01", 1],
    ["0,10", 10],
    ["0,1", 10],
    ["10", 1000],
    ["1.000.000,00", 100000000],
    ["R$ 1.234,56", 123456],
    ["R$1.234,56", 123456],
    ["  R$ 50,00  ", 5000],
    ["50,00 BRL", 5000],
    ["4.850,00", 485000],
    ["4.580,00", 458000],
  ])("%s → %i centavos", (input, cents) => {
    expect(ok(input)).toBe(cents);
  });

  it.each([
    ["-1.234,56", -123456],
    ["1.234,56-", -123456], // sinal no fim (comum em extrato)
    ["(1.234,56)", -123456], // contabilidade
    ["1.234,56 D", -123456],
    ["1.234,56D", -123456],
    ["D 1.234,56", -123456],
    ["1.234,56 C", 123456],
    ["+1.234,56", 123456],
    ["- R$ 50,00", -5000],
    ["R$ -50,00", -5000],
    ["−50,00", -5000], // sinal de menos tipográfico (U+2212)
    ["–50,00", -5000], // travessão (U+2013)
    ["1 234,56", 123456], // espaço não separável
  ])("sinal e símbolos: %s → %i", (input, cents) => {
    expect(ok(input)).toBe(cents);
  });

  it("zero negativo vira zero", () => {
    expect(ok("-0,00")).toBe(0);
    expect(Object.is(ok("-0,00"), -0)).toBe(false);
  });

  it.each([
    ["", "MONEY_EMPTY"],
    ["   ", "MONEY_EMPTY"],
    ["R$", "MONEY_EMPTY"],
    ["abc", "MONEY_FORMAT"],
    ["1,234,56", "MONEY_FORMAT"],
    ["12.34,56", "MONEY_FORMAT"], // milhar mal posicionado
    ["1234.56", "MONEY_FORMAT"], // ponto decimal no modo vírgula = erro, não chute
    ["1,", "MONEY_FORMAT"],
    [",50", "MONEY_FORMAT"],
    ["1,234", "MONEY_PRECISION"], // 3 casas decimais não são arredondadas
    ["10,999", "MONEY_PRECISION"],
    ["--10,00", "MONEY_SIGN_CONFLICT"],
    ["-10,00 C", "MONEY_SIGN_CONFLICT"],
    ["(10,00)-", "MONEY_SIGN_CONFLICT"],
    ["999.999.999.999,99", "MONEY_TOO_LARGE"],
  ])("rejeita %j com %s", (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it("aceita null/undefined como vazio", () => {
    expect(parseMoney(null).ok).toBe(false);
    expect(parseMoney(undefined).ok).toBe(false);
  });
});

describe("parseMoney — modo '.' (OFX, bancos digitais)", () => {
  it.each([
    ["-250.00", -25000],
    ["1500.5", 150050],
    ["1,234.56", 123456],
    ["0.01", 1],
    ["99.90", 9990],
  ])("%s → %i", (input, cents) => {
    expect(ok(input, ".")).toBe(cents);
  });
  it("rejeita vírgula decimal no modo ponto", () => {
    expect(code("1234,56", ".")).toBe("MONEY_FORMAT");
  });
});

describe("parseMoney — modo 'auto'", () => {
  it("decide pelo último separador quando há os dois", () => {
    expect(ok("1.234,56", "auto")).toBe(123456);
    expect(ok("1,234.56", "auto")).toBe(123456);
  });
  it("um separador com 1–2 casas = decimal", () => {
    expect(ok("12,5", "auto")).toBe(1250);
    expect(ok("12.50", "auto")).toBe(1250);
  });
  it("vários separadores iguais = milhar", () => {
    expect(ok("1.234.567", "auto")).toBe(123456700);
  });
  it("'1.234' é ambíguo → erro, nunca chute", () => {
    expect(code("1.234", "auto")).toBe("MONEY_AMBIGUOUS");
    expect(code("1,234", "auto")).toBe("MONEY_AMBIGUOUS");
  });
});

describe("parseMoney — precisão (sem float)", () => {
  it("casos clássicos de erro de ponto flutuante dão centavos exatos", () => {
    // 0.1 + 0.2 em float = 0.30000000000000004; aqui é texto → dígitos
    expect(ok("0,10") + ok("0,20")).toBe(30);
    expect(ok("1.005,00")).toBe(100500);
    expect(ok("4,35")).toBe(435); // 4.35*100 em float = 434.99999999999994
    expect(ok("1,15")).toBe(115); // 1.15*100 = 114.99999999999999
    expect(ok("9.007.199.254,74")).toBe(900719925474);
  });

  it("todo resultado é inteiro seguro", () => {
    for (const s of ["0,01", "1,15", "4,35", "123.456.789,99", "-0,07"]) {
      expect(Number.isSafeInteger(ok(s))).toBe(true);
    }
  });

  it("limite máximo exato é aceito; um centavo a mais não", () => {
    const max = formatCents(MAX_ABS_CENTS, { symbol: false });
    expect(ok(max)).toBe(MAX_ABS_CENTS);
    expect(code(formatCents(MAX_ABS_CENTS + 1, { symbol: false }))).toBe("MONEY_TOO_LARGE");
  });
});

describe("formatCents", () => {
  it.each([
    [0, "R$ 0,00"],
    [1, "R$ 0,01"],
    [10, "R$ 0,10"],
    [123456, "R$ 1.234,56"],
    [-485000, "-R$ 4.850,00"],
    [100000000, "R$ 1.000.000,00"],
  ])("%i → %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it("recusa número que não é centavo inteiro", () => {
    expect(() => formatCents(1.5)).toThrow();
  });

  it("ida e volta (format → parse) é exata em 20.000 valores", () => {
    // gerador determinístico (sem Math.random): mesma sequência em toda execução
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 20000; i++) {
      const cents = (next() % 2_000_000_00) - 1_000_000_00;
      expect(parseMoney(formatCents(cents)).ok && (parseMoney(formatCents(cents)) as { cents: number }).cents).toBe(
        cents,
      );
    }
  });
});
