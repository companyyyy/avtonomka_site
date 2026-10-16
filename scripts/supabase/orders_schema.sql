-- Автономка: замовлення (кошик сайту, швидка заявка, мініапп) і їх історія.
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run,
-- ПІСЛЯ scripts/supabase/miniapp_tracking_schema.sql (звідти tg_admins і is_tg_admin()).
-- Безпечно запускати повторно (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS).
--
-- Хто пише: Edge Function supabase/functions/order-submit (ключем service_role) -
-- приймає замовлення з сайту й мініаппа, перевіряє поля, відсіює дублі,
-- пише менеджеру в Telegram. Сайт напряму в таблиці не пише.
-- Хто читає й змінює: лише адміни (tg_admins) - розділ «Замовлення» адмінки
-- (orders-admin/). Google Таблиця «Заявки» лишається запасною копією.
--
-- Історія (order_history) пишеться сама: тригер на orders записує кожну зміну
-- статусу, ТТН, нотатки й даних клієнта; товари змінюються лише через
-- save_order_items(), яка теж пише історію.

-- ─── Таблиці ───────────────────────────────────────────────────────────

create sequence if not exists public.orders_number_seq start 1001;

create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  number          bigint not null unique default nextval('public.orders_number_seq'), -- №1001, 1002...
  client_key      text unique,                 -- випадковий ключ із браузера: повторне надсилання того самого замовлення не створює дубль
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  source          text not null,               -- 'Кошик' | 'Швидка заявка' | 'Мініапп'
  status          text not null default 'new'
                  check (status in ('new', 'in_work', 'confirmed', 'paid', 'shipped', 'done', 'cancelled', 'returned')),
  name            text,
  phone           text,
  phone_norm      text,                        -- лише цифри, 380XXXXXXXXX - для пошуку замовлень клієнта
  city            text,
  np_branch       text,                        -- відділення / поштомат Нової Пошти
  payment_method  text,
  comment         text,                        -- коментар клієнта
  tg_id           bigint,                      -- Telegram клієнта (мініапп, перевірено підписом)
  tg_username     text,
  page_url        text,                        -- сторінка, з якої надіслано
  total           numeric(12, 2) not null default 0,
  ttn             text,                        -- номер накладної НП
  manager_note    text
);

alter sequence public.orders_number_seq owned by public.orders.number;

create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists orders_status_idx  on public.orders (status, created_at desc);
create index if not exists orders_phone_idx   on public.orders (phone_norm);

create table if not exists public.order_items (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  position    integer not null default 0,
  product_id  text,                            -- id товару сайту (products.json), якщо відомий
  title       text not null,
  sku         text,
  qty         integer not null default 1 check (qty > 0),
  price       numeric(12, 2),                  -- ціна за одиницю на момент замовлення (або після правки менеджером)
  currency    text not null default 'UAH'
);

create index if not exists order_items_order_idx on public.order_items (order_id, position);

create table if not exists public.order_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null,                   -- created | status | ttn | note | client | items
  old_value   text,
  new_value   text
);

create index if not exists order_history_order_idx on public.order_history (order_id, created_at);

-- ─── Історія змін ──────────────────────────────────────────────────────

create or replace function public.orders_track_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into order_history (order_id, kind, new_value) values (new.id, 'created', new.source);
    return new;
  end if;

  new.updated_at := now();
  if new.status is distinct from old.status then
    insert into order_history (order_id, kind, old_value, new_value) values (new.id, 'status', old.status, new.status);
  end if;
  if new.ttn is distinct from old.ttn then
    insert into order_history (order_id, kind, old_value, new_value) values (new.id, 'ttn', old.ttn, new.ttn);
  end if;
  if new.manager_note is distinct from old.manager_note then
    insert into order_history (order_id, kind, old_value, new_value) values (new.id, 'note', old.manager_note, new.manager_note);
  end if;
  if (new.name, new.phone, new.city, new.np_branch, new.payment_method)
     is distinct from (old.name, old.phone, old.city, old.np_branch, old.payment_method) then
    new.phone_norm := public.normalize_phone(new.phone);
    insert into order_history (order_id, kind, old_value, new_value) values (
      new.id, 'client',
      concat_ws(' · ', old.name, old.phone, old.city, old.np_branch, old.payment_method),
      concat_ws(' · ', new.name, new.phone, new.city, new.np_branch, new.payment_method));
  end if;
  return new;
end;
$$;

-- "+38 (067) 123-45-67" / "067 1234567" -> "380671234567"
create or replace function public.normalize_phone(p text)
returns text
language sql
immutable
as $$
  select case
    when d ~ '^380\d{9}$' then d
    when d ~ '^80\d{9}$'  then '3' || d
    when d ~ '^0\d{9}$'   then '38' || d
    else nullif(d, '')
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s;
$$;

drop trigger if exists orders_track_changes_ins on public.orders;
create trigger orders_track_changes_ins after insert on public.orders
  for each row execute function public.orders_track_changes();

drop trigger if exists orders_track_changes_upd on public.orders;
create trigger orders_track_changes_upd before update on public.orders
  for each row execute function public.orders_track_changes();

-- Замінити товари замовлення (адмінка): items = [{product_id, title, sku, qty, price}].
-- Перераховує суму і пише в історію, що було і що стало.
create or replace function public.save_order_items(p_order uuid, p_items jsonb)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  before_text text;
  after_text  text;
  new_total   numeric(12, 2);
begin
  if not public.is_tg_admin() then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array';
  end if;

  select string_agg(title || ' × ' || qty || coalesce(' по ' || price, ''), '; ' order by position)
    into before_text from order_items where order_id = p_order;

  delete from order_items where order_id = p_order;
  insert into order_items (order_id, position, product_id, title, sku, qty, price, currency)
  select p_order, (ord - 1)::int,
         nullif(it->>'product_id', ''), left(coalesce(it->>'title', ''), 300), nullif(left(it->>'sku', 60), ''),
         greatest(1, least(9999, coalesce((it->>'qty')::int, 1))),
         nullif(it->>'price', '')::numeric, 'UAH'
    from jsonb_array_elements(p_items) with ordinality as t(it, ord)
   where coalesce(it->>'title', '') <> '';

  select coalesce(sum(qty * coalesce(price, 0)), 0),
         string_agg(title || ' × ' || qty || coalesce(' по ' || price, ''), '; ' order by position)
    into new_total, after_text from order_items where order_id = p_order;

  update orders set total = new_total, updated_at = now() where id = p_order;
  if before_text is distinct from after_text then
    insert into order_history (order_id, kind, old_value, new_value) values (p_order, 'items', before_text, after_text);
  end if;
  return new_total;
end;
$$;
revoke all on function public.save_order_items(uuid, jsonb) from public, anon;
grant execute on function public.save_order_items(uuid, jsonb) to authenticated;

-- ─── Доступ ────────────────────────────────────────────────────────────

alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;
alter table public.order_history enable row level security;

-- Supabase за замовчуванням видає права на нові таблиці - забираємо в anon.
revoke all on public.orders, public.order_items, public.order_history from anon;
revoke all on sequence public.orders_number_seq from anon;

drop policy if exists "admins read orders"   on public.orders;
drop policy if exists "admins update orders" on public.orders;
drop policy if exists "admins delete orders" on public.orders;
create policy "admins read orders"   on public.orders for select to authenticated using (public.is_tg_admin());
create policy "admins update orders" on public.orders for update to authenticated using (public.is_tg_admin()) with check (public.is_tg_admin());
create policy "admins delete orders" on public.orders for delete to authenticated using (public.is_tg_admin());

drop policy if exists "admins read order_items" on public.order_items;
create policy "admins read order_items" on public.order_items for select to authenticated using (public.is_tg_admin());

drop policy if exists "admins read order_history" on public.order_history;
create policy "admins read order_history" on public.order_history for select to authenticated using (public.is_tg_admin());
