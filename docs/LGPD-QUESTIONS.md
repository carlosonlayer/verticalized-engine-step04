# LGPD — questões para validação jurídica

Isto é especificação de engenharia, **não parecer jurídico**. Cada item marcado
**VALIDAR JURIDICAMENTE** precisa de resposta de um profissional antes do teste
com usuários externos (STEP 16).

## O que o sistema já faz por desenho (STEP 01)
- Arquivo bruto, texto completo e resposta bruta do Gemini: **sem coluna no banco**.
- Banco em São Paulo (`sa-east-1`), API em São Paulo (`southamerica-east1`).
- RLS ligado, sem policies; só o backend acessa.
- Logs sem conteúdo de documento (testado).
- Exclusão de um trabalho apaga tudo que pertence a ele em cascata (testado).

## Dados pessoais que podem aparecer
Nomes de pessoas físicas (contrapartes de PIX), CPF, agência/conta, chave PIX
(CPF, e-mail, telefone), endereço em notas, e os próprios dados financeiros do
usuário quando ele é pessoa física/MEI. Descrições de pagamento podem revelar,
por inferência, dado sensível (sindicato, religião, saúde) — o Worker **não
categoriza nem infere** sobre gastos.

## Questões em aberto
1. **VALIDAR JURIDICAMENTE** — Papel da VERTICALIZED: operadora (cliente PJ tratando dados de terceiros), controladora (dados da conta do usuário) e qual papel quando o cliente é PF/MEI tratando os próprios dados.
2. **VALIDAR JURIDICAMENTE** — Base legal para os dados de terceiros (contrapartes) contidos nos documentos.
3. **VALIDAR JURIDICAMENTE** — Envio de conteúdo ao Gemini (provável processamento fora do Brasil): transferência internacional (até onde sabemos, Res. CD/ANPD nº 19/2024), suficiência dos termos/DPA do Google; necessidade de cláusulas-padrão.
4. **VALIDAR JURIDICAMENTE** — Prazo de retenção dos dados normalizados e trechos de evidência.
5. **VALIDAR JURIDICAMENTE** — "Não categorizar" é mitigação suficiente para dado sensível por inferência?
6. **VALIDAR JURIDICAMENTE** — Termos de uso e política de privacidade mínimos para o teste gratuito.
7. **VALIDAR JURIDICAMENTE** — Fronteira com atividade contábil (texto do disclaimer e da mensagem ao contador).
8. **VALIDAR JURIDICAMENTE** — Uso de meses reais de terceiros em vídeo/demonstração (anonimização e consentimento).
