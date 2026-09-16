-- Автономка: аукціон (лоти, учасники, ставки) в Supabase.
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run.
-- Безпечно запускати повторно (IF NOT EXISTS / OR REPLACE / DROP POLICY IF
-- EXISTS), окрім рядків "alter publication" наприкінці - якщо таблицю вже
-- додано до реплікації, Supabase скаже про помилку, це нормально.
--
-- ⚠ ПЕРЕД ЗАПУСКОМ - створити окремого Auth-користувача для аукціонної
-- адмінки: Dashboard → Authentication → Users → Add user (інша пошта, ніж
-- у звичайного admin.html). Одразу після цього виконай окремо (підставивши
-- реальний email), щоб цей користувач НЕ бачив статті/коментарі/віртуальні
-- товари - лише аукціон:
--
--   update auth.users
--   set raw_app_meta_data = raw_app_meta_data || '{"role":"auction_admin"}'::jsonb
--   where email = 'auction-admin@example.com';
--
-- Звичайний адмін (яким уже заходиш у admin.html) нічого міняти не повинен -
-- у нього немає цього claim, тож він і далі бачить усе, включно з аукціоном.

-- ============================================================
-- 1. Лоти
-- ============================================================
create table if not exists public.auction_lots (
  id               bigint generated always as identity primary key,
  slug             text        not null unique,   -- для URL auction-lot.html?id=<slug>
  title            text        not null,
  description      text,
  condition_note   text,                            -- опис дефекту/стану товару
  media            jsonb       not null default '[]'::jsonb, -- [{type:"photo"|"video", url:"..."}]
  starting_price   numeric     not null,
  bid_step         numeric     not null,            -- мінімальний крок ставки
  current_price    numeric     not null,            -- дублює найвищу ставку, оновлює place_bid()
  leader_bid_id    bigint,                          -- логічний FK на auction_bids.id (без constraint - таблиця нижче)
  status           text        not null default 'draft' check (status in ('draft','active','cancelled')),
  starts_at        timestamptz,
  ends_at          timestamptz not null,
  created_at       timestamptz not null default now()
);

create index if not exists auction_lots_status_ends_at_idx
  on public.auction_lots (status, ends_at);

alter table public.auction_lots enable row level security;

-- Публічний сайт бачить лише активні лоти (draft/cancelled - тільки адмін).
drop policy if exists "anon can read active lots" on public.auction_lots;
create policy "anon can read active lots"
  on public.auction_lots for select
  to anon
  using (status = 'active');

-- Обидва типи адміна (звичайний і auction_admin) керують лотами повністю.
drop policy if exists "authenticated can read all lots" on public.auction_lots;
create policy "authenticated can read all lots"
  on public.auction_lots for select
  to authenticated
  using (true);

drop policy if exists "authenticated can insert lots" on public.auction_lots;
create policy "authenticated can insert lots"
  on public.auction_lots for insert
  to authenticated
  with check (true);

drop policy if exists "authenticated can update lots" on public.auction_lots;
create policy "authenticated can update lots"
  on public.auction_lots for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated can delete lots" on public.auction_lots;
create policy "authenticated can delete lots"
  on public.auction_lots for delete
  to authenticated
  using (true);

-- ============================================================
-- 2. Зареєстровані учасники
-- ============================================================
create table if not exists public.auction_bidders (
  id           uuid        primary key default gen_random_uuid(), -- зберігається в localStorage клієнта
  name         text        not null,
  phone        text        not null,
  email        text,
  consent      boolean     not null default false,
  created_at   timestamptz not null default now()
);

alter table public.auction_bidders enable row level security;

-- Будь-хто може зареєструватись, але лише з відміченою згодою; SELECT
-- анонімам заборонено - інакше можна було б підглянути чужі телефони через
-- публічний anon-ключ.
drop policy if exists "anon can register as bidder" on public.auction_bidders;
create policy "anon can register as bidder"
  on public.auction_bidders for insert
  to anon
  with check (consent = true);

-- Повну картку учасника (ім'я, телефон) бачить лише адмін - обидва типи,
-- саме заради цього й існує окрема аукціонна адмінка.
drop policy if exists "authenticated can read bidders" on public.auction_bidders;
create policy "authenticated can read bidders"
  on public.auction_bidders for select
  to authenticated
  using (true);

-- ============================================================
-- 3. Ставки
-- ============================================================
create table if not exists public.auction_bids (
  id            bigint generated always as identity primary key,
  lot_id        bigint      not null references public.auction_lots(id) on delete cascade,
  bidder_id     uuid        not null references public.auction_bidders(id),
  display_name  text        not null,  -- "Учасник 1" тощо - НІКОЛИ не справжнє ім'я/телефон
  amount        numeric     not null,
  created_at    timestamptz not null default now()
);

create index if not exists auction_bids_lot_id_created_at_idx
  on public.auction_bids (lot_id, created_at desc);

alter table public.auction_bids enable row level security;

-- Публічна стрічка ставок - лише для активних лотів (щоб не світити ставки
-- на ще неопублікований draft-лот), без телефонів/імен - тільки display_name.
drop policy if exists "anon can read bids of active lots" on public.auction_bids;
create policy "anon can read bids of active lots"
  on public.auction_bids for select
  to anon
  using (exists (
    select 1 from public.auction_lots l
    where l.id = auction_bids.lot_id and l.status = 'active'
  ));

-- Адмін (обидва типи) бачить історію ставок будь-якого лота, включно з draft.
drop policy if exists "authenticated can read all bids" on public.auction_bids;
create policy "authenticated can read all bids"
  on public.auction_bids for select
  to authenticated
  using (true);

-- Жодного прямого INSERT ні для anon, ні для authenticated - єдиний
-- легальний спосіб поставити ставку - RPC-функція place_bid() нижче
-- (SECURITY DEFINER, вставляє від імені власника функції, минаючи цю
-- відсутність policy).

-- ============================================================
-- 4. RPC place_bid() - єдиний легальний спосіб поставити ставку
-- ============================================================
create or replace function public.place_bid(p_lot_id bigint, p_bidder_id uuid, p_amount numeric)
returns public.auction_lots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lot          public.auction_lots%rowtype;
  v_bidder_ok    boolean;
  v_display_name text;
  v_bid_id       bigint;
begin
  select exists(select 1 from public.auction_bidders where id = p_bidder_id) into v_bidder_ok;
  if not v_bidder_ok then
    raise exception 'unknown_bidder';
  end if;

  select * into v_lot from public.auction_lots where id = p_lot_id for update;
  if not found then
    raise exception 'lot_not_found';
  end if;
  if v_lot.status <> 'active' then
    raise exception 'lot_not_active';
  end if;
  if now() >= v_lot.ends_at then
    raise exception 'lot_ended';
  end if;
  if p_amount < v_lot.current_price + v_lot.bid_step then
    raise exception 'bid_too_low';
  end if;

  -- той самий учасник завжди отримує той самий "Учасник N" у межах лота
  select display_name into v_display_name
  from public.auction_bids
  where lot_id = p_lot_id and bidder_id = p_bidder_id
  limit 1;

  if v_display_name is null then
    select 'Учасник ' || (count(distinct bidder_id) + 1)::text
    into v_display_name
    from public.auction_bids
    where lot_id = p_lot_id;
  end if;

  insert into public.auction_bids (lot_id, bidder_id, display_name, amount)
  values (p_lot_id, p_bidder_id, v_display_name, p_amount)
  returning id into v_bid_id;

  update public.auction_lots
  set current_price = p_amount, leader_bid_id = v_bid_id
  where id = p_lot_id
  returning * into v_lot;

  return v_lot;
end;
$$;

grant execute on function public.place_bid(bigint, uuid, numeric) to anon, authenticated;

-- ============================================================
-- 5. Storage bucket для фото/відео лотів
-- ============================================================
insert into storage.buckets (id, name, public)
values ('auction-media', 'auction-media', true)
on conflict (id) do nothing;

drop policy if exists "public can read auction-media" on storage.objects;
create policy "public can read auction-media"
  on storage.objects for select
  to public
  using (bucket_id = 'auction-media');

drop policy if exists "authenticated can upload auction-media" on storage.objects;
create policy "authenticated can upload auction-media"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'auction-media');

drop policy if exists "authenticated can update auction-media" on storage.objects;
create policy "authenticated can update auction-media"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'auction-media')
  with check (bucket_id = 'auction-media');

drop policy if exists "authenticated can delete auction-media" on storage.objects;
create policy "authenticated can delete auction-media"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'auction-media');

-- ============================================================
-- 6. Реалтайм - підписка на зміни ставок/лотів без перезавантаження сторінки
-- ============================================================
alter publication supabase_realtime add table public.auction_bids;
alter publication supabase_realtime add table public.auction_lots;

-- ============================================================
-- 7. Ізоляція ролей - auction_admin НЕ бачить статті/коментарі/віртуальні
--    товари. Звичайний admin (без цього claim) бачить усе, включно з
--    аукціоном (розділи 1-3 вище навмисно лишились "to authenticated
--    using (true)" без цієї перевірки).
-- ============================================================

-- Статті
drop policy if exists "authenticated can insert articles" on public.articles;
create policy "authenticated can insert articles"
  on public.articles for insert
  to authenticated
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can update articles" on public.articles;
create policy "authenticated can update articles"
  on public.articles for update
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can delete articles" on public.articles;
create policy "authenticated can delete articles"
  on public.articles for delete
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

-- Коментарі
drop policy if exists "authenticated can read all comments" on public.comments;
create policy "authenticated can read all comments"
  on public.comments for select
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can update comments" on public.comments;
create policy "authenticated can update comments"
  on public.comments for update
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can delete comments" on public.comments;
create policy "authenticated can delete comments"
  on public.comments for delete
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

-- Віртуальні товари
drop policy if exists "authenticated can read virtual_products" on public.virtual_products;
create policy "authenticated can read virtual_products"
  on public.virtual_products for select
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can insert virtual_products" on public.virtual_products;
create policy "authenticated can insert virtual_products"
  on public.virtual_products for insert
  to authenticated
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can update virtual_products" on public.virtual_products;
create policy "authenticated can update virtual_products"
  on public.virtual_products for update
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin')
  with check (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');

drop policy if exists "authenticated can delete virtual_products" on public.virtual_products;
create policy "authenticated can delete virtual_products"
  on public.virtual_products for delete
  to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'auction_admin');
