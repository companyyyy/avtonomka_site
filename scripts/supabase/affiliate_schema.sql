-- Автономка: партнерська (реферальна) програма для B2B-клієнтів.
-- Виконати у Supabase Dashboard → SQL Editor → New query → Run,
-- ПІСЛЯ miniapp_tracking_schema.sql, orders_schema.sql і b2b_schema.sql.
-- Безпечно запускати повторно (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS).
-- Після першого запуску ще раз запустіть b2b_schema.sql - він додасть
-- обмежувальну політику «no b2b clients» і на нові таблиці.
--
-- Хто є партнером: схвалений B2B-клієнт (b2b_clients), який у кабінеті /b2b/
-- на вкладці «Партнерська програма» погодився з правилами. Окремої реєстрації
-- немає. Код партнера - 6 символів A-Z і 2-9 без схожих 0/O, 1/I.
--
-- Хто пише й читає: лише Edge Functions affiliate, b2b і order-submit (ключем
-- service_role). RLS увімкнено без політик - anon і authenticated закрито
-- (виняток: адміни читають affiliate_settings - курс балу для orders-admin/).
-- Уся грошова логіка - тут, у функціях нижче; функції Edge лише перевіряють,
-- хто викликає, і передають параметри. Інструкція - docs/AFFILIATE.md.
--
-- Бали: 1 бал = point_value грн (за замовчуванням 1). Баланс - не одне число,
-- а сума журналу affiliate_transactions (ledger). Нарахування за замовлення:
-- pending (очікує) → approved (замовлення «Виконано» + hold_days) → бали в
-- журналі; скасування до підтвердження - cancelled, повернення після - reversed
-- (сторно, бали списуються, баланс може піти в мінус).

-- ─── 1. Налаштування ──────────────────────────────────────────────────

create table if not exists public.affiliate_settings (
  id                smallint primary key default 1 check (id = 1),  -- один рядок
  enabled           boolean not null default true,
  default_rate      numeric(5, 2) not null default 3 check (default_rate between 0 and 100),  -- %
  cookie_days       integer not null default 30 check (cookie_days between 1 and 365),
  attribution       text not null default 'last' check (attribution in ('last', 'first')),
  hold_days         integer not null default 14 check (hold_days between 0 and 365),       -- період повернення
  min_payout        numeric(12, 2) not null default 500 check (min_payout >= 0),            -- грн
  max_points_share  numeric(5, 2) not null default 100 check (max_points_share between 0 and 100), -- % суми замовлення
  point_value       numeric(12, 4) not null default 1 check (point_value > 0),               -- грн за 1 бал
  lifetime_days     integer not null default 0 check (lifetime_days between 0 and 3650),     -- 0 = довічна прив'язка вимкнена
  rules_text        text,
  updated_at        timestamptz not null default now()
);
insert into public.affiliate_settings (id) values (1) on conflict (id) do nothing;

-- Ставки по категоріях (scope_id = product_type з products.json, напр.
-- «Автономна енергетика > Гибридні інвертори») і по товарах (scope_id = id товару).
create table if not exists public.affiliate_rates (
  id          bigint generated always as identity primary key,
  scope       text not null check (scope in ('category', 'product')),
  scope_id    text not null,
  rate        numeric(5, 2) not null check (rate between 0 and 100),
  created_at  timestamptz not null default now(),
  unique (scope, scope_id)
);

-- ─── 2. Партнери, переходи ────────────────────────────────────────────

create table if not exists public.affiliates (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null unique references public.b2b_clients (id) on delete restrict,
  code               text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6,8}$'),
  status             text not null default 'active' check (status in ('active', 'blocked')),
  custom_rate        numeric(5, 2) check (custom_rate between 0 and 100),  -- індивідуальний %, null = загальний
  payout_details     text,          -- реквізити, зашифровані функцією affiliate (AES-GCM); ключа в БД немає
  terms_accepted_at  timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create table if not exists public.affiliate_clicks (
  id            bigint generated always as identity primary key,
  affiliate_id  uuid not null references public.affiliates (id) on delete cascade,
  landing_url   text,
  referer       text,
  ip_hash       text,               -- HMAC від IP (сам IP не зберігаємо)
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index if not exists affiliate_clicks_aff_idx on public.affiliate_clicks (affiliate_id, created_at desc);
create index if not exists affiliate_clicks_ip_idx  on public.affiliate_clicks (ip_hash, created_at desc);

-- ─── 3. Нарахування, журнал балансу, виплати ──────────────────────────

alter table public.orders add column if not exists affiliate_id uuid references public.affiliates (id) on delete set null;
alter table public.orders add column if not exists affiliate_points_spent integer not null default 0 check (affiliate_points_spent >= 0);
alter table public.orders add column if not exists affiliate_points_refunded boolean not null default false;
alter table public.orders add column if not exists done_at timestamptz;  -- коли замовлення стало «Виконано»
create index if not exists orders_affiliate_idx on public.orders (affiliate_id) where affiliate_id is not null;

create table if not exists public.affiliate_commissions (
  id                 uuid primary key default gen_random_uuid(),
  affiliate_id       uuid not null references public.affiliates (id) on delete restrict,
  order_id           uuid not null unique references public.orders (id) on delete cascade,
  base_amount        numeric(12, 2) not null default 0,   -- грн: товари після знижок, без доставки, без оплаченого балами
  commission_amount  integer not null default 0,          -- бали, округлено вниз
  -- Ставки на момент замовлення: { "<product_id>": %, "_fallback": %, "_point_value": грн,
  -- "_categories": { "<product_id>": "<product_type>" } }. Зміна налаштувань історію не перераховує.
  rates_snapshot     jsonb not null default '{}',
  items_snapshot     jsonb not null default '[]',         -- позиції: сума-база, ставка, нарахування
  status             text not null default 'pending' check (status in ('pending', 'approved', 'cancelled', 'reversed')),
  source             text not null default 'cookie' check (source in ('cookie', 'lifetime', 'admin')),
  comment            text,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists affiliate_commissions_aff_idx on public.affiliate_commissions (affiliate_id, status);

create table if not exists public.affiliate_transactions (
  id            bigint generated always as identity primary key,
  affiliate_id  uuid not null references public.affiliates (id) on delete restrict,
  type          text not null check (type in ('commission', 'reversal', 'spend', 'spend_refund', 'payout', 'payout_refund', 'adjustment')),
  amount        integer not null check (amount <> 0),     -- бали, + або -
  ref_type      text,                                     -- commission | order | payout
  ref_id        text,
  comment       text,
  admin_id      uuid,
  created_at    timestamptz not null default now()
);
create index if not exists affiliate_transactions_aff_idx on public.affiliate_transactions (affiliate_id, created_at desc);

create table if not exists public.affiliate_payouts (
  id                uuid primary key default gen_random_uuid(),
  affiliate_id      uuid not null references public.affiliates (id) on delete restrict,
  amount            integer not null check (amount > 0),  -- бали
  amount_uah        numeric(12, 2) not null,
  details_snapshot  text,                                 -- реквізити на момент заявки, зашифровані
  status            text not null default 'new' check (status in ('new', 'paid', 'rejected')),
  admin_comment     text,
  processed_by      uuid,
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);
-- Не більше однієї необробленої заявки на партнера.
create unique index if not exists affiliate_payouts_one_new on public.affiliate_payouts (affiliate_id) where status = 'new';

create table if not exists public.affiliate_admin_log (
  id          bigint generated always as identity primary key,
  admin_id    uuid,
  action      text not null,
  target      text,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists affiliate_admin_log_idx on public.affiliate_admin_log (created_at desc);

-- ─── 4. Доступ: лише service_role ─────────────────────────────────────

alter table public.affiliate_settings     enable row level security;
alter table public.affiliate_rates        enable row level security;
alter table public.affiliates             enable row level security;
alter table public.affiliate_clicks       enable row level security;
alter table public.affiliate_commissions  enable row level security;
alter table public.affiliate_transactions enable row level security;
alter table public.affiliate_payouts      enable row level security;
alter table public.affiliate_admin_log    enable row level security;
revoke all on public.affiliate_settings, public.affiliate_rates, public.affiliates, public.affiliate_clicks,
  public.affiliate_commissions, public.affiliate_transactions, public.affiliate_payouts, public.affiliate_admin_log
  from anon, authenticated;

-- Адмінка «Замовлення» (orders-admin/) читає курс балу, щоб показати «до оплати».
grant select on public.affiliate_settings to authenticated;
drop policy if exists "admins read affiliate_settings" on public.affiliate_settings;
create policy "admins read affiliate_settings" on public.affiliate_settings
  for select to authenticated using (public.is_tg_admin());

-- ─── 5. Розрахунок ────────────────────────────────────────────────────

-- Ставка позиції: товар → категорія → індивідуальна партнера → загальна.
create or replace function public.affiliate_rate_for(p_custom numeric, p_product text, p_category text)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select rate from affiliate_rates where scope = 'product' and scope_id = p_product),
    (select rate from affiliate_rates where scope = 'category' and scope_id = p_category),
    p_custom,
    (select default_rate from affiliate_settings where id = 1),
    0);
$$;

-- Перерахунок нарахування з поточних позицій замовлення (менеджер міг змінити
-- товари чи ціни - так працює і часткове повернення) за ставками зі snapshot.
-- Для вже підтвердженого різниця йде в журнал: менше - сторно, більше - нарахування.
create or replace function public.affiliate_recalc(p_commission uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  k          affiliate_commissions;
  pv         numeric;
  spent      integer;
  items_sum  numeric;
  factor     numeric;
  snap       jsonb;
  new_base   numeric;
  comm_uah   numeric;
  new_points integer;
begin
  select * into k from affiliate_commissions where id = p_commission for update;
  if not found or k.status not in ('pending', 'approved') then
    return k.commission_amount;
  end if;
  pv := coalesce((k.rates_snapshot ->> '_point_value')::numeric, 1);
  select affiliate_points_spent into spent from orders where id = k.order_id;
  select coalesce(sum(qty * coalesce(price, 0)), 0) into items_sum from order_items where order_id = k.order_id;
  -- Оплачене балами не є базою: зменшуємо всі позиції пропорційно.
  factor := case when items_sum > 0 then greatest(0, items_sum - coalesce(spent, 0) * pv) / items_sum else 0 end;

  select coalesce(jsonb_agg(x order by pos), '[]'::jsonb),
         coalesce(sum((x ->> 'base')::numeric), 0),
         coalesce(sum((x ->> 'commission')::numeric), 0)
    into snap, new_base, comm_uah
    from (
      select oi.position as pos, jsonb_build_object(
               'product_id', oi.product_id,
               'title', oi.title,
               'category', k.rates_snapshot -> '_categories' ->> oi.product_id,
               'qty', oi.qty,
               'price', oi.price,
               'base', round(oi.qty * coalesce(oi.price, 0) * factor, 2),
               'rate', r.rate,
               'commission', round(oi.qty * coalesce(oi.price, 0) * factor * r.rate / 100, 4)) as x
        from order_items oi
        cross join lateral (
          select coalesce((k.rates_snapshot ->> oi.product_id)::numeric,
                          (k.rates_snapshot ->> '_fallback')::numeric, 0) as rate) r
       where oi.order_id = k.order_id
    ) t;

  new_points := floor(comm_uah / pv)::integer;

  if k.status = 'approved' and new_points <> k.commission_amount then
    insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
    values (k.affiliate_id, case when new_points < k.commission_amount then 'reversal' else 'commission' end,
            new_points - k.commission_amount, 'commission', k.id::text, 'Зміна складу замовлення');
  end if;

  update affiliate_commissions
     set base_amount = round(new_base, 2), commission_amount = new_points, items_snapshot = snap, updated_at = now()
   where id = k.id;
  return new_points;
end;
$$;

-- Прив'язати замовлення до партнера і створити нарахування «Очікує».
-- p_categories: { "<product_id>": "<product_type>" } - з products.json (передає функція Edge).
-- Повертає { attached, reason?, commission_id?, points? }.
create or replace function public.affiliate_attach(p_order uuid, p_affiliate uuid, p_categories jsonb, p_source text, p_admin uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s     affiliate_settings;
  o     orders;
  a     affiliates;
  c     b2b_clients;
  rates jsonb;
  cats  jsonb := '{}'::jsonb;
  it    record;
  cid   uuid;
  pts   integer;
begin
  select * into s from affiliate_settings where id = 1;
  select * into o from orders where id = p_order;
  if not found then return jsonb_build_object('attached', false, 'reason', 'no order'); end if;
  select * into a from affiliates where id = p_affiliate;
  if not found then return jsonb_build_object('attached', false, 'reason', 'no partner'); end if;
  select * into c from b2b_clients where id = a.client_id;
  if a.status <> 'active' or c.status is distinct from 'approved' then
    return jsonb_build_object('attached', false, 'reason', 'blocked');
  end if;
  -- Самореферал: замовив сам партнер (його B2B-замовлення або його телефон).
  if o.b2b_client_id = a.client_id
     or (o.phone_norm is not null and o.phone_norm = public.normalize_phone(c.phone)) then
    return jsonb_build_object('attached', false, 'reason', 'self');
  end if;
  if exists (select 1 from affiliate_commissions where order_id = p_order) then
    return jsonb_build_object('attached', false, 'reason', 'already');
  end if;

  rates := jsonb_build_object('_fallback', coalesce(a.custom_rate, s.default_rate), '_point_value', s.point_value);
  for it in select distinct product_id from order_items where order_id = p_order and product_id is not null loop
    rates := rates || jsonb_build_object(it.product_id,
      public.affiliate_rate_for(a.custom_rate, it.product_id, p_categories ->> it.product_id));
    if p_categories ? it.product_id then
      cats := cats || jsonb_build_object(it.product_id, p_categories ->> it.product_id);
    end if;
  end loop;
  rates := rates || jsonb_build_object('_categories', cats);

  insert into affiliate_commissions (affiliate_id, order_id, rates_snapshot, source)
  values (a.id, p_order, rates, p_source) returning id into cid;
  update orders set affiliate_id = a.id where id = p_order;
  pts := public.affiliate_recalc(cid);
  if p_admin is not null then
    insert into affiliate_admin_log (admin_id, action, target, details)
    values (p_admin, 'assign_order', o.number::text, jsonb_build_object('code', a.code, 'points', pts));
  end if;
  return jsonb_build_object('attached', true, 'commission_id', cid, 'points', pts, 'code', a.code);
end;
$$;

-- Нове замовлення з сайту. p_code / p_clicked_at - з підписаної cookie
-- (підпис перевіряє order-submit), обидва null - коду немає.
create or replace function public.affiliate_on_new_order(p_order uuid, p_code text, p_clicked_at timestamptz, p_categories jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s    affiliate_settings;
  o    orders;
  aid  uuid;
  src  text := 'cookie';
begin
  select * into s from affiliate_settings where id = 1;
  if not found or not s.enabled then return jsonb_build_object('attached', false, 'reason', 'disabled'); end if;
  select * into o from orders where id = p_order;
  if not found then return jsonb_build_object('attached', false, 'reason', 'no order'); end if;
  -- Гуртові замовлення з кабінету /b2b/ партнерам не нараховуються.
  if o.b2b_client_id is not null then return jsonb_build_object('attached', false, 'reason', 'b2b order'); end if;

  if p_code is not null and p_clicked_at is not null
     and p_clicked_at >= now() - make_interval(days => s.cookie_days)
     and p_clicked_at <= now() + interval '5 minutes' then
    select id into aid from affiliates where code = upper(p_code);
  end if;

  -- Довічна прив'язка: клієнт (за телефоном) уже купував через партнера.
  if aid is null and s.lifetime_days > 0 and o.phone_norm is not null then
    select po.affiliate_id into aid
      from orders po
     where po.phone_norm = o.phone_norm and po.id <> o.id and po.affiliate_id is not null
       and po.created_at >= now() - make_interval(days => s.lifetime_days)
     order by po.created_at desc
     limit 1;
    if aid is not null then src := 'lifetime'; end if;
  end if;

  if aid is null then return jsonb_build_object('attached', false, 'reason', 'no partner'); end if;
  return public.affiliate_attach(p_order, aid, coalesce(p_categories, '{}'::jsonb), src);
end;
$$;

-- ─── 6. Статуси ───────────────────────────────────────────────────────

-- Скасування / повернення замовлення: «Очікує» → «Скасовано», «Підтверджено» → «Сторно».
create or replace function public.affiliate_cancel_for_order(p_order uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k affiliate_commissions;
begin
  select * into k from affiliate_commissions where order_id = p_order for update;
  if not found then return; end if;
  if k.status = 'pending' then
    update affiliate_commissions set status = 'cancelled', comment = p_comment, updated_at = now() where id = k.id;
  elsif k.status = 'approved' then
    if k.commission_amount > 0 then
      insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
      values (k.affiliate_id, 'reversal', -k.commission_amount, 'commission', k.id::text, p_comment);
    end if;
    update affiliate_commissions set status = 'reversed', comment = p_comment, updated_at = now() where id = k.id;
  end if;
end;
$$;

-- «Виконано» + hold_days → «Підтверджено», бали в журнал. Запускає pg_cron
-- раз на добу (розділ 8), тригер при статусі «Виконано» і адмінка при відкритті.
create or replace function public.affiliate_approve_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hold integer;
  k    record;
  n    integer := 0;
begin
  select hold_days into hold from affiliate_settings where id = 1;
  for k in
    select ac.id, ac.affiliate_id
      from affiliate_commissions ac join orders o on o.id = ac.order_id
     where ac.status = 'pending' and o.status = 'done'
       and o.done_at <= now() - make_interval(days => coalesce(hold, 14))
     for update of ac skip locked
  loop
    -- Склад замовлення міг змінитися - фіксуємо актуальну суму перед підтвердженням.
    perform public.affiliate_recalc(k.id);
    update affiliate_commissions set status = 'approved', approved_at = now(), updated_at = now() where id = k.id;
    insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
    select affiliate_id, 'commission', commission_amount, 'commission', id::text, 'Замовлення виконано'
      from affiliate_commissions where id = k.id and commission_amount > 0;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Тригери на orders: дата «Виконано» і реакція на зміну статусу / суми.
create or replace function public.affiliate_orders_before()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.done_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.affiliate_orders_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  spender uuid;
  kid     uuid;
begin
  if new.affiliate_points_spent > 0 then
    select id into spender from affiliates where client_id = new.b2b_client_id;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('cancelled', 'returned') and old.status not in ('cancelled', 'returned') then
      perform public.affiliate_cancel_for_order(new.id,
        case new.status when 'cancelled' then 'Замовлення скасовано' else 'Повернення замовлення' end);
      -- Бали, якими оплатили це замовлення, повертаються.
      if spender is not null and not new.affiliate_points_refunded then
        insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
        values (spender, 'spend_refund', new.affiliate_points_spent, 'order', new.number::text, 'Замовлення скасовано - бали повернуто');
        update orders set affiliate_points_refunded = true where id = new.id;
      end if;
    elsif old.status in ('cancelled', 'returned') and new.status not in ('cancelled', 'returned') then
      -- Замовлення відновили: нарахування знову «Очікує», бали знову списуються.
      update affiliate_commissions set status = 'pending', comment = 'Замовлення відновлено', updated_at = now()
       where order_id = new.id and status = 'cancelled'
      returning id into kid;
      if kid is not null then perform public.affiliate_recalc(kid); end if;
      if spender is not null and new.affiliate_points_refunded then
        insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
        values (spender, 'spend', -new.affiliate_points_spent, 'order', new.number::text, 'Замовлення відновлено');
        update orders set affiliate_points_refunded = false where id = new.id;
      end if;
    end if;
    if new.status = 'done' then
      perform public.affiliate_approve_due();  -- при hold_days = 0 - одразу
    end if;
  end if;

  if new.total is distinct from old.total then
    select id into kid from affiliate_commissions where order_id = new.id and status in ('pending', 'approved');
    if kid is not null then perform public.affiliate_recalc(kid); end if;
  end if;
  return null;
end;
$$;

drop trigger if exists affiliate_orders_before on public.orders;
create trigger affiliate_orders_before before update of status on public.orders
  for each row execute function public.affiliate_orders_before();

drop trigger if exists affiliate_orders_after on public.orders;
create trigger affiliate_orders_after after update of status, total on public.orders
  for each row when (new.affiliate_id is not null or new.affiliate_points_spent > 0)
  execute function public.affiliate_orders_after();

-- ─── 7. Дії партнера й адміна (викликає функція affiliate / b2b) ───────

create or replace function public.affiliate_balance(p_affiliate uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::integer from affiliate_transactions where affiliate_id = p_affiliate;
$$;

-- Стати партнером (схвалений B2B-клієнт, погодився з правилами). Повторно - той самий запис.
create or replace function public.affiliate_join(p_client uuid)
returns affiliates
language plpgsql
security definer
set search_path = public
as $$
declare
  a     affiliates;
  abc     constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code  text;
begin
  select * into a from affiliates where client_id = p_client;
  if found then return a; end if;
  if not exists (select 1 from b2b_clients where id = p_client and status = 'approved') then
    raise exception 'client not approved';
  end if;
  loop
    select string_agg(substr(abc, 1 + floor(random() * length(abc))::int, 1), '') into v_code from generate_series(1, 6);
    exit when not exists (select 1 from affiliates where code = v_code);
  end loop;
  insert into affiliates (client_id, code) values (p_client, v_code) returning * into a;
  return a;
end;
$$;

-- Перехід за посиланням. Повертає партнера, якщо код дійсний (null - мовчки ігнорувати).
-- Повтори з того самого IP+UA за 24 год і понад 30 кліків з IP за годину не пишемо.
create or replace function public.affiliate_record_click(p_code text, p_landing text, p_referer text, p_ip_hash text, p_ua text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a        affiliates;
  recorded boolean := false;
begin
  if not coalesce((select enabled from affiliate_settings where id = 1), false) then return null; end if;
  select af.* into a from affiliates af join b2b_clients c on c.id = af.client_id
   where af.code = upper(p_code) and af.status = 'active' and c.status = 'approved';
  if not found then return null; end if;
  if (select count(*) from affiliate_clicks where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') < 30
     and not exists (select 1 from affiliate_clicks
                      where affiliate_id = a.id and ip_hash = p_ip_hash and user_agent is not distinct from p_ua
                        and created_at > now() - interval '24 hours') then
    insert into affiliate_clicks (affiliate_id, landing_url, referer, ip_hash, user_agent)
    values (a.id, left(p_landing, 500), left(p_referer, 500), p_ip_hash, left(p_ua, 300));
    recorded := true;
  end if;
  return jsonb_build_object('affiliate_id', a.id, 'code', a.code, 'recorded', recorded);
end;
$$;

-- Оплата балами власного B2B-замовлення. Блокування рядка партнера - захист від
-- подвійного списання при одночасних запитах.
create or replace function public.affiliate_spend(p_affiliate uuid, p_order uuid, p_points integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  a  affiliates;
  s  affiliate_settings;
  o  orders;
begin
  if p_points is null or p_points <= 0 then return 0; end if;
  select * into a from affiliates where id = p_affiliate for update;
  if not found then raise exception 'no partner'; end if;
  select * into s from affiliate_settings where id = 1;
  select * into o from orders where id = p_order for update;
  if not found or o.b2b_client_id is distinct from a.client_id then raise exception 'not your order'; end if;
  if o.affiliate_points_spent > 0 then raise exception 'already paid with points'; end if;
  if o.status in ('cancelled', 'returned') then raise exception 'order cancelled'; end if;
  if p_points > public.affiliate_balance(a.id) then raise exception 'not enough points'; end if;
  if p_points * s.point_value > o.total * s.max_points_share / 100 then raise exception 'too many points for this order'; end if;
  insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
  values (a.id, 'spend', -p_points, 'order', o.number::text, 'Оплата замовлення балами');
  update orders set affiliate_points_spent = p_points where id = o.id;
  return p_points;
end;
$$;

-- Заявка на виплату: сума резервується (списується з балансу) до обробки.
create or replace function public.affiliate_request_payout(p_affiliate uuid, p_points integer, p_details text)
returns affiliate_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  a  affiliates;
  s  affiliate_settings;
  p  affiliate_payouts;
begin
  select * into a from affiliates where id = p_affiliate for update;
  if not found then raise exception 'no partner'; end if;
  if a.status <> 'active' then raise exception 'partner blocked'; end if;
  select * into s from affiliate_settings where id = 1;
  if p_points is null or p_points <= 0 or p_points * s.point_value < s.min_payout then raise exception 'below minimum'; end if;
  if exists (select 1 from affiliate_payouts where affiliate_id = a.id and status = 'new') then raise exception 'payout already requested'; end if;
  if p_points > public.affiliate_balance(a.id) then raise exception 'not enough points'; end if;
  if coalesce(p_details, '') = '' then raise exception 'no payout details'; end if;
  insert into affiliate_payouts (affiliate_id, amount, amount_uah, details_snapshot)
  values (a.id, p_points, round(p_points * s.point_value, 2), p_details) returning * into p;
  insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment)
  values (a.id, 'payout', -p_points, 'payout', p.id::text, 'Заявка на виплату');
  return p;
end;
$$;

create or replace function public.affiliate_process_payout(p_payout uuid, p_status text, p_comment text, p_admin uuid)
returns affiliate_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  p affiliate_payouts;
begin
  if p_status not in ('paid', 'rejected') then raise exception 'bad status'; end if;
  select * into p from affiliate_payouts where id = p_payout for update;
  if not found then raise exception 'not found'; end if;
  if p.status <> 'new' then raise exception 'already processed'; end if;
  update affiliate_payouts set status = p_status, admin_comment = p_comment, processed_by = p_admin, processed_at = now()
   where id = p.id returning * into p;
  if p_status = 'rejected' then
    insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment, admin_id)
    values (p.affiliate_id, 'payout_refund', p.amount, 'payout', p.id::text, coalesce(p_comment, 'Заявку відхилено'), p_admin);
  end if;
  insert into affiliate_admin_log (admin_id, action, target, details)
  values (p_admin, 'payout_' || p_status, p.id::text, jsonb_build_object('amount', p.amount, 'comment', p_comment));
  return p;
end;
$$;

-- Ручне коригування балансу (коментар обов'язковий).
create or replace function public.affiliate_adjust(p_affiliate uuid, p_points integer, p_comment text, p_admin uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_comment), '') = '' then raise exception 'comment required'; end if;
  if p_points is null or p_points = 0 then raise exception 'amount required'; end if;
  perform 1 from affiliates where id = p_affiliate for update;
  if not found then raise exception 'no partner'; end if;
  insert into affiliate_transactions (affiliate_id, type, amount, comment, admin_id)
  values (p_affiliate, 'adjustment', p_points, p_comment, p_admin);
  insert into affiliate_admin_log (admin_id, action, target, details)
  values (p_admin, 'adjust', p_affiliate::text, jsonb_build_object('points', p_points, 'comment', p_comment));
  return public.affiliate_balance(p_affiliate);
end;
$$;

-- Ручна зміна статусу нарахування з коментарем.
create or replace function public.affiliate_set_commission_status(p_commission uuid, p_status text, p_comment text, p_admin uuid)
returns affiliate_commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  k affiliate_commissions;
begin
  if coalesce(trim(p_comment), '') = '' then raise exception 'comment required'; end if;
  select * into k from affiliate_commissions where id = p_commission for update;
  if not found then raise exception 'not found'; end if;
  if k.status = p_status then return k; end if;
  if (k.status, p_status) in (('pending', 'approved'), ('reversed', 'approved')) then
    if k.status = 'pending' then perform public.affiliate_recalc(k.id); select * into k from affiliate_commissions where id = k.id; end if;
    if k.commission_amount > 0 then
      insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment, admin_id)
      values (k.affiliate_id, 'commission', k.commission_amount, 'commission', k.id::text, p_comment, p_admin);
    end if;
    update affiliate_commissions set status = 'approved', approved_at = now(), comment = p_comment, updated_at = now() where id = k.id;
  elsif (k.status, p_status) = ('approved', 'reversed') then
    if k.commission_amount > 0 then
      insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment, admin_id)
      values (k.affiliate_id, 'reversal', -k.commission_amount, 'commission', k.id::text, p_comment, p_admin);
    end if;
    update affiliate_commissions set status = 'reversed', comment = p_comment, updated_at = now() where id = k.id;
  elsif (k.status, p_status) in (('pending', 'cancelled'), ('cancelled', 'pending')) then
    update affiliate_commissions set status = p_status, comment = p_comment, updated_at = now() where id = k.id;
    if p_status = 'pending' then perform public.affiliate_recalc(k.id); end if;
  else
    raise exception 'transition % -> % not allowed', k.status, p_status;
  end if;
  insert into affiliate_admin_log (admin_id, action, target, details)
  values (p_admin, 'commission_status', k.id::text, jsonb_build_object('from', k.status, 'to', p_status, 'comment', p_comment));
  select * into k from affiliate_commissions where id = k.id;
  return k;
end;
$$;

-- Призначити (p_code) або зняти (p_code = null) партнера з замовлення вручну.
-- Наявне нарахування прибирається: підтверджене - через сторно в журналі.
create or replace function public.affiliate_admin_set_order(p_number bigint, p_code text, p_categories jsonb, p_admin uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o    orders;
  k    affiliate_commissions;
  aid  uuid;
  res  jsonb := jsonb_build_object('attached', false);
begin
  select * into o from orders where number = p_number for update;
  if not found then raise exception 'order not found'; end if;
  if p_code is not null then
    select id into aid from affiliates where code = upper(p_code);
    if aid is null then raise exception 'partner not found'; end if;
  end if;
  select * into k from affiliate_commissions where order_id = o.id for update;
  if found then
    if k.status = 'approved' and k.commission_amount > 0 then
      insert into affiliate_transactions (affiliate_id, type, amount, ref_type, ref_id, comment, admin_id)
      values (k.affiliate_id, 'reversal', -k.commission_amount, 'commission', k.id::text, 'Партнера знято з замовлення №' || o.number, p_admin);
    end if;
    delete from affiliate_commissions where id = k.id;
  end if;
  update orders set affiliate_id = null where id = o.id;
  insert into affiliate_admin_log (admin_id, action, target, details)
  values (p_admin, case when p_code is null then 'unassign_order' else 'reassign_order' end, o.number::text,
          jsonb_build_object('old_partner', k.affiliate_id, 'old_status', k.status, 'old_points', k.commission_amount, 'code', p_code));
  if aid is not null then
    res := public.affiliate_attach(o.id, aid, coalesce(p_categories, '{}'::jsonb), 'admin', p_admin);
    if not (res ->> 'attached')::boolean then raise exception 'cannot attach: %', res ->> 'reason'; end if;
    -- Замовлення вже виконане й період повернення минув - підтверджуємо одразу.
    perform public.affiliate_approve_due();
  end if;
  return res;
end;
$$;

-- Зведення по партнеру за період (кабінет і адмінка).
create or replace function public.affiliate_summary(p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'clicks',   (select count(*) from affiliate_clicks where affiliate_id = p_affiliate and created_at >= p_from and created_at < p_to),
    'orders',   (select count(*) from affiliate_commissions where affiliate_id = p_affiliate and status <> 'cancelled' and created_at >= p_from and created_at < p_to),
    'earned',   (select coalesce(sum(commission_amount), 0) from affiliate_commissions where affiliate_id = p_affiliate and status = 'approved' and approved_at >= p_from and approved_at < p_to),
    'balance',  public.affiliate_balance(p_affiliate),
    'pending',  (select coalesce(sum(commission_amount), 0) from affiliate_commissions where affiliate_id = p_affiliate and status = 'pending'),
    'reserved', (select coalesce(sum(amount), 0) from affiliate_payouts where affiliate_id = p_affiliate and status = 'new'),
    'paid',     (select coalesce(sum(amount), 0) from affiliate_payouts where affiliate_id = p_affiliate and status = 'paid'));
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'affiliate_rate_for(numeric, text, text)', 'affiliate_recalc(uuid)', 'affiliate_attach(uuid, uuid, jsonb, text, uuid)',
    'affiliate_on_new_order(uuid, text, timestamptz, jsonb)', 'affiliate_cancel_for_order(uuid, text)', 'affiliate_approve_due()',
    'affiliate_balance(uuid)', 'affiliate_join(uuid)', 'affiliate_record_click(text, text, text, text, text)',
    'affiliate_spend(uuid, uuid, integer)', 'affiliate_request_payout(uuid, integer, text)',
    'affiliate_process_payout(uuid, text, text, uuid)', 'affiliate_adjust(uuid, integer, text, uuid)',
    'affiliate_set_commission_status(uuid, text, text, uuid)', 'affiliate_admin_set_order(bigint, text, jsonb, uuid)',
    'affiliate_summary(uuid, timestamptz, timestamptz)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ─── 8. Щоденне підтвердження (pg_cron) ───────────────────────────────
-- Увімкнути розширення: Dashboard → Database → Extensions → pg_cron, потім
-- запустити цей файл ще раз. Без pg_cron нарахування підтверджуються, коли
-- замовлення стає «Виконано» (при hold_days = 0) і при кожному відкритті
-- розділу «Партнерка» в адмінці та вкладки в кабінеті.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'affiliate-approve';
    perform cron.schedule('affiliate-approve', '15 3 * * *', 'select public.affiliate_approve_due()');
  else
    raise notice 'pg_cron не ввімкнено - див. розділ 8 цього файлу';
  end if;
end $$;
