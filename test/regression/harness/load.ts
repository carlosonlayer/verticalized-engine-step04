import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MonthCloseInput } from "../../../src/workers/finance-month-close/contract.js";
import { CaseSchema, SourcesSchema, type CaseSources, type RegressionCase } from "./case-schema.js";

export const CASES_DIR = join(import.meta.dirname, "..", "cases");

export type LoadedCase = {
  dir: string;
  def: RegressionCase;
  sources: CaseSources;
  files: Record<string, Buffer>; // nome do arquivo → bytes (somente arquivos de entrada)
  input: MonthCloseInput; // exatamente o que o Worker recebe
};

export function listCaseDirs(): string[] {
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function loadCase(dirName: string): LoadedCase {
  const dir = join(CASES_DIR, dirName);
  const def = CaseSchema.parse(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")));
  const sources = SourcesSchema.parse(JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")));
  const names = [def.input.statement, ...def.input.documents];
  const files = Object.fromEntries(names.map((n) => [n, readFileSync(join(dir, n))]));
  return {
    dir,
    def,
    sources,
    files,
    input: {
      statement: { fileName: def.input.statement, bytes: files[def.input.statement] },
      documents: def.input.documents.map((n) => ({ fileName: n, bytes: files[n] })),
    },
  };
}

export function loadAllCases(): LoadedCase[] {
  return listCaseDirs().map(loadCase);
}
