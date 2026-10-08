import { maskSensitive } from "../../../lib/mask.js";
import { parseDateBR } from "./date.js";
import { applyFitidRules } from "./fitid.js";
import { parseMoney } from "./money.js";
import {
  clipExcerpt,
  type ParsedStatement,
  type ParsedTransaction,
  type ParseWarning,
  type StatementErrorCode,
  type StatementResult,
} from "./types.js";

/**
 * Leitor de CSV de extrato — determinístico.
 *
 * Detecta sozinho: separador (; , tab |), linha de cabeçalho (mesmo com linhas de
 * "preâmbulo" antes), colunas (por sinônimos em português/inglês) e o formato decimal do
 * arquivo inteiro (vírgula ou ponto).
 *
 * Quando não reconhece as colunas, devolve CSV_COLUMNS_UNKNOWN com uma amostra mascarada.
 * No STEP 05 o Gemini poderá SUGERIR um mapeamento de colunas — que entra aqui como
 * `mapping` e é validado por código. A conversão de valores continua sempre aqui.
 */

export type CsvRole = "date" | "description" | "amount" | "debit" | "credit" | "balance" | "type" | "id";

export type CsvColumnMapping = {
  /** índice (0-based, entre as linhas não vazias) da linha de cabeçalho; -1 se não houver. */
  headerRow: number;
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  balance?: number;
  type?: number;
  id?: number;
};

type Row = { cells: string[]; line: number; raw: string };

const HEADER_SEARCH_ROWS = 15;

export function parseCsv(
  text: string,
  encoding: ParsedStatement["encoding"],
  opts: { mapping?: CsvColumnMapping } = {},
): StatementResult {
  const delimiter = detectDelimiter(text);
  const rows = splitCsv(text, delimiter).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (rows.length === 0) return err("CSV_EMPTY", "O arquivo CSV está vazio.");

  // ---------- colunas ----------
  let mapping: CsvColumnMapping;
  if (opts.mapping) {
    const v = validateMapping(opts.mapping, rows);
    if (v) return err("CSV_MAPPING_INVALID", v);
    mapping = opts.mapping;
  } else {
    const detected = detectMapping(rows);
    if (!detected) {
      return {
        ok: false,
        error: {
          code: "CSV_COLUMNS_UNKNOWN",
          message: "Não reconhecemos as colunas deste CSV (data, descrição e valor).",
          sample: rows.slice(0, 6).map((r) => r.cells.map((c) => maskSensitive(c.trim()))),
        },
      };
    }
    mapping = detected;
  }

  const warnings: ParseWarning[] = [];
  const dataRows = rows.slice(mapping.headerRow + 1);

  // ---------- formato decimal do arquivo inteiro ----------
  const moneyCols = [mapping.amount, mapping.debit, mapping.credit, mapping.balance].filter(
    (c): c is number => c !== undefined,
  );
  const decimal = detectDecimal(dataRows, moneyCols);
  if (decimal === "mixed") {
    return err(
      "CSV_AMBIGUOUS_NUMBER_FORMAT",
      "O arquivo mistura valores com vírgula e com ponto decimal. Não dá para converter com segurança.",
    );
  }

  // ---------- linhas ----------
  const txs: ParsedTransaction[] = [];
  let opening: number | null = null;
  let closing: number | null = null;
  let typeColUsable = mapping.type !== undefined;

  if (typeColUsable) {
    // "tipo" só vale como sinal se os valores forem do tipo D/C (crédito/débito, entrada/saída).
    const vals = dataRows.map((r) => cell(r, mapping.type!)).filter(Boolean);
    typeColUsable = vals.length > 0 && vals.every((v) => dcOf(v) !== null);
    if (!typeColUsable) warnings.push({ code: "TYPE_COLUMN_IGNORED", message: "Coluna 'tipo' não indica débito/crédito; foi ignorada." });
  }

  for (const r of dataRows) {
    const desc = cell(r, mapping.description).replace(/\s+/g, " ");
    const descNorm = norm(desc);
    const dateRaw = cell(r, mapping.date);

    // Linhas de saldo: não são movimentação.
    if (/^s ?a ?l ?d ?o\b/.test(descNorm)) {
      const balRaw = mapping.balance !== undefined && cell(r, mapping.balance) ? cell(r, mapping.balance) : amountCell(r, mapping);
      const bal = balRaw ? parseMoney(balRaw, decimal) : null;
      if (bal && bal.ok) {
        if (/anterior|inicial/.test(descNorm) && opening === null && txs.length === 0) opening = bal.cents;
        else if (/final|atual/.test(descNorm)) closing = bal.cents;
        else warnings.push({ code: "BALANCE_ROW_SKIPPED", message: "Linha de saldo intermediário ignorada.", line: r.line });
      } else {
        warnings.push({ code: "BALANCE_ROW_SKIPPED", message: "Linha de saldo ignorada.", line: r.line });
      }
      continue;
    }

    const date = parseDateBR(dateRaw);
    if (!date.ok) {
      if (/^(total|subtotal|lancamentos futuros|resumo)/.test(descNorm) || (!dateRaw && !amountCell(r, mapping))) {
        warnings.push({ code: "FOOTER_ROW_SKIPPED", message: "Linha de total/rodapé ignorada.", line: r.line });
        continue;
      }
      return err("ROW_INVALID", `Data inválida na linha ${r.line}: ${date.message}`, r.line);
    }

    const signed = signedAmount(r, mapping, decimal, typeColUsable);
    if (!signed.ok) return err(signed.code, `Linha ${r.line}: ${signed.message}`, r.line);
    if (signed.cents === 0) {
      warnings.push({ code: "ZERO_AMOUNT_SKIPPED", message: "Lançamento com valor zero ignorado.", line: r.line });
      continue;
    }

    let balanceAfter: number | null = null;
    if (mapping.balance !== undefined && cell(r, mapping.balance)) {
      const b = parseMoney(cell(r, mapping.balance), decimal);
      if (!b.ok) return err("AMOUNT_INVALID", `Saldo inválido na linha ${r.line}: ${b.message}`, r.line);
      balanceAfter = b.cents;
    }

    txs.push({
      seq: txs.length + 1,
      date: date.date,
      description: maskSensitive(desc) || "(sem descrição)",
      amountCents: signed.cents,
      direction: signed.cents < 0 ? "out" : "in",
      balanceAfterCents: balanceAfter,
      fitid: mapping.id !== undefined ? cell(r, mapping.id) || null : null,
      bankType: null,
      source: { page: 1, line: r.line, excerpt: clipExcerpt(maskSensitive(r.raw)) },
    });
  }

  // Coluna única de valor, sem nenhum negativo e sem indicação de tipo → não sabemos o que é saída.
  if (mapping.amount !== undefined && !typeColUsable && txs.length > 1 && txs.every((t) => t.amountCents > 0)) {
    return err(
      "CSV_SIGN_UNKNOWN",
      "Todos os valores do CSV estão positivos e não há coluna indicando débito/crédito. Não dá para saber o que é saída.",
    );
  }

  const { transactions, removed, warnings: fitidWarnings } = applyFitidRules(txs);
  warnings.push(...fitidWarnings);

  return {
    ok: true,
    statement: {
      format: "csv",
      encoding,
      accountLabel: null,
      currency: "BRL",
      periodStart: null,
      periodEnd: null,
      openingBalanceCents: opening,
      closingBalanceCents: closing,
      closingBalanceDate: null,
      transactions,
      removedDuplicates: removed,
      warnings,
    },
  };
}

// =====================================================================
// CSV de baixo nível
// =====================================================================

const DELIMS = [";", "\t", ",", "|"] as const;

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 30);
  let best: string = ";";
  let bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d)).filter((c) => c > 0);
    if (counts.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const score = Math.max(...freq.values()); // quantas linhas concordam no mesmo nº de colunas
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** Parser RFC 4180: aspas, "" escapado, quebra de linha dentro de aspas, CRLF/LF/CR. */
export function splitCsv(text: string, d: string): Row[] {
  const rows: Row[] = [];
  let cells: string[] = [];
  let cur = "";
  let inQ = false;
  let line = 1;
  let rowLine = 1;
  let rowStart = 0;

  const endRow = (endIdx: number) => {
    cells.push(cur);
    rows.push({ cells, line: rowLine, raw: text.slice(rowStart, endIdx) });
    cells = [];
    cur = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        cur += ch;
      }
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === d) {
      cells.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      endRow(i);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      rowLine = line;
      rowStart = i + 1;
    } else cur += ch;
  }
  if (cur !== "" || cells.length > 0) endRow(text.length);
  return rows;
}

// =====================================================================
// Detecção de colunas
// =====================================================================

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

export function classifyHeader(h: string): CsvRole | null {
  const n = norm(h);
  if (!n) return null;
  if (/^(data|dt|date)\b/.test(n)) return "date";
  if (/\bsaldo\b|^balance$/.test(n)) return "balance";
  if (/\b(debito|debitos|saida|saidas)\b/.test(n) && !/credito/.test(n)) return "debit";
  if (/\b(credito|creditos|entrada|entradas)\b/.test(n) && !/debito/.test(n)) return "credit";
  if (/^(valor|montante|quantia|amount|value)\b/.test(n)) return "amount";
  if (/\b(descricao|historico|lancamento|detalhe|detalhes|memo|description|estabelecimento)\b/.test(n)) return "description";
  if (/^(tipo|d\/c|dc|c\/d|natureza|debito\/credito|credito\/debito)$/.test(n)) return "type";
  if (/^(identificador|id|fitid|id da transacao)$/.test(n)) return "id";
  return null;
}

function detectMapping(rows: Row[]): CsvColumnMapping | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const roles: Partial<Record<CsvRole, number>> = {};
    rows[i].cells.forEach((c, idx) => {
      const role = classifyHeader(c);
      if (role && roles[role] === undefined) roles[role] = idx; // primeira ocorrência vence
    });
    const hasMoney = roles.amount !== undefined || roles.debit !== undefined || roles.credit !== undefined;
    if (roles.date !== undefined && roles.description !== undefined && hasMoney) {
      const m: CsvColumnMapping = { headerRow: i, date: roles.date, description: roles.description };
      if (roles.amount !== undefined) m.amount = roles.amount;
      else {
        if (roles.debit !== undefined) m.debit = roles.debit;
        if (roles.credit !== undefined) m.credit = roles.credit;
      }
      if (roles.balance !== undefined) m.balance = roles.balance;
      if (roles.type !== undefined) m.type = roles.type;
      if (roles.id !== undefined) m.id = roles.id;
      return m;
    }
  }
  return null;
}

function validateMapping(m: CsvColumnMapping, rows: Row[]): string | null {
  const width = Math.max(...rows.map((r) => r.cells.length));
  if (!Number.isInteger(m.headerRow) || m.headerRow < -1 || m.headerRow >= rows.length) return "Linha de cabeçalho fora do arquivo.";
  const cols: [string, number | undefined][] = [
    ["date", m.date], ["description", m.description], ["amount", m.amount], ["debit", m.debit],
    ["credit", m.credit], ["balance", m.balance], ["type", m.type], ["id", m.id],
  ];
  const used = new Set<number>();
  for (const [name, idx] of cols) {
    if (idx === undefined) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= width) return `Coluna "${name}" fora do arquivo.`;
    if (used.has(idx)) return `Coluna ${idx} usada para mais de um papel.`;
    used.add(idx);
  }
  if (m.date === undefined || m.description === undefined) return "Mapeamento precisa de data e descrição.";
  const hasAmount = m.amount !== undefined;
  const hasDC = m.debit !== undefined || m.credit !== undefined;
  if (hasAmount === hasDC) return "Mapeamento precisa de UMA forma de valor: coluna única OU débito/crédito.";
  return null;
}

// =====================================================================
// Valores
// =====================================================================

function cell(r: Row, idx: number): string {
  return (r.cells[idx] ?? "").trim();
}

function amountCell(r: Row, m: CsvColumnMapping): string {
  if (m.amount !== undefined) return cell(r, m.amount);
  return (m.debit !== undefined ? cell(r, m.debit) : "") || (m.credit !== undefined ? cell(r, m.credit) : "");
}

/** Decide o separador decimal olhando TODAS as células de dinheiro do arquivo. */
function detectDecimal(rows: Row[], cols: number[]): "," | "." | "mixed" {
  let comma = 0;
  let dot = 0;
  for (const r of rows) {
    for (const c of cols) {
      const v = cell(r, c).replace(/[^\d.,]/g, "");
      if (/,\d{1,2}$/.test(v)) comma++;
      else if (/\.\d{1,2}$/.test(v)) dot++;
    }
  }
  if (comma > 0 && dot > 0) return "mixed";
  return dot > 0 ? "." : ",";
}

function dcOf(v: string): "D" | "C" | null {
  const n = norm(v);
  if (/^(d|deb|debito|saida|s|-)$/.test(n)) return "D";
  if (/^(c|cred|credito|entrada|e|\+)$/.test(n)) return "C";
  return null;
}

type Signed = { ok: true; cents: number } | { ok: false; code: StatementErrorCode; message: string };

function signedAmount(r: Row, m: CsvColumnMapping, decimal: "," | ".", useType: boolean): Signed {
  if (m.amount !== undefined) {
    const raw = cell(r, m.amount);
    const p = parseMoney(raw, decimal);
    if (!p.ok) return { ok: false, code: "AMOUNT_INVALID", message: p.message };
    if (useType && m.type !== undefined) {
      const dc = dcOf(cell(r, m.type));
      if (dc === "D") return { ok: true, cents: -Math.abs(p.cents) };
      if (dc === "C") {
        if (p.cents < 0) return { ok: false, code: "AMOUNT_INVALID", message: "Valor negativo marcado como crédito." };
        return { ok: true, cents: p.cents };
      }
    }
    return { ok: true, cents: p.cents };
  }

  const dRaw = m.debit !== undefined ? cell(r, m.debit) : "";
  const cRaw = m.credit !== undefined ? cell(r, m.credit) : "";
  const d = dRaw ? parseMoney(dRaw, decimal) : null;
  const c = cRaw ? parseMoney(cRaw, decimal) : null;
  if (d && !d.ok) return { ok: false, code: "AMOUNT_INVALID", message: d.message };
  if (c && !c.ok) return { ok: false, code: "AMOUNT_INVALID", message: c.message };
  const dv = d && d.ok ? Math.abs(d.cents) : 0;
  const cv = c && c.ok ? Math.abs(c.cents) : 0;
  if (dv > 0 && cv > 0) return { ok: false, code: "ROW_INVALID", message: "Linha com débito e crédito ao mesmo tempo." };
  if (!d && !c) return { ok: false, code: "ROW_INVALID", message: "Linha sem valor." };
  return { ok: true, cents: dv > 0 ? -dv : cv };
}

function err(code: StatementErrorCode, message: string, line?: number): StatementResult {
  return { ok: false, error: { code, message, ...(line ? { line } : {}) } };
}
