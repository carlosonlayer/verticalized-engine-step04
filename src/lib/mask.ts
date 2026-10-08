/**
 * Mascaramento de dados pessoais ANTES de qualquer persistência.
 *
 * Mascara: CPF (formatado, ou 11 dígitos com dígito verificador válido), e-mail,
 * telefone brasileiro, agência/conta. NÃO mascara CNPJ (dado de empresa, necessário
 * para cruzar documento com movimentação) nem nomes (necessários para o cruzamento).
 *
 * Limitação conhecida: só pega padrões reconhecíveis. É minimização, não garantia.
 */

export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

export function maskSensitive(text: string): string {
  if (!text) return text;
  return (
    text
      // CPF formatado: 123.456.789-09 → ***.456.789-**
      .replace(/\b\d{3}\.(\d{3})\.(\d{3})-\d{2}\b/g, "***.$1.$2-**")
      // CPF só dígitos, apenas se o dígito verificador for válido (evita mascarar outros números)
      .replace(/(?<!\d)\d{11}(?!\d)/g, (d) => (isValidCpf(d) ? `***${d.slice(3, 9)}**` : d))
      // e-mail: joao.silva@gmail.com → j***@gmail.com
      .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "$1***@$2")
      // telefone BR com DDD: (41) 99999-1234 / +55 41 99999-1234 / 41 99999-1234 → (**) *****-1234
      .replace(/(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}-(\d{4})\b/g, "(**) *****-$1")
      .replace(/\+55\s?\d{2}\s?9?\d{4}\s?(\d{4})\b/g, "(**) *****-$1")
      // agência / conta: "AG 1234 CC 12345-6" → "AG **34 CC ***45-6"
      .replace(/\b(AG(?:ENCIA|\.)?:?\s*)(\d{1,3})(\d{2})\b/gi, (_m, p, a, b) => `${p}${"*".repeat(a.length)}${b}`)
      .replace(/\b(C\/?C|CONTA(?:\s+CORRENTE)?:?)\s*([\d.]+)(\d{2}(?:-[\dXx])?)\b/gi, (_m, p, a, b) =>
        `${p} ${a.replace(/\d/g, "*")}${b}`,
      )
  );
}
