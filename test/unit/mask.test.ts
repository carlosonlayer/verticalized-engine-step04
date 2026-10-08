import { describe, expect, it } from "vitest";
import { isValidCpf, maskSensitive } from "../../src/lib/mask.js";

describe("maskSensitive", () => {
  it("mascara CPF formatado", () => {
    expect(maskSensitive("PIX ENVIADO JOAO 123.456.789-09")).toBe("PIX ENVIADO JOAO ***.456.789-**");
  });
  it("mascara CPF só com dígitos quando o dígito verificador é válido", () => {
    expect(isValidCpf("12345678909")).toBe(true);
    expect(maskSensitive("PIX 12345678909 JOAO")).toBe("PIX ***456789** JOAO");
  });
  it("NÃO mascara 11 dígitos que não são CPF (ex.: número de documento)", () => {
    expect(maskSensitive("DOC 12345678901")).toBe("DOC 12345678901");
  });
  it("NÃO mascara CNPJ (necessário para cruzar documento)", () => {
    expect(maskSensitive("FORNECEDOR 12.345.678/0001-95")).toBe("FORNECEDOR 12.345.678/0001-95");
  });
  it("mascara e-mail e telefone", () => {
    expect(maskSensitive("PIX chave joao.silva@gmail.com")).toBe("PIX chave j***@gmail.com");
    expect(maskSensitive("PIX (41) 99999-1234")).toBe("PIX (**) *****-1234");
    expect(maskSensitive("PIX +55 41 99999 1234")).toBe("PIX (**) *****-1234");
  });
  it("mascara agência e conta", () => {
    expect(maskSensitive("TED AG 1234 CC 12345-6")).toBe("TED AG **34 CC ***45-6");
  });
  it("não mexe em valores, datas e texto comum", () => {
    const s = "03/09/2026 PAGTO BOLETO CONSTRUÇÃO & CIA -4.850,00";
    expect(maskSensitive(s)).toBe(s);
  });
  it("é idempotente", () => {
    const once = maskSensitive("JOAO 123.456.789-09 joao@x.com (41) 99999-1234");
    expect(maskSensitive(once)).toBe(once);
  });
});
