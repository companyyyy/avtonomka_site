-- Автономка: підписка «Повідомити про зниження ціни» в мініаппі.
-- Кнопка в картці товару (miniapp_v/index.html) -> miniapp_set_price_watch.
-- Після автооновлення сайту (.github/workflows/update.yml) Edge Function
-- tg-price-alerts порівнює ціни сайту з ref_price і пише клієнту в Telegram,
-- якщо ціна знизилась; ref_price стає новою ціною, тож про наступне
-- зниження теж повідомимо, а про коливання вгору - ні.
-- Потребує miniapp_tracking_schema.sql (tg_users, tg_events, is_tg_admin).
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run.
-- Безпечно запускати повторно.

create table if not exists public.tg_price_watch (
  tg_id            bigint      not null references public.tg_users (tg_id) on delete cascade,
  product_id       text        not null,
  product_name     text,
  ref_price        numeric     not null,                -- ціна при підписці / останньому сповіщенні
  created_at       timestamptz not null default now(),
  last_notified_at timestamptz,
  primary key (tg_id, product_id)
);

create index if not exists tg_price_watch_product_idx on public.tg_price_watch (product_id);

alter table public.tg_price_watch enable row level security;
revoke all on public.tg_price_watch from anon;

drop policy if exists "tg admins read price watches" on public.tg_price_watch;
create policy "tg admins read price watches"
  on public.tg_price_watch for select
  to authenticated
  using (public.is_tg_admin());

-- Підписатися (p_on = true) / відписатися. Ціна - та, що клієнт бачить зараз.
create or replace function public.miniapp_set_price_watch(
  p_tg_id bigint, p_product_id text, p_product_name text default null,
  p_price numeric default null, p_on boolean default true)
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

  if p_on then
    if p_price is null or p_price <= 0 then
      raise exception 'price is required';
    end if;
    insert into tg_price_watch (tg_id, product_id, product_name, ref_price)
    values (p_tg_id, left(p_product_id, 32), left(p_product_name, 300), p_price)
    on conflict (tg_id, product_id) do nothing;
    if not found then return; end if;
  else
    delete from tg_price_watch where tg_id = p_tg_id and product_id = p_product_id;
    if not found then return; end if;
  end if;

  insert into tg_events (tg_id, event, product_id, product_name)
  values (p_tg_id, case when p_on then 'price_watch' else 'price_unwatch' end,
          left(p_product_id, 32), left(p_product_name, 300));
  update tg_users set last_seen = now() where tg_id = p_tg_id;
end;
$$;

-- Список товарів, на які підписаний клієнт (щоб кнопка показувала стан).
create or replace function public.miniapp_price_watches(p_tg_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(product_id order by created_at), '[]'::jsonb)
    from tg_price_watch where tg_id = p_tg_id;
$$;

revoke all on function public.miniapp_set_price_watch(bigint, text, text, numeric, boolean) from public;
revoke all on function public.miniapp_price_watches(bigint)                               from public;
grant execute on function public.miniapp_set_price_watch(bigint, text, text, numeric, boolean) to anon, authenticated;
grant execute on function public.miniapp_price_watches(bigint)                               to anon, authenticated;
