import type { ParsedStatement } from "../parsers/types.js";
import { checkBalance, type BalanceResult } from "./balance.js";
import { classifyTransactions, type ClassifiedTransaction } from "./classify.js";

/**
 * Ponto de entrada do STEP 04 para o Worker: extrato lido → saldo + classificação.
 * Função pura: não altera o extrato recebido, não acessa rede, não usa LLM.
 */
export type StatementAnalysis = {
  balance: BalanceResult;
  transactions: ClassifiedTransaction[];
};

export function analyzeStatement(st: ParsedStatement): StatementAnalysis {
  return { balance: checkBalance(st), transactions: classifyTransactions(st.transactions) };
}
