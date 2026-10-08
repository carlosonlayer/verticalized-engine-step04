#!/usr/bin/env node
// =====================================================================
// VERIFY — o único relatório de testes aceito no projeto.
//
// PASS somente se os CINCO critérios passarem:
//   1. testes individuais: 0 falhando
//   2. suítes: 0 com falha (inclusive falha de inicialização, ex.: banco fora do ar)
//   3. exit code do vitest = 0
//   4. typecheck (tsc --noEmit) = PASS
//   5. build (tsc -p tsconfig.build.json) = PASS
//
// Uso: npm run verify      (exige TEST_DATABASE_URL para as suítes de banco)
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", shell: false, env: process.env });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const typecheck = run(npx, ["tsc", "--noEmit"]);
const build = run(npx, ["tsc", "-p", "tsconfig.build.json"]);

const reportFile = join(tmpdir(), `vz-verify-${process.pid}.json`);
rmSync(reportFile, { force: true });
const tests = run(npx, ["vitest", "run", "--reporter=json", `--outputFile=${reportFile}`]);

let report = null;
if (existsSync(reportFile)) report = JSON.parse(readFileSync(reportFile, "utf8"));

const failedSuites = report ? report.testResults.filter((f) => f.status !== "passed") : [];
const zeroTestSuites = report ? report.testResults.filter((f) => f.assertionResults.length === 0) : [];

const criteria = [
  ["typecheck", typecheck.status === 0, typecheck.status === 0 ? "PASS" : "FAIL"],
  ["build", build.status === 0, build.status === 0 ? "PASS" : "FAIL"],
  ["tests failed", report !== null && report.numFailedTests === 0, report ? String(report.numFailedTests) : "sem relatório"],
  ["suites failed", report !== null && failedSuites.length === 0 && report.numFailedTestSuites === 0,
    report ? String(Math.max(failedSuites.length, report.numFailedTestSuites)) : "sem relatório"],
  ["process exit code", tests.status === 0, String(tests.status)],
];

console.log("\n================ VERIFY ================");
if (report) {
  console.log(`tests total: ${report.numTotalTests} | passed: ${report.numPassedTests} | failed: ${report.numFailedTests} | todo: ${report.numTodoTests}`);
  console.log("");
  for (const f of report.testResults) {
    const a = f.assertionResults;
    const p = a.filter((x) => x.status === "passed").length;
    const t = a.filter((x) => x.status === "todo").length;
    const x = a.filter((x) => x.status === "failed").length;
    const name = f.name.replace(process.cwd() + "/", "");
    console.log(`${f.status === "passed" ? "  ok " : " FAIL"} ${String(p).padStart(4)} passed ${String(t).padStart(3)} todo ${String(x).padStart(3)} failed  ${name}`);
  }
}
for (const f of failedSuites) {
  console.log(`\n>>> SUÍTE COM FALHA: ${f.name.replace(process.cwd() + "/", "")}\n${(f.message || "").split("\n").slice(0, 6).join("\n")}`);
}
for (const f of zeroTestSuites) {
  if (!failedSuites.includes(f)) console.log(`\n>>> ATENÇÃO: suíte sem nenhum teste executado: ${f.name.replace(process.cwd() + "/", "")}`);
}
if (typecheck.status !== 0) console.log("\n>>> TYPECHECK:\n" + (typecheck.stdout + typecheck.stderr).split("\n").slice(0, 15).join("\n"));
if (build.status !== 0) console.log("\n>>> BUILD:\n" + (build.stdout + build.stderr).split("\n").slice(0, 15).join("\n"));

console.log("\n---------------- critérios ----------------");
for (const [name, ok, value] of criteria) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(18)} ${value}`);
const pass = criteria.every((c) => c[1]) && zeroTestSuites.every((f) => failedSuites.includes(f) || f.assertionResults.length > 0);
console.log(`\nRESULTADO: ${pass ? "PASS" : "FAIL"}`);
console.log("========================================\n");
rmSync(reportFile, { force: true });
process.exit(pass ? 0 : 1);
