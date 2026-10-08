import type { IsoDate } from "./date.js";

/** Onde, no arquivo original, está o dado. Vira "evidence" no banco. */
export type SourceRef = {
  page: number; // OFX/CSV: sempre 1
  line: number; // linha física no arquivo (1-based)
  excerpt: string; // trecho literal (já mascarado), até 240 caracteres
};

export type ParsedTransaction = {
  seq: number; // ordem no arquivo (1-based)
  date: IsoDate;
  description: string; // já mascarada
  amountCents: number; // inteiro; saída negativa
  direction: "in" | "out";
  balanceAfterCents: number | null;
  fitid: string | null;
  /** Tipo informado pelo próprio banco (OFX TRNTYPE, ex.: "FEE", "ATM"); null quando o formato não traz. STEP 04. */
  bankType: string | null;
  source: SourceRef;
};

export type ParseWarning = { code: string; message: string; line?: number };

export type ParsedStatement = {
  format: "ofx" | "csv";
  encoding: "utf-8" | "windows-1252";
  accountLabel: string | null; // ex.: "Banco 341 · ••5678" — nunca o número completo
  currency: "BRL";
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  closingBalanceDate: IsoDate | null;
  transactions: ParsedTransaction[];
  /** FITIDs repetidos removidos (falha de exportação do banco). Viram evento fitid_duplicate_removed. */
  removedDuplicates: { fitid: string; line: number }[];
  warnings: ParseWarning[];
};

export type StatementErrorCode =
  | "STATEMENT_EMPTY"
  | "STATEMENT_FORMAT_UNKNOWN"
  | "STATEMENT_PDF_NOT_YET_SUPPORTED"
  | "OFX_INVALID"
  | "OFX_NO_STATEMENT"
  | "MULTIPLE_ACCOUNTS"
  | "CREDIT_CARD_NOT_SUPPORTED"
  | "CURRENCY_NOT_SUPPORTED"
  | "AMOUNT_INVALID"
  | "DATE_INVALID"
  | "CSV_EMPTY"
  | "CSV_COLUMNS_UNKNOWN"
  | "CSV_MAPPING_INVALID"
  | "CSV_AMBIGUOUS_NUMBER_FORMAT"
  | "CSV_SIGN_UNKNOWN"
  | "ROW_INVALID"
  | "TOO_MANY_TRANSACTIONS"
  | "PERIOD_TOO_LONG";

export type StatementError = {
  code: StatementErrorCode;
  message: string; // em português, pode ir para a tela do usuário
  line?: number;
  /** Só em CSV_COLUMNS_UNKNOWN: amostra (mascarada) para o mapeamento de colunas no STEP 05. */
  sample?: string[][];
};

export type StatementResult = { ok: true; statement: ParsedStatement } | { ok: false; error: StatementError };

export const EXCERPT_MAX = 240;

export function clipExcerpt(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > EXCERPT_MAX ? one.slice(0, EXCERPT_MAX - 1) + "…" : one;
}
