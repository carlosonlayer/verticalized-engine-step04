/**
 * Datas de calendário SEM fuso horário.
 *
 * Por que: uma movimentação de "03/09/2026" é do dia 3 de setembro no banco, ponto.
 * Se convertêssemos para Date/UTC, "03/09 00:00 em Brasília" poderia virar "02/09" em
 * outro fuso. Então datas de negócio são strings "AAAA-MM-DD" (IsoDate) do começo ao fim,
 * e a aritmética de dias é feita em UTC puro, onde não existe horário de verão.
 *
 * Ordem: SEMPRE dia/mês/ano (padrão brasileiro). Formato americano (mês/dia) não é aceito;
 * "09/30/2026" dá erro (mês 30), em vez de virar uma data errada.
 */

export type IsoDate = string & { readonly __isoDate: unique symbol };

export type DateErrorCode = "DATE_EMPTY" | "DATE_FORMAT" | "DATE_INVALID" | "DATE_YEAR_MISSING";

export type DateResult = { ok: true; date: IsoDate } | { ok: false; code: DateErrorCode; message: string };

const MONTHS_PT: Record<string, number> = {
  JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
};

const fail = (code: DateErrorCode, message: string): DateResult => ({ ok: false, code, message });

export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function isLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function makeIsoDate(year: number, month: number, day: number): DateResult {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return fail("DATE_INVALID", `Ano inválido: ${year}.`);
  if (!Number.isInteger(month) || month < 1 || month > 12) return fail("DATE_INVALID", `Mês inválido: ${month}.`);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    return fail("DATE_INVALID", `Dia inválido: ${day}/${month}/${year}.`);
  }
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as IsoDate;
  return { ok: true, date: iso };
}

/**
 * Data brasileira → IsoDate.
 * Aceita: 03/09/2026, 3/9/2026, 03/09/26, 03-09-2026, 03.09.2026, 2026-09-03,
 *         03/09 (exige referenceYear), 03 SET, 03/SET/2026, 03SET2026.
 */
export function parseDateBR(input: string | null | undefined, opts: { referenceYear?: number } = {}): DateResult {
  if (input == null) return fail("DATE_EMPTY", "Data vazia.");
  const s = String(input).replace(/ /g, " ").trim().toUpperCase();
  if (s === "") return fail("DATE_EMPTY", "Data vazia.");

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) return makeIsoDate(+m[1], +m[2], +m[3]); // ISO: usa a data literal, ignora horário/fuso

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
  if (m) return makeIsoDate(fullYear(m[3]), +m[2], +m[1]);

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/);
  if (m) {
    if (!opts.referenceYear) return fail("DATE_YEAR_MISSING", `Data sem ano: "${input}".`);
    return makeIsoDate(opts.referenceYear, +m[2], +m[1]);
  }

  m = s.match(/^(\d{1,2})[\s/.-]?([A-Z]{3})(?:[\s/.-]?(\d{4}|\d{2}))?$/);
  if (m) {
    const month = MONTHS_PT[m[2]];
    if (!month) return fail("DATE_FORMAT", `Mês não reconhecido: "${input}".`);
    const year = m[3] ? fullYear(m[3]) : opts.referenceYear;
    if (!year) return fail("DATE_YEAR_MISSING", `Data sem ano: "${input}".`);
    return makeIsoDate(year, month, +m[1]);
  }

  return fail("DATE_FORMAT", `Formato de data não reconhecido: "${input}".`);
}

/** Ano com 2 dígitos → 20xx. Documentado em DECISIONS.md. */
function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

/**
 * Data OFX ("20260903", "20260903120000", "20260903120000.000[-3:BRT]") → IsoDate.
 * Usa os 8 primeiros dígitos LITERAIS. Não convertemos fuso: o banco já informa a data
 * do lançamento; converter "20260903000000[0:GMT]" para Brasília viraria 02/09.
 */
export function parseOfxDate(input: string | null | undefined): DateResult {
  if (input == null || String(input).trim() === "") return fail("DATE_EMPTY", "Data vazia.");
  const m = String(input).trim().match(/^(\d{4})(\d{2})(\d{2})(?:\d{0,6})(?:\.\d+)?(?:\[[^\]]*\])?$/);
  if (!m) return fail("DATE_FORMAT", `Data OFX não reconhecida: "${input}".`);
  return makeIsoDate(+m[1], +m[2], +m[3]);
}

// ---------- aritmética de datas (UTC puro, sem horário de verão) ----------

function toUtcMs(d: IsoDate): number {
  const [y, mo, da] = d.split("-").map(Number);
  return Date.UTC(y, mo - 1, da);
}

/** b − a em dias inteiros. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const dt = new Date(toUtcMs(d) + n * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}` as IsoDate;
}

export function monthKey(d: IsoDate): string {
  return d.slice(0, 7);
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "2026-09-03" → "03/09/2026" (para mensagens e planilhas). */
export function formatDateBR(d: IsoDate): string {
  const [y, m, da] = d.split("-");
  return `${da}/${m}/${y}`;
}
