import { maskSensitive } from "../../../lib/mask.js";
import { compareIso, parseOfxDate, type IsoDate } from "./date.js";
import { lineIndex } from "./encoding.js";
import { applyFitidRules } from "./fitid.js";
import { parseMoney, type DecimalMode } from "./money.js";
import {
  clipExcerpt,
  type ParsedStatement,
  type ParsedTransaction,
  type ParseWarning,
  type StatementErrorCode,
  type StatementResult,
} from "./types.js";

/**
 * Leitor de OFX — 100% determinístico, sem LLM.
 *
 * Suporta OFX 1.x (SGML, tags de valor sem fechamento, típico de bancos brasileiros)
 * e OFX 2.x (XML). Só extrato de CONTA (STMTRS), uma conta por arquivo, em BRL.
 */
export function parseOfx(text: string, encoding: ParsedStatement["encoding"]): StatementResult {
  if (!/OFXHEADER|<OFX>/i.test(text.slice(0, 4000))) {
    return err("OFX_INVALID", "O arquivo não parece ser um OFX válido.");
  }
  const lineOf = lineIndex(text);

  const stmtCount = count(text, /<STMTRS>/gi);
  const ccCount = count(text, /<CCSTMTRS>/gi);
  if (ccCount > 0 && stmtCount === 0) {
    return err("CREDIT_CARD_NOT_SUPPORTED", "Este OFX é de cartão de crédito. Envie o extrato da conta bancária.");
  }
  if (stmtCount + ccCount > 1) {
    return err("MULTIPLE_ACCOUNTS", "Este arquivo tem mais de uma conta. Envie um extrato por conta.");
  }
  if (stmtCount === 0) return err("OFX_NO_STATEMENT", "Não encontramos um extrato de conta dentro do OFX.");

  const warnings: ParseWarning[] = [];

  // ---- moeda ----
  const curdef = leaf(text, "CURDEF");
  if (curdef && curdef.toUpperCase() !== "BRL") {
    return err("CURRENCY_NOT_SUPPORTED", `Extrato em ${curdef}. Por enquanto só fechamos contas em reais (BRL).`);
  }
  if (!curdef) warnings.push({ code: "CURRENCY_ASSUMED", message: "Moeda não informada no OFX; assumimos reais (BRL)." });

  // ---- conta (só os 4 últimos dígitos saem daqui) ----
  const acctBlock = block(text, "BANKACCTFROM") ?? "";
  const bankId = leaf(acctBlock, "BANKID");
  const acctId = leaf(acctBlock, "ACCTID");
  const last4 = acctId ? acctId.replace(/\D/g, "").slice(-4) : "";
  const accountLabel =
    [bankId ? `Banco ${bankId.replace(/^0+(?=\d)/, "")}` : null, last4 ? `••${last4}` : null].filter(Boolean).join(" · ") ||
    null;

  // ---- período declarado ----
  const tranList = block(text, "BANKTRANLIST") ?? text;
  const periodStart = optionalDate(leaf(tranList, "DTSTART"), "DTSTART", warnings);
  const periodEnd = optionalDate(leaf(tranList, "DTEND"), "DTEND", warnings);

  // ---- saldo final (LEDGERBAL) ----
  let closingBalanceCents: number | null = null;
  let closingBalanceDate: IsoDate | null = null;
  const ledger = block(text, "LEDGERBAL");
  if (ledger) {
    const balRaw = leaf(ledger, "BALAMT");
    if (balRaw) {
      const bal = parseMoney(balRaw, ofxDecimalMode(balRaw));
      if (!bal.ok) return err("AMOUNT_INVALID", `Saldo final inválido no OFX: ${bal.message}`, lineAt(text, lineOf, "<BALAMT>"));
      closingBalanceCents = bal.cents;
    }
    closingBalanceDate = optionalDate(leaf(ledger, "DTASOF"), "DTASOF", warnings);
  }

  // ---- movimentações ----
  const opens = count(text, /<STMTTRN>/gi);
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const raw: ParsedTransaction[] = [];
  let found = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    found++;
    const body = m[1];
    const line = lineOf(m.index);

    const amtRaw = leaf(body, "TRNAMT");
    const amt = parseMoney(amtRaw, ofxDecimalMode(amtRaw ?? ""));
    if (!amt.ok) return err("AMOUNT_INVALID", `Valor inválido na linha ${line}: ${amt.message}`, line);

    const dtRaw = leaf(body, "DTPOSTED");
    const dt = parseOfxDate(dtRaw);
    if (!dt.ok) return err("DATE_INVALID", `Data inválida na linha ${line}: ${dt.message}`, line);

    if (amt.cents === 0) {
      warnings.push({ code: "ZERO_AMOUNT_SKIPPED", message: "Lançamento com valor zero ignorado.", line });
      continue;
    }

    const type = (leaf(body, "TRNTYPE") ?? "").toUpperCase();
    if (["DEBIT", "PAYMENT", "FEE", "SRVCHG", "ATM", "POS", "CHECK"].includes(type) && amt.cents > 0) {
      warnings.push({
        code: "SIGN_TYPE_MISMATCH",
        message: `Lançamento do tipo ${type} com valor positivo; mantivemos o sinal do valor (TRNAMT).`,
        line,
      });
    }

    const name = leaf(body, "NAME");
    const memo = leaf(body, "MEMO");
    const parts = [name, memo].filter((p): p is string => !!p);
    const unique = parts.filter((p, i) => parts.findIndex((q) => q.toUpperCase() === p.toUpperCase()) === i);
    const description = maskSensitive(unique.join(" - ").replace(/\s+/g, " ").trim()) || type || "(sem descrição)";

    raw.push({
      seq: raw.length + 1,
      date: dt.date,
      description,
      amountCents: amt.cents,
      direction: amt.cents < 0 ? "out" : "in",
      balanceAfterCents: null,
      fitid: leaf(body, "FITID"),
      bankType: type || null,
      source: { page: 1, line, excerpt: clipExcerpt(maskSensitive(m[0])) },
    });
  }
  if (found !== opens) {
    return err("OFX_INVALID", "O OFX tem movimentações sem fechamento (<STMTTRN> sem </STMTTRN>). O arquivo pode estar corrompido.");
  }

  const { transactions, removed, warnings: fitidWarnings } = applyFitidRules(raw);
  warnings.push(...fitidWarnings);

  if (periodStart && periodEnd) {
    for (const t of transactions) {
      if (compareIso(t.date, periodStart) < 0 || compareIso(t.date, periodEnd) > 0) {
        warnings.push({
          code: "OUT_OF_DECLARED_PERIOD",
          message: "Movimentação fora do período declarado no próprio OFX.",
          line: t.source.line,
        });
      }
    }
  }

  return {
    ok: true,
    statement: {
      format: "ofx",
      encoding,
      accountLabel,
      currency: "BRL",
      periodStart,
      periodEnd,
      openingBalanceCents: null, // OFX não traz saldo inicial — não inventamos (balance = structural_only)
      closingBalanceCents,
      closingBalanceDate,
      transactions,
      removedDuplicates: removed,
      warnings,
    },
  };
}

// ---------------- helpers ----------------

/** OFX deveria usar ponto decimal, mas há bancos que exportam vírgula. */
function ofxDecimalMode(v: string): DecimalMode {
  const c = v.includes(",");
  const d = v.includes(".");
  return c && d ? "auto" : c ? "," : ".";
}

/** Valor de uma tag "folha" (com ou sem fechamento, SGML ou XML). */
function leaf(src: string, tag: string): string | null {
  const m = src.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  if (!m) return null;
  const v = decodeEntities(m[1]).trim();
  return v === "" ? null : v;
}

function block(src: string, tag: string): string | null {
  const m = src.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function count(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

function optionalDate(raw: string | null, tag: string, warnings: ParseWarning[]): IsoDate | null {
  if (!raw) return null;
  const r = parseOfxDate(raw);
  if (r.ok) return r.date;
  warnings.push({ code: "OFX_DATE_IGNORED", message: `${tag} inválido no OFX foi ignorado.` });
  return null;
}

function lineAt(text: string, lineOf: (o: number) => number, needle: string): number | undefined {
  const i = text.toUpperCase().indexOf(needle);
  return i >= 0 ? lineOf(i) : undefined;
}

function err(code: StatementErrorCode, message: string, line?: number): StatementResult {
  return { ok: false, error: { code, message, ...(line ? { line } : {}) } };
}
