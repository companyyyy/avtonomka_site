-- Автономка: лайки товарів на сайті (без реєстрації) - assets/js/likes.js.
-- Виконати ОДИН РАЗ у Supabase Dashboard → SQL Editor → New query → Run.
-- Безпечно запускати повторно. Потрібна вже виконана
-- scripts/supabase/miniapp_tracking_schema.sql (tg_likes, is_tg_admin).
--
-- Відвідувач без входу: браузер отримує випадковий visitor_id (localStorage),
-- один лайк на товар від браузера. Від накрутки (інкогніто, чистка браузера) -
-- ліміт: з однієї IP-адреси не більше 10 лайків одного товару за добу
-- (IP зберігається лише як хеш). Мобільні оператори дають одну IP багатьом
-- людям, тому ліміт не 1.
--
-- Публічне число біля сердечка = лайки на сайті + лайки в Telegram-мініаппі
-- (tg_likes). Хто саме лайкнув, не видно нікому, крім адмінів.

create table if not exists public.site_likes (
  product_id  text        not null,
  visitor_id  uuid        not null,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  primary key (product_id, visitor_id)
);
create index if not exists site_likes_ip_idx on public.site_likes (ip_hash, product_id, created_at);

alter table public.site_likes enable row level security;
revoke all on public.site_likes from anon, authenticated;
grant select on public.site_likes to authenticated;
drop policy if exists "admins can read site_likes" on public.site_likes;
create policy "admins can read site_likes" on public.site_likes
  for select to authenticated using (public.is_tg_admin());

-- Скільки лайків у товару: сайт + мініапп.
create or replace function public.product_like_count(p_product_id text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from site_likes where product_id = p_product_id)
       + (select count(*) from tg_likes   where product_id = p_product_id);
$$;

-- Усі лічильники одним запитом (каталог показує їх на кожній картці).
create or replace function public.product_like_counts()
returns table (product_id text, likes bigint)
language sql
stable
security definer
set search_path = public
as $$
  select x.product_id, count(*)
    from (select l.product_id from site_likes l
          union all
          select t.product_id from tg_likes t) x
   group by x.product_id;
$$;

-- Поставити / зняти лайк. Повертає { liked, likes } - стан після запиту
-- і нове загальне число для товару.
create or replace function public.site_set_like(p_product_id text, p_visitor_id uuid, p_liked boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip      text  := coalesce(v_headers ->> 'cf-connecting-ip',
                              split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  v_hash    text  := md5('avtonomka-site-likes:' || trim(v_ip));
  v_liked   boolean;
begin
  if p_product_id !~ '^[A-Za-z0-9]{1,32}$' or p_visitor_id is null then
    raise exception 'bad request';
  end if;

  if p_liked then
    if (select count(*) from site_likes
         where ip_hash = v_hash and product_id = p_product_id
           and created_at > now() - interval '1 day') >= 10 then
      v_liked := exists (select 1 from site_likes where product_id = p_product_id and visitor_id = p_visitor_id);
    else
      insert into site_likes (product_id, visitor_id, ip_hash)
      values (p_product_id, p_visitor_id, v_hash)
      on conflict do nothing;
      v_liked := true;
    end if;
  else
    delete from site_likes where product_id = p_product_id and visitor_id = p_visitor_id;
    v_liked := false;
  end if;

  return jsonb_build_object('liked', v_liked, 'likes', product_like_count(p_product_id));
end;
$$;

revoke all on function public.product_like_count(text) from public, anon, authenticated;
revoke all on function public.product_like_counts() from public;
revoke all on function public.site_set_like(text, uuid, boolean) from public;
grant execute on function public.product_like_counts() to anon, authenticated;
grant execute on function public.site_set_like(text, uuid, boolean) to anon, authenticated;
