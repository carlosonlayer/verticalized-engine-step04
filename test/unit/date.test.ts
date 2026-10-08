import { describe, expect, it } from "vitest";
import {
  addDays,
  diffDays,
  formatDateBR,
  monthKey,
  parseDateBR,
  parseOfxDate,
  type IsoDate,
} from "../../src/workers/finance-month-close/parsers/date.js";

const ok = (r: ReturnType<typeof parseDateBR>) => {
  if (!r.ok) throw new Error(r.message);
  return r.date;
};
const code = (r: ReturnType<typeof parseDateBR>) => (r.ok ? `OK:${r.date}` : r.code);

describe("parseDateBR — sempre dia/mês/ano", () => {
  it.each([
    ["03/09/2026", "2026-09-03"],
    ["3/9/2026", "2026-09-03"],
    ["03/09/26", "2026-09-03"],
    ["03-09-2026", "2026-09-03"],
    ["03.09.2026", "2026-09-03"],
    ["2026-09-03", "2026-09-03"],
    ["2026-09-03T23:59:59Z", "2026-09-03"],
    ["2026-09-03T00:30:00-03:00", "2026-09-03"],
    ["03 SET 2026", "2026-09-03"],
    ["03/SET/2026", "2026-09-03"],
    ["03SET2026", "2026-09-03"],
    ["03 set 26", "2026-09-03"],
    [" 03/09/2026 ", "2026-09-03"],
  ])("%s → %s", (input, iso) => {
    expect(ok(parseDateBR(input))).toBe(iso);
  });

  it("03/09 NUNCA vira 9 de março", () => {
    expect(ok(parseDateBR("03/09/2026"))).toBe("2026-09-03");
    expect(ok(parseDateBR("09/03/2026"))).toBe("2026-03-09");
  });

  it("formato americano (mês/dia) é recusado, não convertido errado", () => {
    expect(code(parseDateBR("09/30/2026"))).toBe("DATE_INVALID"); // mês 30 não existe
  });

  it("valida o calendário de verdade", () => {
    expect(code(parseDateBR("31/02/2026"))).toBe("DATE_INVALID");
    expect(code(parseDateBR("31/04/2026"))).toBe("DATE_INVALID");
    expect(code(parseDateBR("29/02/2026"))).toBe("DATE_INVALID"); // 2026 não é bissexto
    expect(ok(parseDateBR("29/02/2028"))).toBe("2028-02-29"); // 2028 é
    expect(code(parseDateBR("29/02/2100"))).toBe("DATE_INVALID"); // múltiplo de 100 não é
    expect(code(parseDateBR("00/09/2026"))).toBe("DATE_INVALID");
    expect(code(parseDateBR("15/13/2026"))).toBe("DATE_INVALID");
  });

  it("data sem ano exige ano de referência explícito", () => {
    expect(code(parseDateBR("03/09"))).toBe("DATE_YEAR_MISSING");
    expect(ok(parseDateBR("03/09", { referenceYear: 2026 }))).toBe("2026-09-03");
    expect(code(parseDateBR("03 SET"))).toBe("DATE_YEAR_MISSING");
    expect(ok(parseDateBR("03 SET", { referenceYear: 2026 }))).toBe("2026-09-03");
  });

  it.each([
    ["", "DATE_EMPTY"],
    ["ontem", "DATE_FORMAT"],
    ["03 SEP 2026", "DATE_FORMAT"], // mês em inglês não é aceito
    ["2026/09/03", "DATE_FORMAT"],
    ["03/09/2026 10:00", "DATE_FORMAT"],
  ])("rejeita %j com %s", (input, expected) => {
    expect(code(parseDateBR(input))).toBe(expected);
  });
});

describe("parseOfxDate — usa a data literal, sem converter fuso", () => {
  it.each([
    ["20260903", "2026-09-03"],
    ["20260903120000", "2026-09-03"],
    ["20260903120000.000", "2026-09-03"],
    ["20260903120000[-3:BRT]", "2026-09-03"],
    ["20260903000000[0:GMT]", "2026-09-03"], // converter para Brasília daria 02/09
    ["20260930235959[-3:BRT]", "2026-09-30"],
  ])("%s → %s", (input, iso) => {
    expect(ok(parseOfxDate(input))).toBe(iso);
  });

  it.each([["2026-09-03"], ["03092026"], ["20261301"], ["abc"], [""]])("rejeita %j", (input) => {
    expect(parseOfxDate(input).ok).toBe(false);
  });
});

describe("aritmética de datas (independe do fuso da máquina)", () => {
  const d = (s: string) => s as IsoDate;
  it("diffDays e addDays", () => {
    expect(diffDays(d("2026-09-01"), d("2026-09-30"))).toBe(29);
    expect(diffDays(d("2026-09-30"), d("2026-09-01"))).toBe(-29);
    expect(diffDays(d("2026-02-28"), d("2026-03-01"))).toBe(1);
    expect(diffDays(d("2028-02-28"), d("2028-03-01"))).toBe(2);
    expect(addDays(d("2026-09-30"), 1)).toBe("2026-10-01");
    expect(addDays(d("2026-01-01"), -1)).toBe("2025-12-31");
  });
  it("atravessa o antigo horário de verão brasileiro sem perder dia", () => {
    expect(diffDays(d("2018-11-03"), d("2018-11-05"))).toBe(2);
    expect(addDays(d("2018-11-03"), 1)).toBe("2018-11-04");
  });
  it("monthKey e formatDateBR", () => {
    expect(monthKey(d("2026-09-03"))).toBe("2026-09");
    expect(formatDateBR(d("2026-09-03"))).toBe("03/09/2026");
  });
  it("o resultado não muda com o TZ do processo", () => {
    const before = process.env.TZ;
    for (const tz of ["America/Sao_Paulo", "UTC", "Pacific/Kiritimati", "Etc/GMT+12"]) {
      process.env.TZ = tz;
      expect(ok(parseDateBR("01/09/2026"))).toBe("2026-09-01");
      expect(ok(parseOfxDate("20260901000000[0:GMT]"))).toBe("2026-09-01");
      expect(addDays(d("2026-09-01"), 29)).toBe("2026-09-30");
    }
    process.env.TZ = before;
  });
});
