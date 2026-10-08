# verticalized-engine

Work Engine v0 da **VERTICALIZED | Sua equipe de IA**.
Worker #001: **Financeiro · Fechar o mês**.

> Regra central: **LLM extrai. Código decide.**

## Estado atual: STEP 04 concluído

| Item | Estado |
|---|---|
| Node 22 + TypeScript + Express | ✅ |
| `GET /health` → 200 | ✅ testado |
| Configuração validada na inicialização (produção sem config não sobe) | ✅ testado |
| Logs estruturados para o Cloud Logging, sem conteúdo de documento | ✅ testado |
| Formato único de erro `{code, message, file?}` | ✅ testado |
| CORS restrito por lista | ✅ testado |
| Migração inicial: 7 tabelas, centavos em `bigint`, RLS, máquina de estados no banco | ✅ testado em PostgreSQL 16 real |
| Dockerfile + script de deploy no Cloud Run | ✅ no ar em produção, `/health` → 200 |
| **STEP 02** — dinheiro em centavos inteiros (sem float), datas sem fuso, leitores OFX (SGML/XML) e CSV, mascaramento de CPF/conta | ✅ 187 testes novos (226 no total), incluindo gravação real no Postgres |
| **STEP 03** — dataset de regressão C01–C13 + juiz automático + contrato do Worker | ✅ 168 testes novos (394 no total) + 14 pendentes (Worker real, a partir do STEP 07). Ver [`test/regression/README.md`](test/regression/README.md) |
| **STEP 04** — validação estrutural, saldo (passed / failed / structural_only / not_available, ordem newest-first) e classificação com regra "não exige comprovante" | ✅ testes de unidade, propriedade (400 extratos aleatórios), integração com o dataset e 16/16 mutações mortas |

Decisões tomadas: [`docs/DECISIONS.md`](docs/DECISIONS.md) · Questões jurídicas: [`docs/LGPD-QUESTIONS.md`](docs/LGPD-QUESTIONS.md)

## Estrutura

```
src/
  server.ts            inicialização + desligamento gracioso (SIGTERM do Cloud Run)
  app.ts               monta o Express (CORS, segurança, rotas, erros)
  config/env.ts        variáveis de ambiente validadas com zod
  lib/logger.ts        log JSON (campo "severity") + redação de campos sensíveis
  lib/errors.ts        AppError com código estável
  lib/supabase.ts      cliente do backend (service role) — só no servidor
  middleware/http.ts   request id, log de acesso, cabeçalhos, tratamento de erro
  routes/health.ts     GET /health
  lib/mask.ts          mascaramento de CPF, e-mail, telefone, agência/conta
  workers/finance-month-close/parsers/
    money.ts           texto → centavos inteiros (sem float, sem arredondar)
    date.ts            datas AAAA-MM-DD, sempre dia/mês/ano, sem fuso
    encoding.ts        UTF-8 ou Windows-1252 (tabela própria)
    ofx.ts             leitor OFX 1.x (SGML) e 2.x (XML)
    csv.ts             leitor CSV (separador, cabeçalho, colunas, decimal)
    fitid.ts           regras de FITID repetido
    statement.ts       porta de entrada: bytes → extrato; limites; linhas p/ o banco
  workers/finance-month-close/contract.ts   CONTRATO do Worker (entrada, resultado, desfechos)
  workers/finance-month-close/statement/
    validate.ts        validação estrutural do extrato
    balance.ts         saldo: inicial/final, linha a linha, ordem, structural_only
    classify.ts        categorias + "não exige comprovante" (regras explícitas)
    analyze.ts         ponto de entrada: extrato → saldo + classificação
supabase/
  migrations/…_init.sql   migração real (rodar no Supabase)
  test-bootstrap.sql      SÓ para testes locais (imita o que o Supabase já tem)
test/                  testes: unit/ (parsers), integration/ (parser → Postgres), app, migration
test/fixtures/         extratos SINTÉTICOS (gerados por scripts/gen-statement-fixtures.mjs)
test/regression/       dataset C01–C13, juiz (harness) e portão do Worker real
deploy/cloudrun.sh     deploy no Cloud Run
```

## Rodar os testes (desenvolvedor)

```bash
npm install
export TEST_DATABASE_URL=$(bash scripts/test-db.sh up)   # sobe Postgres 16 local descartável
npm run verify          # RELATÓRIO OFICIAL: typecheck + build + testes + suítes + exit code
npm run test:mutation   # prova que os testes do STEP 04 pegam erros (16 mutações)
bash scripts/test-db.sh down
```

Uma execução só é PASS se o `verify` terminar com `RESULTADO: PASS`. "0 testes falharam"
não basta: uma suíte que quebra antes de rodar (ex.: banco fora do ar) também é FAIL.

---

# Passo a passo para colocar no ar (para quem nunca fez)

Você vai fazer 3 coisas, nesta ordem: **(A)** criar o banco no Supabase,
**(B)** guardar a chave no Google Cloud, **(C)** publicar a API no Cloud Run.
Os nomes de botões podem variar um pouco conforme a versão das telas.

## A) Supabase — banco de dados (projeto NOVO, separado da Ízis)

1. Abra **https://supabase.com/dashboard** e entre na sua conta.
2. Clique no botão verde **New project**.
3. Preencha:
   - **Name:** `verticalized`
   - **Database Password:** clique em **Generate a password** e guarde a senha num gerenciador de senhas.
   - **Region:** escolha **South America (São Paulo)**. Isso é importante (dados no Brasil).
4. Clique em **Create new project** e espere 1–2 minutos até o painel carregar.
5. Na barra lateral esquerda, clique no ícone **SQL Editor** (parece um terminal `>_`).
6. Clique em **New query** (ou no **+**).
7. Abra no seu computador o arquivo `supabase/migrations/20261002000001_init.sql`, copie **todo** o conteúdo e cole na área de texto.
   - ⚠️ **Não** cole o arquivo `test-bootstrap.sql`. Ele é só para teste local.
8. Clique em **Run** (canto inferior direito) ou aperte `Ctrl+Enter`. Deve aparecer **Success. No rows returned**.
9. Confira: na barra lateral, clique em **Table Editor**. Devem aparecer 7 tabelas:
   `documents`, `events`, `findings`, `matches`, `transactions`, `works`, `workspaces`.
   Cada uma deve mostrar o selo **RLS enabled** (ou sem o aviso "RLS disabled").
10. Pegue os dois dados de conexão:
    - **URL do projeto:** clique no botão **Connect** no topo da página (ou **Project Settings** → **Data API**). Copie o endereço no formato `https://xxxx.supabase.co`.
    - **Chave secreta do backend:** **Project Settings** (ícone de engrenagem, embaixo à esquerda) → **API Keys**. Copie a chave **secret** (começa com `sb_secret_…`) ou, na aba **Legacy API keys**, a chave **service_role**.
    - ⚠️ Essa chave dá acesso total ao banco. Nunca cole em frontend, chat, e-mail ou repositório.

## B) Google Cloud — projeto e segredo

1. Abra **https://console.cloud.google.com**.
2. No topo, clique no seletor de projeto (ao lado do logo **Google Cloud**) → **New project** → nome `verticalized` → **Create**. Selecione o projeto novo no mesmo seletor.
3. Confirme que há faturamento ativo: menu ☰ → **Billing**. Se pedir, vincule uma conta de faturamento. O Cloud Run cobra pouco nesse volume, mas exige faturamento.
4. Abra o terminal do Google: no canto superior direito, clique no ícone **Activate Cloud Shell** (`>_`). Um terminal abre na parte de baixo da tela.
5. Cole os comandos abaixo, **um bloco por vez**, trocando `SEU_PROJECT_ID` pelo ID que aparece no seletor de projeto (ex.: `verticalized-472813`):

```bash
export PROJECT_ID=SEU_PROJECT_ID
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

```bash
# Conta de serviço própria da API (permissão mínima)
gcloud iam service-accounts create verticalized-engine --display-name "VERTICALIZED engine"
```

6. Crie o segredo com a chave do Supabase. O comando abaixo **pede a chave sem mostrá-la na tela**: cole a chave e aperte Enter.

```bash
read -s -p "Cole a chave secreta do Supabase e aperte Enter: " KEY && echo
printf '%s' "$KEY" | gcloud secrets create verticalized-supabase-service-role --data-file=-
unset KEY
gcloud secrets add-iam-policy-binding verticalized-supabase-service-role \
  --member "serviceAccount:verticalized-engine@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
```

## C) Cloud Run — publicar a API

1. Ainda no Cloud Shell, envie o projeto: clique nos **três pontinhos (⋮)** na barra do terminal → **Upload** → escolha o arquivo `verticalized-engine-step01.zip`.
2. Descompacte e entre na pasta:

```bash
unzip -o verticalized-engine-step01.zip -d verticalized-engine && cd verticalized-engine
```

3. Defina a URL do Supabase e a origem do frontend (por enquanto pode ser um endereço provisório) e rode o deploy:

```bash
export SUPABASE_URL=https://xxxx.supabase.co
export CORS_ORIGINS=https://app.seudominio.com.br
bash deploy/cloudrun.sh
```

4. Se perguntar algo como *"Deploying from source requires an Artifact Registry repository… create?"*, responda **Y**.
5. No fim, o script chama o `/health` sozinho. Deve aparecer:

```json
{"status":"ok","service":"verticalized-engine","version":"…"}
```

✅ Se apareceu isso, o STEP 01 está no ar.

### Se der erro
- **`invalid_configuration` nos logs:** faltou `SUPABASE_URL`, `CORS_ORIGINS` ou o segredo. O log mostra **o nome** do que faltou (nunca o valor).
- **`Permission denied on secret`:** rode de novo o último comando do item B.6.
- Logs: menu ☰ → **Cloud Run** → `verticalized-engine` → aba **Logs**.
