#!/usr/bin/env bash
# Deploy do verticalized-engine no Cloud Run (rode no Cloud Shell, dentro da pasta do projeto).
#
# Antes, defina (exemplo):
#   export PROJECT_ID=verticalized-prod
#   export SUPABASE_URL=https://xxxx.supabase.co
#   export CORS_ORIGINS=https://app.seudominio.com.br
# E crie o segredo (uma vez):  ver README, seção "Google Cloud".
set -euo pipefail

: "${PROJECT_ID:?defina PROJECT_ID}"
: "${SUPABASE_URL:?defina SUPABASE_URL}"
: "${CORS_ORIGINS:?defina CORS_ORIGINS}"
REGION="${REGION:-southamerica-east1}"
SERVICE="${SERVICE:-verticalized-engine}"
SA="verticalized-engine@${PROJECT_ID}.iam.gserviceaccount.com"
VERSION="$(date +%Y%m%d-%H%M%S)"

SECRETS="SUPABASE_SERVICE_ROLE_KEY=verticalized-supabase-service-role:latest"
# Gemini entra a partir do STEP 05 — só liga se o segredo já existir.
if gcloud secrets describe verticalized-gemini-api-key --project "$PROJECT_ID" >/dev/null 2>&1; then
  SECRETS="${SECRETS},GEMINI_API_KEY=verticalized-gemini-api-key:latest"
fi

# Observação: a variável CORS_ORIGINS usa vírgula; por isso o separador customizado "^@^".
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --service-account "$SA" \
  --no-cpu-throttling \
  --min-instances 0 \
  --max-instances 2 \
  --cpu 1 \
  --memory 1Gi \
  --concurrency 10 \
  --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars "^@^NODE_ENV=production@LOG_LEVEL=info@APP_VERSION=${VERSION}@SUPABASE_URL=${SUPABASE_URL}@CORS_ORIGINS=${CORS_ORIGINS}@GEMINI_MODEL=${GEMINI_MODEL:-}" \
  --set-secrets "$SECRETS"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
echo "Teste: curl ${URL}/health"
curl -fsS "${URL}/health" && echo
