import { diffDays, type IsoDate } from "./date.js";
import { decodeBankFile } from "./encoding.js";
import { parseCsv, type CsvColumnMapping } from "./csv.js";
import { parseOfx } from "./ofx.js";
import type { ParsedStatement, ParsedTransaction, StatementResult } from "./types.js";

export const STATEMENT_LIMITS = { maxTransactions: 300, maxPeriodDays: 31 } as const;

/**
 * Porta de entrada do extrato: bytes → ParsedStatement (ou erro explicado).
 * Escolhe o leitor pelo CONTEÚDO, não pela extensão do arquivo.
 */
export function parseStatement(buf: Uint8Array, opts: { csvMapping?: CsvColumnMapping } = {}): StatementResult {
  if (buf.length === 0) return { ok: false, error: { code: "STATEMENT_EMPTY", message: "O arquivo do extrato está vazio." } };

  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    // "%PDF"
    return {
      ok: false,
      error: {
        code: "STATEMENT_PDF_NOT_YET_SUPPORTED",
        message: "Extrato em PDF ainda não é aceito nesta versão. Envie o extrato em OFX ou CSV.",
      },
    };
  }

  const { text, encoding } = decodeBankFile(buf);
  if (text.includes("\u0000")) {
    return { ok: false, error: { code: "STATEMENT_FORMAT_UNKNOWN", message: "O arquivo não é um extrato em texto (OFX ou CSV)." } };
  }

  const result = /OFXHEADER|<OFX>/i.test(text.slice(0, 4000))
    ? parseOfx(text, encoding)
    : parseCsv(text, encoding, { mapping: opts.csvMapping });

  if (!result.ok) return result;
  const limits = checkLimits(result.statement);
  return limits ?? result;
}

function checkLimits(st: ParsedStatement): StatementResult | null {
  if (st.transactions.length > STATEMENT_LIMITS.maxTransactions) {
    return {
      ok: false,
      error: {
        code: "TOO_MANY_TRANSACTIONS",
        message: `O extrato tem ${st.transactions.length} movimentações; o limite atual é ${STATEMENT_LIMITS.maxTransactions} por mês.`,
      },
    };
  }
  if (st.transactions.length > 0) {
    const dates = st.transactions.map((t) => t.date).sort();
    const span = diffDays(dates[0], dates[dates.length - 1]) + 1;
    if (span > STATEMENT_LIMITS.maxPeriodDays) {
      return {
        ok: false,
        error: {
          code: "PERIOD_TOO_LONG",
          message: `O extrato cobre ${span} dias. Envie no máximo 1 mês (${STATEMENT_LIMITS.maxPeriodDays} dias).`,
        },
      };
    }
  }
  return null;
}

/** Primeira e última data das movimentações (null se não houver). */
export function transactionSpan(st: ParsedStatement): { from: IsoDate; to: IsoDate } | null {
  if (st.transactions.length === 0) return null;
  const d = st.transactions.map((t) => t.date).sort();
  return { from: d[0], to: d[d.length - 1] };
}

/** Converte para as linhas da tabela `transactions` (formato exato que o banco aceita). */
export function toTransactionRows(
  st: ParsedStatement,
  ctx: { workId: string; documentId: string; fileName: string },
) {
  return st.transactions.map((t: ParsedTransaction) => ({
    work_id: ctx.workId,
    document_id: ctx.documentId,
    seq: t.seq,
    date: t.date,
    description: t.description,
    amount_cents: t.amountCents,
    direction: t.direction,
    balance_after_cents: t.balanceAfterCents,
    fitid: t.fitid,
    evidence: [
      {
        document_id: ctx.documentId,
        file_name: ctx.fileName,
        page: t.source.page,
        line: t.source.line,
        excerpt: t.source.excerpt,
        method: "structured" as const,
        verified: true,
      },
    ],
  }));
}
