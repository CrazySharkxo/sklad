-- Мінімальна імітація того, що Supabase дає з коробки, для перевірки schema.sql
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key default gen_random_uuid(), aud text, role text, email text,
  encrypted_password text, email_confirmed_at timestamptz, last_sign_in_at timestamptz, banned_until timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz default now(), updated_at timestamptz,
  confirmation_token text, email_change text, email_change_token_new text, recovery_token text);
create table auth.identities (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, provider_id text not null,
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
-- pgcrypto у Supabase живе в схемі extensions; тут його нема — імітуємо
create schema extensions;
create function extensions.gen_salt(text) returns text language sql as $$ select 'bf$salt' $$;
create function extensions.crypt(text, text) returns text language sql as $$ select md5($1 || $2) $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create publication supabase_realtime;
