/**
 * Dinheiro: texto → centavos inteiros. Determinístico, sem float, sem arredondamento.
 *
 * Regras:
 *  - O resultado é SEMPRE um inteiro de centavos (Number.isSafeInteger). Saída = negativo.
 *  - Nunca usamos parseFloat/Number() em valores com casas decimais: a conversão é feita
 *    por manipulação de dígitos (string → BigInt), então "0,10" é exatamente 10 centavos.
 *  - Mais de 2 casas decimais → ERRO (não arredondamos dinheiro de ninguém em silêncio).
 *  - Formato ambíguo ("1.234" sem saber o separador decimal) → ERRO, nunca chute.
 *
 * Formatos aceitos: "1.234,56", "1234,56", "R$ 1.234,56", "-1.234,56", "1.234,56-",
 * "(1.234,56)", "1.234,56 D", "1.234,56 C", "+50,00", "- R$ 50,00", "-50.00" (modo '.').
 */

export type DecimalMode = "," | "." | "auto";

export type MoneyErrorCode =
  | "MONEY_EMPTY"
  | "MONEY_FORMAT"
  | "MONEY_AMBIGUOUS"
  | "MONEY_PRECISION"
  | "MONEY_SIGN_CONFLICT"
  | "MONEY_TOO_LARGE";

export type MoneyResult =
  | { ok: true; cents: number }
  | { ok: false; code: MoneyErrorCode; message: string };

/** Limite de sanidade: R$ 100 bilhões. Muito abaixo de Number.MAX_SAFE_INTEGER. */
export const MAX_ABS_CENTS = 10_000_000_000_000;

const fail = (code: MoneyErrorCode, message: string): MoneyResult => ({ ok: false, code, message });

export function parseMoney(input: string | null | undefined, mode: DecimalMode = ","): MoneyResult {
  if (input == null) return fail("MONEY_EMPTY", "Valor vazio.");
  let s = String(input)
    .replace(/[   ]/g, " ") // espaços "invisíveis" que bancos colocam
    .replace(/[−‒–—]/g, "-") // sinais de menos tipográficos
    .trim()
    .toUpperCase();
  if (s === "") return fail("MONEY_EMPTY", "Valor vazio.");

  s = s.replace(/R\$/g, "").replace(/\bBRL\b/g, "").replace(/\s+/g, "");
  if (s === "") return fail("MONEY_EMPTY", "Valor vazio.");

  // --- marcadores de sinal ---
  // Remove marcadores em qualquer ordem: (…), D/C, +/- no começo ou no fim.
  // Cada marcador encontrado é contado; mais de um = conflito (nunca escolhemos um deles).
  let negMarks = 0;
  let posMarks = 0;
  for (let changed = true; changed; ) {
    changed = false;
    let m: RegExpMatchArray | null;
    if (/^\(.*\)$/.test(s)) {
      negMarks++;
      s = s.slice(1, -1);
      changed = true;
    }
    if ((m = s.match(/^(.*\d)([DC])$/))) {
      m[2] === "D" ? negMarks++ : posMarks++;
      s = m[1];
      changed = true;
    } else if ((m = s.match(/^([DC])(\d.*)$/))) {
      m[1] === "D" ? negMarks++ : posMarks++;
      s = m[2];
      changed = true;
    }
    if (/^[+-]/.test(s)) {
      s[0] === "-" ? negMarks++ : posMarks++;
      s = s.slice(1);
      changed = true;
    }
    if (/[+-]$/.test(s)) {
      s.endsWith("-") ? negMarks++ : posMarks++;
      s = s.slice(0, -1);
      changed = true;
    }
  }
  if (negMarks > 1 || (negMarks > 0 && posMarks > 0) || posMarks > 1) {
    return fail("MONEY_SIGN_CONFLICT", `Sinal contraditório em "${input}".`);
  }
  const negative = negMarks === 1;

  if (!/^\d[\d.,]*$/.test(s)) return fail("MONEY_FORMAT", `Formato de valor não reconhecido: "${input}".`);

  // --- separador decimal ---
  const resolved = resolveDecimal(s, mode);
  if (!resolved.ok) return fail(resolved.code, resolved.message.replace("%s", String(input)));
  const { intDigits, fracDigits } = resolved;

  if (fracDigits.length > 2) {
    return fail("MONEY_PRECISION", `Valor com mais de 2 casas decimais: "${input}". Não arredondamos.`);
  }
  const big = BigInt(intDigits || "0") * 100n + BigInt((fracDigits + "00").slice(0, 2));
  if (big > BigInt(MAX_ABS_CENTS)) return fail("MONEY_TOO_LARGE", `Valor fora do limite: "${input}".`);

  const cents = Number(big);
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

type Resolved =
  | { ok: true; intDigits: string; fracDigits: string }
  | { ok: false; code: MoneyErrorCode; message: string };

function resolveDecimal(s: string, mode: DecimalMode): Resolved {
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  let dec: "," | "." | null;
  if (mode !== "auto") {
    dec = mode;
  } else if (hasComma && hasDot) {
    dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const parts = s.split(sep);
    if (parts.length === 2 && parts[1].length === 3) {
      return { ok: false, code: "MONEY_AMBIGUOUS", message: 'Valor ambíguo: "%s" (milhar ou decimal?).' };
    }
    dec = parts.length === 2 ? sep : null; // várias ocorrências = separador de milhar
    if (dec === null) return splitThousands(s, sep, "");
  } else {
    dec = null;
  }

  if (dec === null) return { ok: true, intDigits: s, fracDigits: "" };

  const thousands = dec === "," ? "." : ",";
  const idx = s.lastIndexOf(dec);
  if (s.indexOf(dec) !== idx) {
    return { ok: false, code: "MONEY_FORMAT", message: 'Mais de um separador decimal em "%s".' };
  }
  const intPart = idx === -1 ? s : s.slice(0, idx);
  const fracPart = idx === -1 ? "" : s.slice(idx + 1);
  if (idx !== -1 && fracPart === "") {
    return { ok: false, code: "MONEY_FORMAT", message: 'Separador decimal sem casas em "%s".' };
  }
  if (!/^\d*$/.test(fracPart)) {
    return { ok: false, code: "MONEY_FORMAT", message: 'Formato de valor não reconhecido: "%s".' };
  }
  return splitThousands(intPart, thousands, fracPart);
}

function splitThousands(intPart: string, sep: string, fracPart: string): Resolved {
  if (intPart === "") return { ok: false, code: "MONEY_FORMAT", message: 'Valor sem parte inteira: "%s".' };
  if (intPart.includes(sep)) {
    const groups = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`);
    if (!groups.test(intPart)) {
      return { ok: false, code: "MONEY_FORMAT", message: 'Separador de milhar mal posicionado em "%s".' };
    }
  }
  const digits = intPart.split(sep).join("");
  if (!/^\d+$/.test(digits)) return { ok: false, code: "MONEY_FORMAT", message: 'Formato de valor não reconhecido: "%s".' };
  return { ok: true, intDigits: digits, fracDigits: fracPart };
}

/** Centavos → "R$ 1.234,56" / "-R$ 1.234,56". Sem Intl (resultado idêntico em qualquer máquina). */
export function formatCents(cents: number, opts: { symbol?: boolean } = {}): string {
  if (!Number.isSafeInteger(cents)) throw new TypeError(`centavos inválidos: ${cents}`);
  const symbol = opts.symbol ?? true;
  const neg = cents < 0;
  const digits = Math.abs(cents).toString().padStart(3, "0");
  const intPart = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const body = `${intPart},${digits.slice(-2)}`;
  return `${neg ? "-" : ""}${symbol ? "R$ " : ""}${body}`;
}

export function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_ABS_CENTS;
}
