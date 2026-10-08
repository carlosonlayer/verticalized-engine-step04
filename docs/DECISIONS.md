# Decisões de arquitetura — STEP 01

Registro das decisões que a especificação não fixava (ou fixava de forma diferente
entre versões). Regra: escolher o mais simples e deixar escrito aqui.

| # | Decisão | Por quê |
|---|---|---|
| D01 | `GET /health` **não** consulta o banco. | Se o Supabase oscilar, o Cloud Run não deve matar instâncias saudáveis com trabalhos em andamento. Falha de banco aparece no próprio trabalho (`failed` com `error_code`). |
| D02 | Node 22 + TypeScript em ESM (`"type": "module"`). | Padrão atual do Node; evita configuração dupla CJS/ESM. |
| D03 | Máquina de estados garantida **no banco** (trigger), além do código. | Nenhum bug de código consegue gravar um estado impossível (ex.: `received → completed`). |
| D04 | `failed` permitido a partir de qualquer estado não final (`received`, `processing`, `validating`). | A spec citava `processing → failed`; uma falha também pode acontecer logo após a criação ou durante a validação. Estados finais nunca voltam. |
| D05 | `needs_review` exige `review_reasons`; `failed` exige `error_code`. | "Zero falhas silenciosas" garantido no banco. |
| D06 | Nomes dos tipos de achado seguem o prompt mestre de construção (`amount_divergence`, `duplicate_transaction`, `payment_duplication`, `unmatched_document`, `unreadable_document`, `balance_failure`, `needs_confirmation`), mantendo da spec anterior `grouped_payment`, `paid_with_fees`, `unverified_extraction`. | Os três extras são necessários para os passes 4–6 do matching e para a Camada 2 de validação. |
| D07 | `transactions.kind` = `normal`, `fee`, `own_transfer`, `investment`; `direction` = `in`/`out` (documentos aceitam `unknown`). | Termos do prompt mestre. Sinal do valor é validado contra `direction` no banco. |
| D08 | `transactions.status` começa como `pending` (antes do matching). | Permite gravar movimentações extraídas antes do cruzamento sem fingir um status. |
| D09 | Arquivo com hash repetido no mesmo trabalho é **ignorado** na entrada (evento `duplicate_file_ignored`), não gravado. | Constraint `unique (work_id, sha256)`. Documento repetido com hash diferente vira achado `duplicate_document` (STEP 06). |
| D10 | Exatamente 1 extrato por trabalho (índice único parcial). | Escopo v0: 1 conta, 1 mês. |
| D11 | Pares `grouped`/`partial`/`with_fees` nunca podem ser `confirmed` (constraint). | Regra "na dúvida, não confirma" garantida no banco. |
| D12 | Todo achado e toda movimentação exigem evidência válida (função `is_valid_evidence`). Documento de apoio extraído (`ok`/`partial`) também. | "Não permitir finding sem evidência" garantido no banco. |
| D13 | Não existe coluna para arquivo bruto, texto completo ou resposta do Gemini (há teste verificando). | Minimização por desenho: não há onde guardar. |
| D14 | `events.name` com lista fechada (inclui `fitid_duplicate_removed`, `duplicate_file_ignored`, `work_deleted`). | Evita evento arbitrário carregando conteúdo. Novo evento = nova migração, de propósito. |
| D15 | Workspace 1:1 com usuário (`unique owner_id`). | Layer 1. Multiusuário fica para o Layer 2. |
| D16 | RLS ligado, **nenhuma** policy, privilégios revogados de `anon`/`authenticated`. | No Supabase, tabelas novas recebem privilégios padrão; revogar é defesa extra. Só a service role (backend) acessa. |
| D17 | Cloud Run com `--allow-unauthenticated` no nível de rede; autenticação feita na aplicação (JWT do Supabase, STEP 07). | O navegador do usuário chama a API diretamente. `/health` é público. |
| D18 | Região `southamerica-east1` (Cloud Run) e `sa-east-1` (Supabase). | Dados em São Paulo; reduz questão de transferência internacional para infraestrutura (o Gemini continua sendo ponto a validar). |
| D19 | Sem retenção automática (TTL) no STEP 01. | Prazo de retenção é questão jurídica em aberto (ver LGPD-QUESTIONS.md). Exclusão sob demanda chega no STEP 13. |
| D20 | Testes de banco rodam contra **PostgreSQL 16 real** local, com um bootstrap que imita o Supabase (`auth.users`, papéis, privilégios padrão). | Testa a migração de verdade, não um mock. |

# Decisões de arquitetura — STEP 02 (dinheiro, datas, OFX, CSV)

| # | Decisão | Por quê |
|---|---|---|
| D21 | Dinheiro é convertido por **manipulação de dígitos** (string → BigInt → inteiro seguro), nunca `parseFloat`. Resultado é `number` inteiro validado com `Number.isSafeInteger`, teto R$ 100 bilhões. | `4.35*100` em float = 434.99999999999994. Com dígitos, "4,35" é sempre 435. `number` inteiro é exato até 9 quatrilhões de centavos e já é o que o Supabase/JSON transporta; o banco guarda em `bigint`. |
| D22 | Mais de 2 casas decimais → **erro** (`MONEY_PRECISION`), nunca arredondamento. | Arredondar valor de extrato em silêncio quebraria o check de saldo de centavo. |
| D23 | Formato decimal ambíguo ("1.234" sem contexto) → **erro**, nunca chute. No CSV, o formato decimal é decidido olhando **todas** as células de dinheiro do arquivo; mistura de vírgula e ponto → erro. | Um único chute errado multiplica um valor por 1.000. |
| D24 | Sinais aceitos: `-` no início ou fim, `(…)`, sufixo/prefixo `D`/`C`, `+`. Mais de um marcador → `MONEY_SIGN_CONFLICT`. | Extratos brasileiros usam todos esses padrões; dois marcadores ao mesmo tempo indicam arquivo inconsistente. |
| D25 | Datas de negócio são strings `AAAA-MM-DD` (`IsoDate`) do começo ao fim. Aritmética de dias em UTC puro. | Elimina deslocamento de fuso: "03/09" nunca vira "02/09". Testado trocando o TZ do processo. |
| D26 | Ordem de data **sempre** dia/mês/ano. Formato americano é recusado (ex.: 09/30/2026 → erro), não reinterpretado. | Ler 03/09 como 9 de março seria um erro silencioso. |
| D27 | Data OFX usa os **8 primeiros dígitos literais**; o fuso `[x:TZ]` é ignorado. | O banco já informa a data do lançamento; converter `20260903000000[0:GMT]` para Brasília daria 02/09. |
| D28 | Ano com 2 dígitos → 20xx. Data sem ano → erro, a menos que um `referenceYear` seja passado explicitamente. | Extratos em PDF (STEP 11) às vezes trazem "03/09"; o ano virá do período do extrato, nunca de suposição. |
| D29 | Decodificação: UTF-8 válido → UTF-8; caso contrário → Windows-1252 com **tabela própria** (não `TextDecoder`). | Neste ambiente o `TextDecoder('windows-1252')` do Node tratou 0x80–0x9F como latin1 ("€", "–" errados). Tabela própria = mesmo resultado em qualquer servidor. |
| D30 | O leitor é escolhido pelo **conteúdo** (cabeçalho OFX, assinatura `%PDF`), não pela extensão. PDF de extrato retorna `STATEMENT_PDF_NOT_YET_SUPPORTED` até o STEP 11. | Usuário renomeia arquivos; extensão não é confiável. |
| D31 | OFX: sinal vem do `TRNAMT` (autoritativo pela especificação). `TRNTYPE` contraditório gera aviso, não troca o sinal. | Trocar o sinal com base em um campo secundário seria uma decisão sem evidência. |
| D32 | OFX não tem saldo inicial → `openingBalanceCents = null`. Nunca derivamos saldo inicial a partir das movimentações. | Saldo inicial derivado tornaria o check de saldo uma tautologia (D04 da spec: `structural_only`). |
| D33 | FITID repetido **idêntico** → cópia removida e listada em `removedDuplicates` (vira evento). FITID repetido com conteúdo **diferente** → nada é removido; todos os FITIDs do arquivo são descartados, com aviso. | Remover no segundo caso apagaria movimentações reais de bancos que geram FITID ruim. |
| D34 | Valor zero → ignorado com aviso (`ZERO_AMOUNT_SKIPPED`). Linha com data/valor inválido → **erro com número da linha**, nunca pulada. Exceções explícitas: linhas de saldo e de total/rodapé no CSV, sempre com aviso. | Pular linha em silêncio quebra o fechamento. |
| D35 | CSV: "SALDO ANTERIOR/INICIAL" (antes de qualquer movimentação) → saldo inicial; "SALDO FINAL/ATUAL" → saldo final; outros "SALDO…" → ignorados com aviso. Saldo por linha preservado em `balanceAfterCents`. | Base do check de saldo linha a linha do STEP 04. |
| D36 | CSV com coluna única de valor, todos positivos e sem coluna D/C → **erro** `CSV_SIGN_UNKNOWN`. | Não há evidência de quais são saídas. |
| D37 | Colunas não reconhecidas → `CSV_COLUMNS_UNKNOWN` com amostra **mascarada**. O parser aceita um `csvMapping` explícito, validado por código. | É o ponto de encaixe do Gemini no STEP 05: ele só **sugere** o mapeamento; a conversão continua aqui. |
| D38 | Mascaramento (`lib/mask.ts`) aplicado na descrição **e** no trecho de evidência dentro do parser: CPF (formatado ou com dígito verificador válido), e-mail, telefone, agência/conta. CNPJ e nomes **não** são mascarados. | Nada com CPF completo sai do parser. CNPJ e nome são necessários para o cruzamento (STEP 06). |
| D39 | Conta bancária vira `accountLabel` com **só os 4 últimos dígitos** ("Banco 341 · ••3456"). | O número completo da conta nunca sai do parser. |
| D40 | Limites aplicados após a leitura: até 300 movimentações e até 31 dias entre a primeira e a última movimentação (inclusive). | Spec do Worker #001. Uma conta e um mês por trabalho. |
| D41 | Evidência de OFX/CSV: `page: 1`, `line` = linha física no arquivo (início do `<STMTTRN>` ou da linha do CSV), `method: "structured"`, `verified: true`. | Formato estruturado: o dado vem do campo, não de interpretação. |

# Decisões de arquitetura — STEP 03 (dataset de regressão)

| # | Decisão | Por quê |
|---|---|---|
| D42 | O **contrato** do Worker (`src/workers/finance-month-close/contract.ts`) foi criado agora, em `src/`, com zod. Nomes de achados seguem o Prompt Mestre de construção. | O dataset precisa julgar algo concreto. O STEP 07 vai implementar exatamente este contrato. |
| D43 | O resultado inclui o extrato em `documents` (`role: "statement"`) e um campo `ignored_files`. | Toda evidência de movimentação aponta para um `document_id` real; arquivo repetido ignorado precisa ficar registrado (não pode "sumir"). |
| D44 | O dataset é gerado por **um único script** (`scripts/gen-regression-dataset.mjs`) que produz entrada E gabarito da mesma definição. | Entrada e gabarito nunca ficam fora de sincronia. |
| D45 | O dataset é **versionado** e protegido por `manifest.json` (SHA-256). Os testes leem os arquivos, não regeneram. | O PDF com senha (qpdf) não é reprodutível byte a byte (sal aleatório); todos os outros 82 arquivos são. |
| D46 | PDFs sintéticos com **texto real** (sem compressão) gerados por um escritor de PDF próprio de ~30 linhas. PDF com senha via `qpdf`, imagens via Pillow — só na geração. | Nenhuma dependência nova no projeto. Os testes não precisam de qpdf/python. |
| D47 | Referência de movimentação no gabarito: `fitid:<id>` (OFX) ou `tx:<data>|<centavos>` (PDF). Documento por nome de arquivo. Listas = "qualquer um destes"; `*` = curinga. | Independente de IDs internos do Worker. |
| D48 | Política de achados **exata**: o Worker só pode produzir os achados obrigatórios + os explicitamente permitidos (`allowedFindings`). Qualquer outro = `UNEXPECTED_FINDING`. | Achado inventado é tão ruim quanto achado perdido. Permitidos existem só onde mais de uma resposta é legítima (ex.: C06). |
| D49 | Par confirmado só é aceito se estiver em `confirmedMatches`/`optionalConfirmations` **e** usar regra `exact`/`exclusive`, 1:1. | "Zero falsos confirmados" verificado por três regras independentes. |
| D50 | Evidência é conferida contra a fonte: arquivo enviado, `document_id` correto, método coerente com o tipo (OFX→structured, PDF→text, imagem→vision), linha existente, trecho presente no texto real (após mascaramento). Leitura por imagem nunca pode vir `verified: true`. | "Evidência rastreável" vira verificação automática, não promessa. |
| D51 | Falhas silenciosas checadas explicitamente: documento ilegível sem pendência, "concluído" com saldo que não fecha, `needs_review` sem motivo, sem comprovante sem achado, status de par incoerente, resumo que não bate com as linhas, CPF completo no resultado, aviso legal ausente. | Requisito "zero silent failures". |
| D52 | O juiz é testado por um **Worker-oráculo** (deve passar tudo) e por **45 Workers-mutantes** (cada um deve ser reprovado com o código certo). | Um juiz que aprova tudo aprovaria o oráculo também; só os mutantes provam que ele enxerga erro. Verificado também desligando regras do juiz (testes do autoteste falham). |
| D53 | `worker.test.ts` lista os 14 casos como `todo` até existir Worker real; cada caso tem `availableFrom` (STEP_07 / STEP_10 / STEP_11). | Pendência visível no relatório, não escondida. Vira obrigatório sem escrever teste novo. |
| D54 | C08 usa 6 documentos com 1 ilegível (16,7%), abaixo do limite de 20% → `completed` com pendência. | Evita depender do caso de fronteira (exatamente 20%) antes de a regra ser implementada. |
| D55 | No C04, o achado `duplicate_document` aceita qualquer uma das duas vias, e o par confirmado aceita qualquer uma delas. | As duas são o mesmo documento; exigir uma específica seria arbitrário. |

# Decisões de arquitetura — STEP 04 (saldo + classificação)

| # | Decisão | Por quê |
|---|---|---|
| D56 | **Relatório de testes oficial = `npm run verify`.** PASS só se: typecheck PASS, build PASS, 0 testes falhando, 0 suítes falhando (inclusive falha de inicialização) e exit code 0. Suíte com 0 testes executados é destacada. | No STEP 03 o banco caiu e um resumo mostrou "0 falharam" com 2 suítes quebradas. Provado: com o banco desligado o verify dá FAIL mesmo com "tests failed 0". |
| D57 | **Status do saldo** (em ordem): (1) erro estrutural → `failed`; (2) saldo em TODAS as linhas → confere linha a linha; quebra → `failed`; fecha + saldo inicial E final explícitos e coerentes → `passed`; fecha sem as duas âncoras → `structural_only`; (3) saldo inicial E final sem saldo por linha → `passed` se inicial + Σ = final, senão `failed`; (4) OFX elegível → `structural_only`; (5) senão → `not_available`. | `passed` exige prova completa. Saldo por linha sozinho não detecta linha perdida nas pontas. |
| D58 | Tolerância **zero**, soma em **BigInt**. A diferença é sempre informada exata (`final − (inicial + Σ)`), com sinal. | Uma diferença de 1 centavo é um erro de extração ou um lançamento; arredondar esconderia. |
| D59 | **Nunca inventar saldo inicial.** Sem saldo inicial, `computedClosingCents` e `diffCents` ficam `null`. | Saldo inicial derivado (final − Σ) torna a conferência uma tautologia (mutação M12 morta por 21 testes). |
| D60 | **`structural_only` (OFX)** exige: formato OFX, período declarado e coerente (início ≤ fim), todas as movimentações dentro do período, FITID em todas e sem repetição, nenhum erro estrutural. Faltou qualquer um → `not_available` com o motivo (`PERIOD_NOT_DECLARED`, `FITIDS_INCOMPLETE`, `OUT_OF_DECLARED_PERIOD`, `PERIOD_INVERTED`). | É o máximo que dá para afirmar sem saldo inicial. |
| D61 | **Ordem das linhas (newest-first)** é decidida pela **aritmética**, não pela aparência: conta quantos pares fecham em ordem crescente (`saldo[i−1] + valor[i] = saldo[i]`) e invertida (`saldo[i+1] + valor[i] = saldo[i]`); vence a que fecha mais. Empate → ordem das datas desempata; sem desempate → `unknown` → `failed`. | Funciona com várias movimentações no mesmo dia e com extratos que listam do mais novo para o mais antigo. |
| D62 | **Localização da quebra:** com saldo inicial, refaz a conta em ordem cronológica e aponta a primeira linha cujo saldo diverge do calculado. Sem saldo inicial, aponta a primeira quebra entre pares (pode ser a linha seguinte à errada). | Defeito real encontrado pelo teste de propriedade (seed 35): saldo errado na 1ª linha era atribuído à 2ª. Corrigido e fixado em teste. |
| D63 | Saldo por linha **parcial** (só algumas linhas) não é usado; fica o aviso `RUNNING_BALANCE_PARTIAL` e vale a regra de saldo inicial/final. | Verificar pares com buracos produziria falsos alarmes. |
| D64 | Validação estrutural repetida no STEP 04 (sinal × direção, centavos inteiros ≠ 0, datas reais, seq contínuo, FITID único, saldos inteiros, ≤ 31 dias). Severidade `error` → `failed`; `warning` → impede `structural_only`. | O leitor do STEP 02 já garante isso para OFX/CSV, mas extratos em PDF (STEP 11) chegarão por outro caminho. |
| D65 | **Classificação** por regras explícitas com `id`, sobre a descrição normalizada (maiúsculas, sem acento), a direção e o tipo do banco (OFX `TRNTYPE`). Grupo A (tarifa, investimento, conta própria, saque) tem prioridade sobre o grupo B (pagamento/recebimento comuns). | Cada decisão é rastreável: `ruleId` + `matchedTerm` (o trecho que casou). |
| D66 | **Unknown conservador:** sem regra → `unknown`; regras de categorias diferentes do grupo A ao mesmo tempo → `unknown`; estorno/devolução/cancelamento → `unknown`; direção incompatível (ex.: "TARIFA" como entrada) → a regra não vale. | Na dúvida, não decidir. |
| D67 | **"Não exige comprovante"** (`receiptRequirement = "not_required"`) existe SOMENTE para `fee`, `investment` e `own_transfer`, e SOMENTE via regra explícita. Saque e pagamento → `required`. Recebimento → `optional`. **Saída `unknown` → `required`.** | Dispensar comprovante por engano esconde uma pendência real; pedir a mais só custa uma confirmação. |
| D68 | Regras deliberadamente estreitas: "TAXA" sozinha não é tarifa (taxa de condomínio é pagamento); "TAR" só com complemento (TAR PIX, TAR PACOTE…); "ENTRE CONTAS" sozinho não é conta própria (pode ser terceiro no mesmo banco) — exige "MESMA TITULARIDADE", "MESMO TITULAR" ou "CONTA(S) PRÓPRIA(S)". | Evitar falso "não exige comprovante". |
| D69 | **Mudança mínima no STEP 02:** `ParsedTransaction` ganhou `bankType` (OFX `TRNTYPE`; `null` em CSV). Nenhuma outra mudança no leitor. | O leitor descartava o tipo FEE/ATM que o próprio banco informa — evidência real para a classificação. Os 226 testes do STEP 02 continuam passando. |
| D70 | **Mudança compatível no contrato:** `ResultTransactionSchema` ganhou `category` **opcional** (as 7 categorias). `kind` continua com os mesmos 4 valores e o mesmo significado nos casos C01–C13 (mapeamento em `categoryToKind`). Gabarito do STEP 03 não foi alterado. | O contrato só tinha `kind` (4 valores): saque, pagamento, recebimento e desconhecido virariam todos "normal", sem o Worker conseguir dizer qual. |
| D71 | **Mutation testing automatizado** (`npm run test:mutation`): 16 mutações no código do STEP 04; o script exige que cada uma faça os testes falharem, verifica que o trecho-alvo existe exatamente 1 vez e restaura o código sempre. | Prova que os testes enxergam os erros que importam, não só que passam. |
