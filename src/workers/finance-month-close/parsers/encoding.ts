/**
 * Decodificação de arquivos de banco.
 *
 * Bancos brasileiros exportam OFX/CSV ora em UTF-8, ora em Windows-1252 (e muitas vezes
 * o cabeçalho do arquivo declara uma codificação e os bytes estão em outra).
 * Estratégia determinística: se os bytes são UTF-8 válido → UTF-8; senão → Windows-1252.
 *
 * Windows-1252 é implementado aqui com tabela própria (e não com TextDecoder) porque
 * o suporte do Node depende do ICU instalado — em alguns ambientes ele trata 0x80–0x9F
 * como latin1 e "€", "–", aspas curvas saem errados.
 */

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

export function decodeCp1252(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b] ?? b) : b);
  }
  return out;
}

export type DecodedText = { text: string; encoding: "utf-8" | "windows-1252" };

export function decodeBankFile(buf: Uint8Array): DecodedText {
  let bytes = buf;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // BOM
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: decodeCp1252(bytes), encoding: "windows-1252" };
  }
}

/** Mapa offset → número da linha (1-based), para evidência apontar a linha exata. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
