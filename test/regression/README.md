# Dataset de regressão — Worker #001 (Fechar o mês)

Prova de que o Worker **não cria pares nem achados incorretos em silêncio**.
Todo componente dos próximos STEPs precisa passar por aqui.

## Estrutura

```
test/regression/
  cases/
    C01-perfect-month/            ← um diretório por caso
      extrato-setembro.ofx        ← entrada (extrato)
      pix-*.pdf, boleto-*.pdf …   ← entrada (documentos)
      expected.json               ← GABARITO: o que o Worker deve devolver
      sources.json                ← texto real de cada arquivo (para conferir evidências)
    …
    manifest.json                 ← SHA-256 de todos os arquivos (dataset imutável)
  harness/
    case-schema.ts                ← formato do expected.json
    load.ts                       ← carrega caso + bytes
    evaluate.ts                   ← O JUIZ: resposta do Worker → lista de violações
    oracle.ts                     ← Worker "perfeito" derivado do gabarito (autoteste)
    pdf-text.ts                   ← lê o texto dos PDFs sintéticos (integridade)
  dataset.test.ts                 ← integridade: arquivos, gabarito, erros plantados
  harness.test.ts                 ← o juiz aprova o certo e reprova 45 respostas erradas
  worker.test.ts                  ← Worker REAL × casos (pendente até o STEP 07)
```

## Casos

| Caso | O que prova | Obrigatório a partir de |
|---|---|---|
| C01 | Mês perfeito: confirma tudo que tem evidência, nenhum achado inventado | STEP 07 |
| C02 | Comprovante faltando é apontado; CPF do extrato sai mascarado | STEP 07 |
| C03 | 4.850 × 4.580: divergência de R$ 270, **nunca** confirmada | STEP 07 |
| C04 | Pagamento repetido, arquivo repetido (ignorado) e NFS-e em 2ª via | STEP 07 |
| C05 | Documento sem lançamento (fora do mês e sem pagamento) | STEP 07 |
| C06 | Dois candidatos iguais → precisa confirmar, **nenhum** confirmado | STEP 07 |
| C07 | Extrato PDF com linha perdida → saldo não fecha → `needs_review` | STEP 11 |
| C07b | Extrato com senha → recusado (`PDF_PASSWORD`) | STEP 07 |
| C08 | Foto ilegível → pendência explícita, nunca "adivinhada" | STEP 10 |
| C09 | 1 pagamento = 3 notas → proposto, **nunca** confirmado; nota extra fica de fora | STEP 07 |
| C10 | Boleto pago com juros → proposto, **nunca** confirmado | STEP 07 |
| C11 | Tarifa, IOF, aplicação, resgate, transferência própria → sem cobrança de comprovante | STEP 07 |
| C12 | Texto malicioso no comprovante não muda valor, pares nem pendências | STEP 07 |
| C13 | Só extrato é trabalho válido: lista o que falta | STEP 07 |

## Como um STEP futuro usa isto

1. Implementa o Worker respeitando `src/workers/finance-month-close/contract.ts`.
2. Em `worker.test.ts`, atribui a implementação a `REAL_WORKER` e atualiza `CURRENT_STEP`.
3. `npm test` passa a exigir `evaluateCase(caso, resposta) === []` para todo caso já disponível.

Peças isoladas (ex.: só o matching do STEP 06) podem ser testadas montando a resposta
parcial e chamando `evaluateCase` — o juiz é o mesmo.

## Regenerar

`node scripts/gen-regression-dataset.mjs` (requer python3 + Pillow e qpdf).
A regeneração é reprodutível byte a byte, **exceto** o PDF com senha do C07b
(a criptografia usa sal aleatório). Por isso o dataset é versionado e protegido
pelo `manifest.json`: o teste de integridade falha se qualquer arquivo mudar.
