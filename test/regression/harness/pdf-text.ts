import { decodeCp1252 } from "../../../src/workers/finance-month-close/parsers/encoding.js";

/**
 * Extrai as linhas de texto dos PDFs SINTÉTICOS do dataset (stream sem compressão,
 * operadores Tj, WinAnsiEncoding). Serve só para provar, no teste de integridade,
 * que o PDF realmente contém o texto declarado em sources.json.
 * Não é o leitor de PDF de produção (esse é o STEP 11, com pdfjs-dist).
 */
export function extractSyntheticPdfLines(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const m = raw.match(/stream\n([\s\S]*?)endstream/);
  if (!m) throw new Error("PDF sem stream de conteúdo legível");
  const lines: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let t: RegExpExecArray | null; (t = re.exec(m[1])); ) {
    const unescaped = t[1].replace(/\\([\\()])/g, "$1").replace(/\\(\d{3})/g, (_s, o) => String.fromCharCode(parseInt(o, 8)));
    lines.push(decodeCp1252(Buffer.from(unescaped, "latin1")));
  }
  return lines;
}

export function isEncryptedPdf(pdf: Buffer): boolean {
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(pdf.toString("latin1"));
}
