import type { ParsedTransaction, ParseWarning } from "./types.js";

/**
 * FITID = identificador único da movimentação dado pelo banco.
 *
 * Duas situações diferentes, tratadas de formas diferentes:
 *  1) Mesmo FITID com conteúdo IDÊNTICO (data, valor, descrição) → falha de exportação:
 *     a cópia é removida e registrada (vira evento fitid_duplicate_removed).
 *  2) Mesmo FITID com conteúdo DIFERENTE → o banco não gera FITIDs confiáveis:
 *     nada é removido; os FITIDs desse arquivo passam a ser ignorados (null) e fica um aviso.
 *     Remover aqui apagaria movimentações reais.
 */
export function applyFitidRules(txs: ParsedTransaction[]): {
  transactions: ParsedTransaction[];
  removed: { fitid: string; line: number }[];
  warnings: ParseWarning[];
} {
  const seen = new Map<string, ParsedTransaction>();
  const removed: { fitid: string; line: number }[] = [];
  const kept: ParsedTransaction[] = [];
  let unreliable = false;

  for (const tx of txs) {
    if (!tx.fitid) {
      kept.push(tx);
      continue;
    }
    const prev = seen.get(tx.fitid);
    if (!prev) {
      seen.set(tx.fitid, tx);
      kept.push(tx);
    } else if (prev.date === tx.date && prev.amountCents === tx.amountCents && prev.description === tx.description) {
      removed.push({ fitid: tx.fitid, line: tx.source.line });
    } else {
      unreliable = true;
      kept.push(tx);
    }
  }

  const warnings: ParseWarning[] = [];
  let transactions = kept;
  if (unreliable) {
    transactions = kept.map((t) => ({ ...t, fitid: null }));
    warnings.push({
      code: "FITID_NOT_UNIQUE",
      message: "O banco repetiu identificadores para movimentações diferentes; os identificadores foram ignorados.",
    });
  }
  if (removed.length) {
    warnings.push({
      code: "FITID_DUPLICATE_REMOVED",
      message: `${removed.length} movimentação(ões) exportada(s) em duplicidade pelo banco foram removidas.`,
    });
  }
  // seq volta a ser contínuo depois de remoções
  transactions = transactions.map((t, i) => ({ ...t, seq: i + 1 }));
  return { transactions, removed, warnings };
}
