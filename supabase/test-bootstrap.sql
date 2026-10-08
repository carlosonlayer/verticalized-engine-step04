-- SÓ PARA TESTES LOCAIS. Nunca rodar no Supabase.
-- Recria o mínimo que o Supabase já oferece pronto: schema auth, tabela
-- auth.users e os papéis anon / authenticated / service_role.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- Simula o comportamento padrão do Supabase: tabelas novas do schema public
-- recebem privilégios para anon/authenticated. A migração precisa revogá-los.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
