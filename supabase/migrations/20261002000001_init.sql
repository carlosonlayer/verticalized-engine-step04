-- =====================================================================
-- VERTICALIZED — Work Engine v0 — migração inicial
-- Worker #001: Financeiro · Fechar o mês
--
-- Regras de modelagem:
--   * Dinheiro SEMPRE em centavos inteiros (bigint). Nunca float/numeric.
--   * Saída de dinheiro = valor negativo. Entrada = positivo. Zero não existe.
--   * Todo achado (finding) tem pelo menos 1 evidência — garantido no banco.
--   * Transições de estado do trabalho são validadas no banco.
--   * RLS ligado em todas as tabelas, SEM policies: só o backend (service role) acessa.
--   * Arquivo bruto, texto completo e resposta bruta do Gemini NÃO têm coluna:
--     não existe onde guardá-los, por desenho.
-- =====================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid() (já nativo no PG13+, mantido por segurança)

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type work_status as enum (
  'received', 'processing', 'validating', 'completed', 'needs_review', 'failed'
);

-- ---------------------------------------------------------------------
-- Função utilitária: evidência válida = array JSON com >= 1 item,
-- cada item com document_id, file_name, page, excerpt, method, verified.
-- ---------------------------------------------------------------------
create or replace function is_valid_evidence(ev jsonb)
returns boolean
language sql
immutable
as $$
  select
    jsonb_typeof(ev) = 'array'
    and jsonb_array_length(ev) >= 1
    and not exists (
      select 1
      from jsonb_array_elements(ev) as item
      where jsonb_typeof(item) <> 'object'
         or not (item ? 'document_id' and item ? 'file_name' and item ? 'page'
                 and item ? 'excerpt' and item ? 'method' and item ? 'verified')
         or (item ->> 'method') not in ('structured', 'text', 'vision')
         or jsonb_typeof(item -> 'verified') <> 'boolean'
    );
$$;

-- ---------------------------------------------------------------------
-- WORKSPACES — "Minha equipe". 1 por usuário no v0.
-- ---------------------------------------------------------------------
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Minha equipe',
  created_at  timestamptz not null default now(),
  unique (owner_id)
);

-- ---------------------------------------------------------------------
-- WORKS — um trabalho entregue pelo usuário.
-- ---------------------------------------------------------------------
create table works (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  created_by          uuid not null references auth.users(id) on delete cascade,
  worker              text not null default 'finance.month_close'
                        check (worker in ('finance.month_close')),
  status              work_status not null default 'received',
  stage               text check (stage in ('reading_statement', 'reading_documents', 'matching', 'validating', 'writing')),
  progress            jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  period_month        date check (period_month is null or extract(day from period_month) = 1),
  account_label       text,
  balance_check       jsonb,
  summary             jsonb,
  pending_actions     jsonb,
  accountant_message  text,
  review_reasons      text[] not null default '{}',
  error_code          text,
  error_message       text,
  metrics             jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  updated_at          timestamptz not null default now(),

  -- failed sempre explica o motivo; os demais estados não carregam erro.
  constraint works_failed_has_error
    check ((status = 'failed') = (error_code is not null)),
  -- needs_review sempre diz por quê.
  constraint works_needs_review_has_reasons
    check (status <> 'needs_review' or cardinality(review_reasons) > 0)
);

create index works_workspace_created_idx on works (workspace_id, created_at desc);
create index works_status_updated_idx on works (status, updated_at) where status in ('received', 'processing', 'validating');

-- ---------------------------------------------------------------------
-- DOCUMENTS — metadados + campos extraídos de cada arquivo recebido.
-- O arquivo em si nunca é gravado.
-- ---------------------------------------------------------------------
create table documents (
  id                          uuid primary key default gen_random_uuid(),
  work_id                     uuid not null references works(id) on delete cascade,
  role                        text not null check (role in ('statement', 'supporting')),
  file_name                   text not null check (length(file_name) between 1 and 255),
  mime                        text not null,
  sha256                      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes                  integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  page_count                  integer check (page_count is null or page_count > 0),
  extraction_method           text check (extraction_method in ('ofx', 'csv', 'pdf_text', 'vision')),
  extraction_status           text not null default 'pending'
                                check (extraction_status in ('pending', 'ok', 'partial', 'illegible', 'failed')),
  document_type               text check (document_type in (
                                'bank_statement', 'pix_receipt', 'transfer_receipt', 'boleto',
                                'boleto_payment_receipt', 'nfe_danfe', 'nfse', 'card_receipt',
                                'other_receipt', 'not_financial', 'unreadable')),
  counterparty                text,
  counterparty_tax_id_masked  text,
  document_amount_cents       bigint check (document_amount_cents is null or document_amount_cents > 0),
  paid_amount_cents           bigint check (paid_amount_cents is null or paid_amount_cents > 0),
  issue_date                  date,
  due_date                    date,
  payment_date                date,
  document_number             text,
  direction                   text not null default 'unknown' check (direction in ('in', 'out', 'unknown')),
  duplicate_of                uuid references documents(id) on delete set null,
  evidence                    jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  created_at                  timestamptz not null default now(),

  -- Mesmo arquivo (mesmo hash) no mesmo trabalho = ignorado na entrada.
  unique (work_id, sha256),
  -- Documento extraído com sucesso precisa ter de onde veio cada dado.
  constraint documents_ok_has_evidence
    check (extraction_status not in ('ok', 'partial') or role = 'statement' or is_valid_evidence(evidence))
);

create index documents_work_idx on documents (work_id);
-- No v0: exatamente 1 extrato por trabalho.
create unique index documents_one_statement_per_work on documents (work_id) where role = 'statement';

-- ---------------------------------------------------------------------
-- TRANSACTIONS — movimentações do extrato.
-- ---------------------------------------------------------------------
create table transactions (
  id                   uuid primary key default gen_random_uuid(),
  work_id              uuid not null references works(id) on delete cascade,
  document_id          uuid not null references documents(id) on delete cascade,
  seq                  integer not null check (seq >= 1),
  date                 date not null,
  description          text not null,
  amount_cents         bigint not null check (amount_cents <> 0),
  direction            text not null check (direction in ('in', 'out')),
  balance_after_cents  bigint,
  fitid                text,
  kind                 text not null default 'normal'
                         check (kind in ('normal', 'fee', 'own_transfer', 'investment')),
  status               text not null default 'pending' check (status in (
                         'pending', 'matched', 'needs_confirmation', 'missing_receipt',
                         'divergent', 'no_receipt_needed', 'unmatched_credit')),
  evidence             jsonb not null check (is_valid_evidence(evidence)),
  created_at           timestamptz not null default now(),

  -- Regra de sinal: saída é negativa, entrada é positiva.
  constraint transactions_sign_matches_direction
    check ((direction = 'out' and amount_cents < 0) or (direction = 'in' and amount_cents > 0)),
  unique (work_id, seq)
);

create index transactions_work_idx on transactions (work_id);
-- FITID repetido no mesmo trabalho é falha de exportação: o parser remove antes de inserir.
create unique index transactions_fitid_unique on transactions (work_id, fitid) where fitid is not null;

-- ---------------------------------------------------------------------
-- MATCHES — pares movimentação ↔ documento. Grupos N:1 e 1:N
-- compartilham o mesmo group_key.
-- ---------------------------------------------------------------------
create table matches (
  id                 uuid primary key default gen_random_uuid(),
  work_id            uuid not null references works(id) on delete cascade,
  group_key          text not null,
  transaction_id     uuid not null references transactions(id) on delete cascade,
  document_id        uuid not null references documents(id) on delete cascade,
  rule               text not null check (rule in ('exact', 'exclusive', 'grouped', 'partial', 'with_fees')),
  status             text not null check (status in ('confirmed', 'needs_confirmation', 'rejected_by_user')),
  score              numeric(4, 3) not null check (score between 0 and 1),
  amount_diff_cents  bigint not null default 0,
  created_at         timestamptz not null default now(),

  unique (transaction_id, document_id),
  -- Confirmação automática só existe para regras 1:1 de alta confiança.
  constraint matches_auto_confirm_only_simple_rules
    check (status <> 'confirmed' or rule in ('exact', 'exclusive'))
);

create index matches_work_idx on matches (work_id);

-- ---------------------------------------------------------------------
-- FINDINGS — achados/pendências. Criados SEMPRE pelo código.
-- ---------------------------------------------------------------------
create table findings (
  id               uuid primary key default gen_random_uuid(),
  work_id          uuid not null references works(id) on delete cascade,
  type             text not null check (type in (
                     'missing_receipt', 'amount_divergence', 'duplicate_transaction',
                     'payment_duplication', 'duplicate_document', 'unmatched_document',
                     'needs_confirmation', 'grouped_payment', 'paid_with_fees',
                     'unreadable_document', 'unverified_extraction', 'out_of_period',
                     'balance_failure')),
  severity         text not null check (severity in ('high', 'medium', 'low')),
  title            text not null,
  explanation      text not null,
  transaction_id   uuid references transactions(id) on delete cascade,
  document_id      uuid references documents(id) on delete cascade,
  match_id         uuid references matches(id) on delete set null,
  expected_cents   bigint,
  found_cents      bigint,
  diff_cents       bigint,
  evidence         jsonb not null check (is_valid_evidence(evidence)),
  user_resolution  text check (user_resolution in ('confirmed', 'dismissed')),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),

  -- Diferença sempre coerente com os valores (quando os três existem).
  constraint findings_diff_consistent
    check (expected_cents is null or found_cents is null or diff_cents is null
           or diff_cents = expected_cents - found_cents),
  constraint findings_resolution_has_timestamp
    check ((user_resolution is null) = (resolved_at is null))
);

create index findings_work_idx on findings (work_id);

-- ---------------------------------------------------------------------
-- EVENTS — métricas de produto. props NUNCA carrega conteúdo de documento.
-- ---------------------------------------------------------------------
create table events (
  id            bigserial primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  work_id       uuid references works(id) on delete cascade,
  name          text not null check (name in (
                  'work_created', 'work_started', 'work_completed', 'work_needs_review',
                  'work_failed', 'upload_rejected', 'evidence_opened', 'finding_feedback',
                  'message_copied', 'export_downloaded', 'would_use_next_month',
                  'fitid_duplicate_removed', 'duplicate_file_ignored', 'work_deleted')),
  props         jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  created_at    timestamptz not null default now()
);

create index events_workspace_name_idx on events (workspace_id, name, created_at);

-- ---------------------------------------------------------------------
-- Máquina de estados do trabalho (garantida no banco)
--   received   → processing | failed
--   processing → validating | failed
--   validating → completed | needs_review | failed
--   completed / needs_review / failed → (final)
-- ---------------------------------------------------------------------
create or replace function enforce_work_transition()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();

  if new.status = old.status then
    return new;
  end if;

  if not (
       (old.status = 'received'   and new.status in ('processing', 'failed'))
    or (old.status = 'processing' and new.status in ('validating', 'failed'))
    or (old.status = 'validating' and new.status in ('completed', 'needs_review', 'failed'))
  ) then
    raise exception 'invalid work status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'processing' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status in ('completed', 'needs_review', 'failed') and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

create trigger works_status_transition
  before update on works
  for each row execute function enforce_work_transition();

-- Trabalho sempre nasce em 'received'.
create or replace function enforce_work_initial_status()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'received' then
    raise exception 'work must be created with status received (got %)', new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger works_initial_status
  before insert on works
  for each row execute function enforce_work_initial_status();

-- ---------------------------------------------------------------------
-- Segurança: RLS ligado, nenhuma policy, nenhum privilégio para anon/authenticated.
-- A service role (backend) ignora RLS por design do Supabase.
-- ---------------------------------------------------------------------
alter table workspaces   enable row level security;
alter table works        enable row level security;
alter table documents    enable row level security;
alter table transactions enable row level security;
alter table matches      enable row level security;
alter table findings     enable row level security;
alter table events       enable row level security;

revoke all on workspaces, works, documents, transactions, matches, findings, events from anon, authenticated;
revoke all on sequence events_id_seq from anon, authenticated;
