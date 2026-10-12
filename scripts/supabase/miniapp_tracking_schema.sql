-- Автономка: облік заходів і лайків у Telegram-мініаппі (miniapp_v/index.html).
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run.
-- Безпечно запускати повторно (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS).
--
-- Хто: Telegram передає мініаппу id, ім'я та @username (initDataUnsafe.user).
-- Поки токена бота немає, ці дані не перевіряються підписом - коли токен
-- з'явиться, запис піде через Edge Function з перевіркою initData, а таблиці
-- лишаться ті самі.
--
-- Доступ: анонімний клієнт (мініапп з anon-ключем) НЕ має прав на таблиці
-- взагалі - ні читати, ні писати напряму. Він лише викликає 4 функції нижче
-- (security definer), які пишуть рівно те, що треба. Читати все може тільки
-- адмін (authenticated - вхід через Supabase Auth, як для коментарів).
--
-- Перегляд даних: Table Editor → tg_users_overview (клієнти) і
-- tg_product_interest (хто що дивився / лайкав).

-- ─── Таблиці ───────────────────────────────────────────────────────────

create table if not exists public.tg_users (
  tg_id            bigint primary key,           -- id користувача в Telegram
  username         text,                          -- @username (може бути порожнім)
  first_name       text,
  last_name        text,
  language_code    text,
  is_premium       boolean,
  platform         text,                          -- ios / android / tdesktop / weba ...
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  visits           integer     not null default 0, -- скільки разів відкривав мініапп
  write_access     boolean,                       -- null = ще не питали; true = бот може писати
  write_access_at  timestamptz,
  opted_out        boolean     not null default false -- відписався від розсилок
);

create table if not exists public.tg_events (
  id            bigint generated always as identity primary key,
  tg_id         bigint      not null references public.tg_users (tg_id) on delete cascade,
  event         text        not null,
  product_id    text,                              -- products.json id
  product_name  text,                              -- назва на момент події (для зручного читання)
  category      text,
  query         text,                              -- пошуковий запит / start_param
  created_at    timestamptz not null default now()
);

create index if not exists tg_events_user_idx    on public.tg_events (tg_id, created_at desc);
create index if not exists tg_events_product_idx on public.tg_events (product_id, event);

create table if not exists public.tg_likes (
  tg_id         bigint      not null references public.tg_users (tg_id) on delete cascade,
  product_id    text        not null,
  product_name  text,
  created_at    timestamptz not null default now(),
  primary key (tg_id, product_id)
);

create index if not exists tg_likes_product_idx on public.tg_likes (product_id);

-- ─── Доступ ────────────────────────────────────────────────────────────

alter table public.tg_users  enable row level security;
alter table public.tg_events enable row level security;
alter table public.tg_likes  enable row level security;

-- Supabase за замовчуванням видає anon права на нові таблиці - забираємо.
revoke all on public.tg_users, public.tg_events, public.tg_likes from anon;

drop policy if exists "authenticated can read tg_users"  on public.tg_users;
drop policy if exists "authenticated can read tg_events" on public.tg_events;
drop policy if exists "authenticated can read tg_likes"  on public.tg_likes;
create policy "authenticated can read tg_users"  on public.tg_users  for select to authenticated using (true);
create policy "authenticated can read tg_events" on public.tg_events for select to authenticated using (true);
create policy "authenticated can read tg_likes"  on public.tg_likes  for select to authenticated using (true);

-- ─── Функції, які викликає мініапп ─────────────────────────────────────

-- Заголовок кожного заходу: створює/оновлює клієнта, +1 до visits, подія
-- app_open. Повертає лайки клієнта (щоб одразу показати сердечка) і чи вже
-- відомо, що бот може йому писати.
create or replace function public.miniapp_visit(p_user jsonb, p_platform text default null, p_start_param text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     bigint := nullif(p_user ->> 'id', '')::bigint;
  v_write  boolean;
  v_likes  jsonb;
begin
  if v_id is null or v_id <= 0 then
    raise exception 'tg user id is required';
  end if;

  insert into tg_users as u (tg_id, username, first_name, last_name, language_code, is_premium, platform, visits, write_access, write_access_at)
  values (
    v_id,
    left(p_user ->> 'username', 64),
    left(p_user ->> 'first_name', 128),
    left(p_user ->> 'last_name', 128),
    left(p_user ->> 'language_code', 16),
    (p_user ->> 'is_premium')::boolean,
    left(p_platform, 32),
    1,
    case when (p_user ->> 'allows_write_to_pm')::boolean then true end,
    case when (p_user ->> 'allows_write_to_pm')::boolean then now() end
  )
  on conflict (tg_id) do update set
    username      = excluded.username,
    first_name    = excluded.first_name,
    last_name     = excluded.last_name,
    language_code = excluded.language_code,
    is_premium    = excluded.is_premium,
    platform      = coalesce(excluded.platform, u.platform),
    last_seen     = now(),
    visits        = u.visits + 1,
    -- allows_write_to_pm=true від Telegram - достатня підстава; false не
    -- затирає раніше отриманий дозвіл (його дає requestWriteAccess)
    write_access    = case when excluded.write_access then true else u.write_access end,
    write_access_at = case when excluded.write_access and u.write_access is not true then now() else u.write_access_at end
  returning write_access into v_write;

  insert into tg_events (tg_id, event, query) values (v_id, 'app_open', left(p_start_param, 128));

  select coalesce(jsonb_agg(product_id order by created_at), '[]'::jsonb) into v_likes
    from tg_likes where tg_id = v_id;

  return jsonb_build_object('likes', v_likes, 'write_access', v_write);
end;
$$;

-- Одна дія клієнта. Невідомі типи подій відкидаються; більше 600 подій за
-- годину від одного клієнта - теж (захист від засмічення таблиці).
create or replace function public.miniapp_track(
  p_tg_id bigint, p_event text,
  p_product_id text default null, p_product_name text default null,
  p_category text default null, p_query text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event not in ('category_open', 'product_open', 'search', 'cart_add', 'order',
                     'favorites_open', 'manager_click') then
    raise exception 'unknown event %', p_event;
  end if;
  if not exists (select 1 from tg_users where tg_id = p_tg_id) then
    return;
  end if;
  if (select count(*) from tg_events
       where tg_id = p_tg_id and created_at > now() - interval '1 hour') >= 600 then
    return;
  end if;

  insert into tg_events (tg_id, event, product_id, product_name, category, query)
  values (p_tg_id, p_event, left(p_product_id, 32), left(p_product_name, 300),
          left(p_category, 128), left(p_query, 200));
  update tg_users set last_seen = now() where tg_id = p_tg_id;
end;
$$;

-- Поставити / зняти лайк (і записати це як подію like / unlike).
create or replace function public.miniapp_set_like(p_tg_id bigint, p_product_id text, p_product_name text default null, p_liked boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_product_id is null or p_product_id = '' then
    raise exception 'product id is required';
  end if;
  if not exists (select 1 from tg_users where tg_id = p_tg_id) then
    return;
  end if;

  if p_liked then
    insert into tg_likes (tg_id, product_id, product_name)
    values (p_tg_id, left(p_product_id, 32), left(p_product_name, 300))
    on conflict (tg_id, product_id) do nothing;
    if not found then return; end if;  -- вже був лайк - подію не дублюємо
  else
    delete from tg_likes where tg_id = p_tg_id and product_id = p_product_id;
    if not found then return; end if;
  end if;

  insert into tg_events (tg_id, event, product_id, product_name)
  values (p_tg_id, case when p_liked then 'like' else 'unlike' end,
          left(p_product_id, 32), left(p_product_name, 300));
  update tg_users set last_seen = now() where tg_id = p_tg_id;
end;
$$;

-- Відповідь клієнта на запит «дозволити боту писати вам».
create or replace function public.miniapp_set_write_access(p_tg_id bigint, p_allowed boolean)
returns void
language sql
security definer
set search_path = public
as $$
  -- Відмова не скасовує дозвіл, отриманий раніше.
  update tg_users
     set write_access    = coalesce(write_access, false) or p_allowed,
         write_access_at = now()
   where tg_id = p_tg_id;
$$;

revoke all on function public.miniapp_visit(jsonb, text, text)                   from public;
revoke all on function public.miniapp_track(bigint, text, text, text, text, text) from public;
revoke all on function public.miniapp_set_like(bigint, text, text, boolean)      from public;
revoke all on function public.miniapp_set_write_access(bigint, boolean)          from public;
grant execute on function public.miniapp_visit(jsonb, text, text)                   to anon, authenticated;
grant execute on function public.miniapp_track(bigint, text, text, text, text, text) to anon, authenticated;
grant execute on function public.miniapp_set_like(bigint, text, text, boolean)      to anon, authenticated;
grant execute on function public.miniapp_set_write_access(bigint, boolean)          to anon, authenticated;

-- ─── Зведення для перегляду (Table Editor) ─────────────────────────────

-- Клієнти: хто, скільки заходів, що дивився, що лайкав, чи замовляв.
create or replace view public.tg_users_overview
with (security_invoker = true) as
select
  u.tg_id,
  case when u.username is not null then '@' || u.username end as username,
  trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) as name,
  u.visits,
  u.first_seen,
  u.last_seen,
  (select count(*) from tg_events e where e.tg_id = u.tg_id and e.event = 'product_open') as product_views,
  (select count(*) from tg_likes l where l.tg_id = u.tg_id)                              as likes,
  (select count(*) from tg_events e where e.tg_id = u.tg_id and e.event = 'order')        as orders,
  (select e.product_name from tg_events e
    where e.tg_id = u.tg_id and e.event = 'product_open'
    group by e.product_name order by count(*) desc, max(e.created_at) desc limit 1)       as top_product,
  u.write_access,
  u.opted_out,
  u.platform
from tg_users u
order by u.last_seen desc;

-- Інтерес до товарів: одна стрічка = клієнт × товар. Саме з цього потім
-- вибиратимемо, кому надсилати знижку («дивився 3224 20 разів, не замовив»).
create or replace view public.tg_product_interest
with (security_invoker = true) as
with ev as (
  select tg_id, product_id,
         max(product_name)                                  as product_name,
         count(*) filter (where event = 'product_open')     as views,
         count(*) filter (where event = 'cart_add')         as cart_adds,
         max(created_at) filter (where event = 'product_open') as last_view
    from tg_events
   where product_id is not null
   group by tg_id, product_id
)
select
  u.tg_id,
  case when u.username is not null then '@' || u.username end as username,
  trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) as name,
  coalesce(ev.product_id, l.product_id)     as product_id,
  coalesce(ev.product_name, l.product_name) as product_name,
  coalesce(ev.views, 0)                     as views,
  coalesce(ev.cart_adds, 0)                 as cart_adds,
  (l.product_id is not null)                as liked,
  ev.last_view,
  u.write_access
from ev
full join tg_likes l on l.tg_id = ev.tg_id and l.product_id = ev.product_id
join tg_users u on u.tg_id = coalesce(ev.tg_id, l.tg_id)
order by views desc, last_view desc nulls last;

revoke all on public.tg_users_overview, public.tg_product_interest from anon;
grant select on public.tg_users_overview, public.tg_product_interest to authenticated;
