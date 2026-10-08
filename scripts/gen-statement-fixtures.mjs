// Gera os extratos SINTÉTICOS usados nos testes do STEP 02.
// Nenhum dado real. Nomes, CPFs e valores inventados.
// Uso: node scripts/gen-statement-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "test", "fixtures", "statements");
mkdirSync(DIR, { recursive: true });

// Codificador cp1252 mínimo (só o que usamos)
const CP1252_REV = { "–": 0x96, "€": 0x80, "“": 0x93, "”": 0x94 };
function cp1252(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x100) out.push(code);
    else if (CP1252_REV[ch] !== undefined) out.push(CP1252_REV[ch]);
    else throw new Error(`caractere fora do cp1252: ${ch}`);
  }
  return Buffer.from(out);
}

const brl = (cents) => {
  const neg = cents < 0;
  const d = Math.abs(cents).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d.slice(-2)}`;
};
const dot = (cents) => (cents / 100).toFixed(2); // só para GERAR fixture; o parser nunca usa float

// ---------------------------------------------------------------- OFX 1.x SGML, cp1252
{
  const txs = [
    ["20260901120000[-3:BRT]", -125000, "OFX001", "DEBIT", "PIX ENVIADO", "FORNECEDOR X LTDA"],
    ["20260902", -4890, "OFX002", "DEBIT", "TARIFA", "TARIFA PACOTE SERVIÇOS"],
    ["20260903000000[0:GMT]", 500000, "OFX003", "CREDIT", "PIX RECEBIDO", "CLIENTE ÁGUA AZUL – SERVIÇO"],
    ["20260910", -78000, "OFX004", "DEBIT", "PIX ENVIADO", "JOAO DA SILVA 123.456.789-09"],
    ["20260915", -485000, "OFX005", "PAYMENT", "BOLETO", "PAGTO BOLETO CONSTRUÇÃO & CIA"],
    ["20260930235959", -1990, "OFX006", "FEE", "IOF", "IOF"],
  ];
  const closing = 1000000 + txs.reduce((s, t) => s + t[1], 0);
  const body = txs
    .map(
      ([dt, c, id, type, name, memo]) =>
        `<STMTTRN>\n<TRNTYPE>${type}\n<DTPOSTED>${dt}\n<TRNAMT>${dot(c)}\n<FITID>${id}\n<NAME>${name}\n<MEMO>${memo}\n</STMTTRN>`,
    )
    .join("\n");
  const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20261001
<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>BRL
<BANKACCTFROM>
<BANKID>0341
<ACCTID>12345-6
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901
<DTEND>20260930
${body}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${dot(closing)}
<DTASOF>20260930
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`.replace(/\n/g, "\r\n");
  writeFileSync(join(DIR, "ofx-sgml-cp1252.ofx"), cp1252(ofx));
}

// ---------------------------------------------------------------- OFX 2.x XML, UTF-8
{
  const ofx = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STMTRS>
    <CURDEF>BRL</CURDEF>
    <BANKACCTFROM><BANKID>260</BANKID><ACCTID>98765432</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
    <BANKTRANLIST>
      <DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260805</DTPOSTED><TRNAMT>-250.00</TRNAMT><FITID>X1</FITID><MEMO>Compra no débito - Padaria Pão &amp; Café</MEMO></STMTTRN>
      <STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260810</DTPOSTED><TRNAMT>1500.50</TRNAMT><FITID>X2</FITID><MEMO>Transferência recebida</MEMO></STMTTRN>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260820</DTPOSTED><TRNAMT>-99.90</TRNAMT><FITID>X3</FITID><MEMO>Pagamento de boleto</MEMO></STMTTRN>
    </BANKTRANLIST>
    <LEDGERBAL><BALAMT>3150.60</BALAMT><DTASOF>20260831</DTASOF></LEDGERBAL>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;
  writeFileSync(join(DIR, "ofx-xml-utf8.ofx"), Buffer.from(ofx, "utf8"));
}

// ---------------------------------------------------------------- CSV estilo "banco tradicional": cp1252, ';', preâmbulo, saldo
{
  const opening = 1000000;
  const rows = [
    ["01/09/2026", "PIX ENVIADO FORNECEDOR X LTDA", -125000],
    ["02/09/2026", "TARIFA PACOTE SERVIÇOS", -4890],
    ["03/09/2026", "PIX RECEBIDO CLIENTE ÁGUA AZUL", 500000],
    ["10/09/2026", "PIX ENVIADO JOAO DA SILVA", -78000],
    ["15/09/2026", "PAGTO BOLETO CONSTRUÇÃO; MATERIAIS", -485000], // ';' dentro de aspas
    ["30/09/2026", "IOF", -1990],
  ];
  let bal = opening;
  const lines = [
    "Extrato de Conta Corrente",
    "Agência: 1234 Conta: 12345-6",
    "Período: 01/09/2026 a 30/09/2026",
    "",
    "Data;Lançamento;Ag./Origem;Valor (R$);Saldo (R$)",
    `31/08/2026;SALDO ANTERIOR;;;${brl(opening)}`,
  ];
  for (const [d, desc, c] of rows) {
    bal += c;
    const descCell = desc.includes(";") ? `"${desc}"` : desc;
    lines.push(`${d};${descCell};0001;${brl(c)};${brl(bal)}`);
    if (d === "15/09/2026") lines.push(`15/09/2026;SALDO DO DIA;;;${brl(bal)}`);
  }
  lines.push(`;Total de saídas;;${brl(rows.filter((r) => r[2] < 0).reduce((s, r) => s + r[2], 0))};`);
  writeFileSync(join(DIR, "csv-tradicional-cp1252.csv"), cp1252(lines.join("\r\n") + "\r\n"));
}

// ---------------------------------------------------------------- CSV estilo "banco digital": UTF-8, ',', ponto decimal, identificador
{
  const lines = [
    "Data,Valor,Identificador,Descrição",
    "05/09/2026,-250.00,6a1f0c2e-0001,Transferência enviada pelo Pix - MARIA SOUZA - •••.456.789-•• - BANCO X",
    "08/09/2026,3200.00,6a1f0c2e-0002,Transferência recebida pelo Pix - EMPRESA ALFA LTDA",
    '12/09/2026,-1234.56,6a1f0c2e-0003,"Pagamento de boleto efetuado - LUZ, ÁGUA E CIA"',
    "20/09/2026,-89.90,6a1f0c2e-0004,Compra no débito - MERCADO BOM",
  ];
  writeFileSync(join(DIR, "csv-digital-utf8.csv"), Buffer.from(lines.join("\n") + "\n", "utf8"));
}

// ---------------------------------------------------------------- CSV débito/crédito em colunas separadas, UTF-8 com BOM
{
  const lines = [
    "Data;Histórico;Débito;Crédito;Saldo",
    "01/09/2026;SALDO ANTERIOR;;;2.000,00",
    "02/09/2026;PIX ENVIADO ALUGUEL;1.500,00;;500,00",
    "05/09/2026;DEPÓSITO;;3.000,00;3.500,00",
    "09/09/2026;TARIFA;12,50;;3.487,50",
  ];
  writeFileSync(
    join(DIR, "csv-debito-credito-bom.csv"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n") + "\r\n", "utf8")]),
  );
}

console.log("fixtures gerados em", DIR);
