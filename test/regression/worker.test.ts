import { describe, expect, it } from "vitest";
import type { MonthCloseWorker } from "../../src/workers/finance-month-close/contract.js";
import { evaluateCase } from "./harness/evaluate.js";
import { loadAllCases } from "./harness/load.js";

/**
 * WORKER REAL × DATASET — o portão obrigatório dos próximos STEPs.
 *
 * Hoje não existe Worker real (o pipeline nasce no STEP 07), então cada caso aparece
 * como "todo" no relatório de testes — visível, não escondido.
 *
 * Para ligar: no STEP 07, importe a implementação e atribua a REAL_WORKER.
 * A partir daí, todo caso cujo `availableFrom` já foi atingido passa a ser OBRIGATÓRIO:
 *   - STEP_07: C01–C06, C07b, C09–C13
 *   - STEP_10: C08 (imagens / visão)
 *   - STEP_11: C07 (extrato em PDF)
 */
const REAL_WORKER = null as MonthCloseWorker | null;
const CURRENT_STEP = 3; // atualizar a cada STEP concluído

const stepOf = (s: string) => Number(s.replace("STEP_", ""));
const CASES = loadAllCases();

describe("Worker real × dataset de regressão", () => {
  for (const c of CASES) {
    const label = `${c.def.id} ${c.def.title} (obrigatório a partir do ${c.def.availableFrom})`;
    if (!REAL_WORKER || CURRENT_STEP < stepOf(c.def.availableFrom)) {
      it.todo(label);
      continue;
    }
    it(label, async () => {
      const outcome = await REAL_WORKER(c.input);
      expect(evaluateCase(c, outcome)).toEqual([]);
    });
  }
});
