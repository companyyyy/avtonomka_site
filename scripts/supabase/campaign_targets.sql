-- Автономка: розсилка вручну обраним людям (@username або Telegram ID) -
-- режим «Кому: вручну» у розділі «Розсилка» адмінки (miniapp-mailing.html).
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run,
-- після scripts/supabase/miniapp_tracking_schema.sql. Безпечно запускати повторно.
-- Окремим файлом, бо повторний запуск усього miniapp_tracking_schema.sql
-- знову відкрив би anon-доступ до функцій мініаппа (docs/TELEGRAM_BOT_SETUP.md, крок 4).
--
-- Кампанія з segment.targets = ['@user', '123456789', ...] надсилається саме
-- цим людям, а не за умовами (перегляди, лайки...). Пауза між розсилками
-- (cooldown) тут не діє - людей обрали вручну. Відписаним (/stop), тим, хто
-- заблокував бота або не запускав його, не пишемо, як і в звичайній розсилці.

-- Хто з переліку - клієнт і чи можна йому писати. Один рядок на кожен рядок переліку.
create or replace function public.tg_resolve_targets(p_targets text[])
returns table (input text, tg_id bigint, username text, name text, can_message boolean, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_tg_admin() then
    raise exception 'not allowed';
  end if;

  return query
  with t as (
    select distinct on (key) raw, key, ord
      from (select trim(x) as raw, lower(regexp_replace(trim(x), '^(https?://)?(t\.me/)?@?', '')) as key, o as ord
              from unnest(p_targets) with ordinality as u(x, o)) s
     where key <> ''
     order by key, ord
  )
  select t.raw,
         coalesce(u.tg_id, case when t.key ~ '^\d{5,15}$' then t.key::bigint end),
         case when u.username is not null then '@' || u.username end,
         trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')),
         case
           when u.tg_id is null then t.key ~ '^\d{5,15}$'
           else u.write_access is true and not u.opted_out and not u.bot_blocked
         end,
         case
           when u.tg_id is null and t.key ~ '^\d{5,15}$' then 'немає серед клієнтів - дійде, лише якщо людина запускала бота'
           when u.tg_id is null then 'не знайдено: людина ще не відкривала мініапп і не писала боту'
           when u.opted_out     then 'відписався від розсилок'
           when u.bot_blocked   then 'заблокував бота'
           when u.write_access is not true then 'не дозволив боту писати'
         end
    from t
    left join tg_users u
      on (t.key ~ '^\d{5,15}$' and u.tg_id = t.key::bigint)
      or (t.key !~ '^\d+$' and lower(u.username) = t.key)
   order by t.ord;
end;
$$;

revoke all on function public.tg_resolve_targets(text[]) from public, anon;
grant execute on function public.tg_resolve_targets(text[]) to authenticated;

-- Те саме, що в miniapp_tracking_schema.sql, плюс гілка для ручного переліку.
create or replace function public.tg_prepare_campaign(p_campaign_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c tg_campaigns;
  n integer;
  v_targets text[];
begin
  if not is_tg_admin() then
    raise exception 'not allowed';
  end if;
  select * into c from tg_campaigns where id = p_campaign_id for update;
  if c.id is null then raise exception 'campaign % not found', p_campaign_id; end if;
  if c.status <> 'draft' then raise exception 'campaign % is already %', p_campaign_id, c.status; end if;

  if jsonb_typeof(c.segment -> 'targets') = 'array' and jsonb_array_length(c.segment -> 'targets') > 0 then
    select array_agg(x) into v_targets from jsonb_array_elements_text(c.segment -> 'targets') x;
    -- ID, яких ще немає серед клієнтів: заводимо запис, щоб було куди писати статус.
    insert into tg_users (tg_id)
    select r.tg_id from tg_resolve_targets(v_targets) r
     where r.can_message and r.tg_id is not null
    on conflict (tg_id) do nothing;

    insert into tg_campaign_recipients (campaign_id, tg_id)
    select p_campaign_id, r.tg_id from tg_resolve_targets(v_targets) r
     where r.can_message and r.tg_id is not null
    on conflict do nothing;
  else
    insert into tg_campaign_recipients (campaign_id, tg_id)
    select p_campaign_id, s.tg_id
      from tg_segment(
        c.product_id,
        coalesce((c.segment ->> 'min_views')::int, 1),
        coalesce((c.segment ->> 'days')::int, 30),
        coalesce((c.segment ->> 'liked_only')::boolean, false),
        coalesce((c.segment ->> 'carted_only')::boolean, false),
        coalesce((c.segment ->> 'exclude_ordered')::boolean, true),
        coalesce((c.segment ->> 'cooldown_days')::int, 7)) s
     where s.can_message
    on conflict do nothing;
  end if;
  get diagnostics n = row_count;

  update tg_campaigns set status = 'sending' where id = p_campaign_id;
  return n;
end;
$$;

revoke all on function public.tg_prepare_campaign(bigint) from public, anon;
grant execute on function public.tg_prepare_campaign(bigint) to authenticated;
