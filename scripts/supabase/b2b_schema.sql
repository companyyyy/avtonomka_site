-- Автономка: B2B-кабінет (/b2b/) - клієнти-партнери, їх вхід і замовлення.
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run,
-- ПІСЛЯ miniapp_tracking_schema.sql (tg_admins, is_tg_admin()) і
-- orders_schema.sql (orders). Безпечно запускати повторно.
--
-- Хто є хто в Supabase Auth:
--   - адміни сайту - як і раніше (створені вручну, список tg_admins);
--   - B2B-клієнти - користувачі з app_metadata.role = 'b2b'. Їх створює лише
--     Edge Function supabase/functions/b2b (ключем service_role), коли менеджер
--     схвалює заявку або додає клієнта в адмінці (b2b-admin/). Відкриту
--     реєстрацію в Supabase Auth НЕ вмикати: заявка йде через функцію.
--
-- ⚠ Багато старих політик пускають будь-якого authenticated (статті, коментарі,
-- аукціон, віртуальні товари, Storage). Щоб B2B-клієнт не отримав ці права,
-- розділ 3 додає на КОЖНУ таблицю public і на storage.objects обмежувальну
-- (restrictive) політику «not is_b2b_client()». Для нової таблиці, створеної
-- пізніше, просто запустіть цей файл ще раз.

-- ─── 1. Роль ───────────────────────────────────────────────────────────

-- app_metadata ставить лише сервер (service_role), користувач сам його не змінить.
create or replace function public.is_b2b_client()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'b2b';
$$;
grant execute on function public.is_b2b_client() to anon, authenticated;

-- ─── 2. Клієнти ────────────────────────────────────────────────────────

create table if not exists public.b2b_clients (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users (id) on delete set null, -- з'являється після схвалення
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'blocked')),
  company       text not null,               -- назва компанії / ФОП
  edrpou        text,                        -- ЄДРПОУ / ІПН
  contact_name  text,
  phone         text,
  email         text not null,               -- він же логін
  city          text,
  comment       text,                        -- коментар клієнта до заявки
  manager_note  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  approved_at   timestamptz
);

create index if not exists b2b_clients_status_idx on public.b2b_clients (status, created_at desc);
create index if not exists b2b_clients_email_idx  on public.b2b_clients (lower(email));

alter table public.b2b_clients enable row level security;
revoke all on public.b2b_clients from anon;

-- Пише лише функція b2b (service_role). Адміни читають усіх, клієнт - себе.
drop policy if exists "admins read b2b_clients" on public.b2b_clients;
create policy "admins read b2b_clients" on public.b2b_clients
  for select to authenticated using (public.is_tg_admin());
drop policy if exists "client reads own b2b_clients" on public.b2b_clients;
create policy "client reads own b2b_clients" on public.b2b_clients
  for select to authenticated using (user_id = auth.uid());

-- Замовлення B2B лежать у тій самій таблиці orders (source = 'B2B'), з
-- посиланням на клієнта - так вони одразу видні в розділі «Замовлення».
alter table public.orders add column if not exists b2b_client_id uuid references public.b2b_clients (id) on delete set null;
create index if not exists orders_b2b_client_idx on public.orders (b2b_client_id, created_at desc);

-- ─── 3. B2B-клієнт не має доступу ні до чого, крім свого ───────────────

do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname <> 'b2b_clients'
  loop
    execute format('drop policy if exists "no b2b clients" on public.%I', t.relname);
    execute format(
      'create policy "no b2b clients" on public.%I as restrictive for all to authenticated
         using (not public.is_b2b_client()) with check (not public.is_b2b_client())', t.relname);
  end loop;
end $$;

drop policy if exists "no b2b clients" on storage.objects;
create policy "no b2b clients" on storage.objects as restrictive for all to authenticated
  using (not public.is_b2b_client()) with check (not public.is_b2b_client());

-- Перевірка: таблиці public без RLS (їх уже зараз може читати будь-хто з
-- anon-ключем, B2B тут ні до чого; має бути порожньо):
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
