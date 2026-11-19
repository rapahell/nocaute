-- como no Supabase: extensões no schema "extensions", que fica no search_path padrão
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists btree_gist schema extensions;
alter database postgres set search_path = "$user", public, extensions;
-- Simula o mínimo do ambiente Supabase para rodar os testes num Postgres comum
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
-- mesmo comportamento do Supabase: lê do GUC antigo ou do JSON de claims do PostgREST
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')), '') $$;

do $$ begin
  create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- service_role no Supabase ignora RLS e lê as tabelas
alter role service_role bypassrls;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
