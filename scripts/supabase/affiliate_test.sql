-- Сценарії перевірки партнерської програми (розділ 7 ТЗ). Запускає
-- scripts/supabase/affiliate_test.mjs на тестовій БД у пам'яті - НЕ запускати
-- на бойовому Supabase (створює тестових клієнтів і замовлення).
-- Блок «-- @test назва» - окремий сценарій; стан між сценаріями зберігається.

-- Спільна підготовка: партнер P (код у t_ctx), другий клієнт Q, ставки:
-- загальна 3%, категорія «Inv» 2%, товар P1 5%.
insert into b2b_clients (id, status, company, contact_name, phone, email) values
  ('11111111-1111-1111-1111-111111111111', 'approved', 'Монтаж ФОП', 'Партнер', '+380 67 111 22 33', 'p@test.ua'),
  ('22222222-2222-2222-2222-222222222222', 'approved', 'Інший ФОП', 'Клієнт', '+380 50 000 00 00', 'q@test.ua');
insert into affiliate_rates (scope, scope_id, rate) values ('category', 'Inv', 2), ('product', 'P1', 5);

create table t_ctx (k text primary key, v text);
insert into t_ctx select 'aff', (public.affiliate_join('11111111-1111-1111-1111-111111111111')).id::text;
insert into t_ctx select 'code', code from affiliates where id = (select v::uuid from t_ctx where k = 'aff');

create function t(p_key text) returns text language sql as $$ select v from t_ctx where k = p_key $$;
create function t_aff() returns uuid language sql as $$ select v::uuid from t_ctx where k = 'aff' $$;
create function t_cats() returns jsonb language sql as $$ select '{"P1":"Inv","P2":"Inv","P3":"Cab"}'::jsonb $$;

-- Замовлення з сайту: items = [{id, qty, price}]
create function t_order(p_phone text, p_items jsonb, p_b2b uuid default null) returns uuid language plpgsql as $$
declare
  oid uuid;
begin
  insert into orders (source, name, phone, phone_norm, b2b_client_id, total)
  values (case when p_b2b is null then 'Кошик' else 'B2B' end, 'Тест', p_phone, public.normalize_phone(p_phone), p_b2b,
          (select coalesce(sum((i ->> 'qty')::int * (i ->> 'price')::numeric), 0) from jsonb_array_elements(p_items) i))
  returning id into oid;
  insert into order_items (order_id, position, product_id, title, qty, price)
  select oid, (ord - 1)::int, i ->> 'id', 'Товар ' || (i ->> 'id'), (i ->> 'qty')::int, (i ->> 'price')::numeric
    from jsonb_array_elements(p_items) with ordinality as x(i, ord);
  return oid;
end $$;

create function t_commission(p_order uuid) returns affiliate_commissions language sql as
  $$ select * from affiliate_commissions where order_id = p_order $$;

-- @test 1. Код партнера: 6 символів без 0/O/1/I, повторне «Стати партнером» не створює другий
do $$
begin
  assert t('code') ~ '^[A-HJ-NP-Z2-9]{6}$', 'code format: ' || t('code');
  assert (public.affiliate_join('11111111-1111-1111-1111-111111111111')).id = t_aff(), 'join is idempotent';
  assert (select count(*) from affiliates) = 1, 'one partner';
end $$;

-- @test 1. Перехід за посиланням пишеться; повтор з того ж IP+UA за 24 год - ні; невалідний код ігнорується
do $$
declare
  r jsonb;
begin
  r := public.affiliate_record_click(lower(t('code')), 'https://avtonomka.com.ua/', 'https://t.me/x', 'ip1', 'UA1');
  assert (r ->> 'recorded')::boolean, 'first click recorded';
  assert r ->> 'code' = t('code'), 'code normalized to upper case';
  r := public.affiliate_record_click(t('code'), 'https://avtonomka.com.ua/catalog.html', null, 'ip1', 'UA1');
  assert r is not null and not (r ->> 'recorded')::boolean, 'duplicate click not recorded but code still valid';
  r := public.affiliate_record_click(t('code'), '/', null, 'ip2', 'UA1');
  assert (r ->> 'recorded')::boolean, 'other IP recorded';
  assert public.affiliate_record_click('ZZZZZZ', '/', null, 'ip1', 'UA1') is null, 'unknown code ignored';
  assert (select count(*) from affiliate_clicks) = 2, 'two clicks stored';
end $$;

-- @test 2. Замовлення в межах cookie: «Очікує», ставки товар → категорія → загальна, без доставки
do $$
declare
  o uuid;
  r jsonb;
  k affiliate_commissions;
begin
  -- P1: 10000 × 5% = 500; P2: 2 × 5000 × 2% (категорія Inv) = 200; P3: 999 × 3% (загальна) = 29.97 → 729 балів (вниз)
  o := t_order('+380 93 000 00 01', '[{"id":"P1","qty":1,"price":10000},{"id":"P2","qty":2,"price":5000},{"id":"P3","qty":1,"price":999}]');
  r := public.affiliate_on_new_order(o, t('code'), now() - interval '29 days', t_cats());
  assert (r ->> 'attached')::boolean, 'attached: ' || r::text;
  k := t_commission(o);
  assert k.status = 'pending', 'status pending';
  assert k.base_amount = 20999, 'base ' || k.base_amount;
  assert k.commission_amount = 729, 'points ' || k.commission_amount;
  assert (select affiliate_id from orders where id = o) = t_aff(), 'order linked to partner';
  assert public.affiliate_balance(t_aff()) = 0, 'pending does not change balance';
  insert into t_ctx values ('o_main', o::text);
end $$;

-- @test 3. Замовлення після закінчення cookie (31 день) не прив'язується
do $$
declare
  o uuid;
  r jsonb;
begin
  o := t_order('+380 93 000 00 02', '[{"id":"P3","qty":1,"price":1000}]');
  r := public.affiliate_on_new_order(o, t('code'), now() - interval '31 days', t_cats());
  assert not (r ->> 'attached')::boolean, 'not attached';
  assert t_commission(o) is null and (select affiliate_id from orders where id = o) is null, 'no commission';
end $$;

-- @test 4. Партнер купує за власним посиланням (свій телефон) - нічого не отримує
do $$
declare
  o uuid;
  r jsonb;
begin
  o := t_order('067 111 22 33', '[{"id":"P3","qty":1,"price":1000}]');
  r := public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  assert r ->> 'reason' = 'self', 'self-referral: ' || r::text;
  assert t_commission(o) is null, 'no commission';
end $$;

-- @test 4. Гуртове замовлення з кабінету /b2b/ не атрибутується
do $$
declare
  o uuid;
begin
  o := t_order('+380 50 000 00 00', '[{"id":"P3","qty":1,"price":1000}]', '22222222-2222-2222-2222-222222222222');
  assert public.affiliate_on_new_order(o, t('code'), now(), t_cats()) ->> 'reason' = 'b2b order', 'b2b ignored';
end $$;

-- @test 5. «Виконано» + 14 днів → «Підтверджено», баланс зростає (не раніше)
do $$
declare
  o uuid := t('o_main')::uuid;
begin
  update orders set status = 'done' where id = o;
  assert (select done_at from orders where id = o) is not null, 'done_at set';
  perform public.affiliate_approve_due();
  assert (t_commission(o)).status = 'pending', 'still pending inside hold period';
  update orders set done_at = now() - interval '13 days' where id = o;
  perform public.affiliate_approve_due();
  assert (t_commission(o)).status = 'pending', 'still pending on day 13';
  update orders set done_at = now() - interval '15 days' where id = o;
  assert public.affiliate_approve_due() = 1, 'one approved';
  assert (t_commission(o)).status = 'approved', 'approved';
  assert public.affiliate_balance(t_aff()) = 729, 'balance ' || public.affiliate_balance(t_aff());
  assert public.affiliate_approve_due() = 0, 'not approved twice';
end $$;

-- @test 6. Скасування до підтвердження → «Скасовано», баланс не змінюється
do $$
declare
  o uuid;
begin
  o := t_order('+380 93 000 00 03', '[{"id":"P3","qty":1,"price":10000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  assert (t_commission(o)).commission_amount = 300, 'points 300';
  update orders set status = 'cancelled' where id = o;
  assert (t_commission(o)).status = 'cancelled', 'cancelled';
  assert public.affiliate_balance(t_aff()) = 729, 'balance unchanged';
  -- Відновили замовлення - нарахування знову «Очікує».
  update orders set status = 'in_work' where id = o;
  assert (t_commission(o)).status = 'pending', 'pending again after restore';
  update orders set status = 'cancelled' where id = o;
end $$;

-- @test 6. Повернення після підтвердження → сторно, бали списуються
do $$
declare
  o uuid;
begin
  o := t_order('+380 93 000 00 04', '[{"id":"P3","qty":1,"price":10000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  update orders set status = 'done' where id = o;
  update orders set done_at = now() - interval '20 days' where id = o;
  perform public.affiliate_approve_due();
  assert public.affiliate_balance(t_aff()) = 729 + 300, 'approved +300';
  update orders set status = 'returned' where id = o;
  assert (t_commission(o)).status = 'reversed', 'reversed';
  assert public.affiliate_balance(t_aff()) = 729, 'reversal -300';
  assert exists (select 1 from affiliate_transactions where type = 'reversal' and amount = -300), 'ledger reversal row';
end $$;

-- @test 6. Часткове повернення пропорційно зменшує нарахування (і підтверджене)
do $$
declare
  o uuid;
begin
  o := t_order('+380 93 000 00 05', '[{"id":"P3","qty":2,"price":5000},{"id":"P1","qty":1,"price":2000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  assert (t_commission(o)).commission_amount = 400, '300 + 100';  -- 10000 × 3% + 2000 × 5%
  update orders set status = 'done' where id = o;
  update orders set done_at = now() - interval '20 days' where id = o;
  perform public.affiliate_approve_due();
  assert public.affiliate_balance(t_aff()) = 729 + 400, 'approved +400';
  -- Повернули одну з двох P3: менеджер змінює кількість, сума замовлення перераховується.
  update order_items set qty = 1 where order_id = o and product_id = 'P3';
  update orders set total = 7000 where id = o;
  assert (t_commission(o)).commission_amount = 250, 'now 150 + 100 = ' || (t_commission(o)).commission_amount;
  assert (t_commission(o)).status = 'approved', 'still approved';
  assert public.affiliate_balance(t_aff()) = 729 + 250, 'partial reversal -150';
  update orders set status = 'returned' where id = o;  -- повне повернення решти
  assert public.affiliate_balance(t_aff()) = 729, 'rest reversed';
end $$;

-- @test 7. Оплата балами: зменшує баланс; скасування замовлення повертає бали
do $$
declare
  o   uuid;
  aff uuid := t_aff();
begin
  o := t_order('+380 67 111 22 33', '[{"id":"P3","qty":1,"price":2000}]', '11111111-1111-1111-1111-111111111111');
  begin
    perform public.affiliate_spend(aff, o, 100000);
    assert false, 'spend over balance must fail';
  exception when raise_exception then null;
  end;
  assert public.affiliate_spend(aff, o, 300) = 300, 'spent 300';
  assert public.affiliate_balance(aff) = 429, 'balance 729 - 300';
  assert (select affiliate_points_spent from orders where id = o) = 300, 'order remembers points';
  begin
    perform public.affiliate_spend(aff, o, 10);
    assert false, 'second spend on the same order must fail';
  exception when raise_exception then null;
  end;
  update orders set status = 'cancelled' where id = o;
  assert public.affiliate_balance(aff) = 729, 'points refunded';
  assert (select affiliate_points_refunded from orders where id = o), 'refund flag';
  update orders set status = 'cancelled', comment = 'x' where id = o;
  assert public.affiliate_balance(aff) = 729, 'no double refund';
end $$;

-- @test 7. Оплата балами не більше max_points_share % суми і лише власного замовлення
do $$
declare
  o   uuid;
  aff uuid := t_aff();
begin
  update affiliate_settings set max_points_share = 50;
  o := t_order('+380 67 111 22 33', '[{"id":"P3","qty":1,"price":1000}]', '11111111-1111-1111-1111-111111111111');
  begin
    perform public.affiliate_spend(aff, o, 501);
    assert false, 'over 50% must fail';
  exception when raise_exception then null;
  end;
  o := t_order('+380 50 000 00 00', '[{"id":"P3","qty":1,"price":1000}]', '22222222-2222-2222-2222-222222222222');
  begin
    perform public.affiliate_spend(aff, o, 10);
    assert false, 'someone else''s order must fail';
  exception when raise_exception then null;
  end;
  update affiliate_settings set max_points_share = 100;
end $$;

-- @test 8. Виплата: менше мінімуму не створюється; сума резервується; відхилення повертає резерв
do $$
declare
  aff uuid := t_aff();
  p   affiliate_payouts;
begin
  begin
    perform public.affiliate_request_payout(aff, 499, 'enc');
    assert false, 'below 500 must fail';
  exception when raise_exception then null;
  end;
  p := public.affiliate_request_payout(aff, 500, 'enc');
  assert p.status = 'new' and p.amount_uah = 500, 'payout created';
  assert public.affiliate_balance(aff) = 229, 'reserved 500';
  begin
    perform public.affiliate_request_payout(aff, 200, 'enc');
    assert false, 'second active payout must fail';
  exception when raise_exception then null;
  end;
  perform public.affiliate_process_payout(p.id, 'rejected', 'Невірний IBAN', null);
  assert public.affiliate_balance(aff) = 729, 'reserve returned';
  p := public.affiliate_request_payout(aff, 700, 'enc');
  perform public.affiliate_process_payout(p.id, 'paid', null, null);
  assert public.affiliate_balance(aff) = 29, 'paid out';
  assert (public.affiliate_summary(aff, now() - interval '1 day', now() + interval '1 day') ->> 'paid')::int = 700, 'summary paid';
  begin
    perform public.affiliate_process_payout(p.id, 'rejected', null, null);
    assert false, 'processed payout cannot change';
  exception when raise_exception then null;
  end;
end $$;

-- @test 9. Заблокований партнер: код не трекається, нові нарахування не створюються
do $$
declare
  o uuid;
begin
  update affiliates set status = 'blocked' where id = t_aff();
  assert public.affiliate_record_click(t('code'), '/', null, 'ip9', 'UA9') is null, 'click ignored';
  o := t_order('+380 93 000 00 09', '[{"id":"P3","qty":1,"price":1000}]');
  assert public.affiliate_on_new_order(o, t('code'), now(), t_cats()) ->> 'reason' = 'blocked', 'blocked';
  assert t_commission(o) is null, 'no commission';
  update affiliates set status = 'active' where id = t_aff();
  -- Заблокований B2B-клієнт теж не трекається.
  update b2b_clients set status = 'blocked' where id = '11111111-1111-1111-1111-111111111111';
  assert public.affiliate_record_click(t('code'), '/', null, 'ip9', 'UA9') is null, 'b2b blocked: click ignored';
  update b2b_clients set status = 'approved' where id = '11111111-1111-1111-1111-111111111111';
end $$;

-- @test 10. Зміна % у налаштуваннях не змінює вже створені нарахування
do $$
declare
  o uuid;
begin
  o := t_order('+380 93 000 00 10', '[{"id":"P1","qty":1,"price":10000},{"id":"P3","qty":1,"price":1000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  assert (t_commission(o)).commission_amount = 530, '500 + 30';
  update affiliate_rates set rate = 1 where scope = 'product' and scope_id = 'P1';
  update affiliate_settings set default_rate = 10;
  update orders set total = total + 0.01 where id = o;  -- будь-який перерахунок
  assert (t_commission(o)).commission_amount = 530, 'snapshot kept: ' || (t_commission(o)).commission_amount;
  update affiliate_rates set rate = 5 where scope = 'product' and scope_id = 'P1';
  update affiliate_settings set default_rate = 3;
end $$;

-- @test 10. Індивідуальний % партнера: вище загального, нижче категорії й товару
do $$
declare
  o uuid;
begin
  update affiliates set custom_rate = 6 where id = t_aff();
  o := t_order('+380 93 000 00 11', '[{"id":"P1","qty":1,"price":1000},{"id":"P2","qty":1,"price":1000},{"id":"P3","qty":1,"price":1000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  assert (t_commission(o)).commission_amount = 50 + 20 + 60, 'product 5%, category 2%, custom 6%: ' || (t_commission(o)).commission_amount;
  update affiliates set custom_rate = null where id = t_aff();
end $$;

-- @test 11. Без реферального коду замовлення не змінюється і нарахувань немає
do $$
declare
  o uuid;
  n integer := (select count(*) from affiliate_commissions);
begin
  o := t_order('+380 93 000 00 12', '[{"id":"P3","qty":1,"price":1000}]');
  assert public.affiliate_on_new_order(o, null, null, '{}') ->> 'reason' = 'no partner', 'no partner';
  assert (select count(*) from affiliate_commissions) = n, 'no new rows';
  assert (select affiliate_id is null and affiliate_points_spent = 0 from orders where id = o), 'order untouched';
end $$;

-- @test Програму вимкнено: кліки й замовлення ігноруються
do $$
declare
  o uuid;
begin
  update affiliate_settings set enabled = false;
  assert public.affiliate_record_click(t('code'), '/', null, 'ip10', 'UA') is null, 'click ignored';
  o := t_order('+380 93 000 00 13', '[{"id":"P3","qty":1,"price":1000}]');
  assert public.affiliate_on_new_order(o, t('code'), now(), t_cats()) ->> 'reason' = 'disabled', 'disabled';
  update affiliate_settings set enabled = true;
end $$;

-- @test Довічна прив'язка: повторне замовлення того ж телефону без коду - тому ж партнеру
do $$
declare
  o uuid;
begin
  o := t_order('+380 93 000 00 01', '[{"id":"P3","qty":1,"price":1000}]');
  assert public.affiliate_on_new_order(o, null, null, t_cats()) ->> 'reason' = 'no partner', 'off by default';
  update affiliate_settings set lifetime_days = 365;
  o := t_order('+380 93 000 00 01', '[{"id":"P3","qty":1,"price":1000}]');
  assert (public.affiliate_on_new_order(o, null, null, t_cats()) ->> 'attached')::boolean, 'attached by phone';
  assert (t_commission(o)).source = 'lifetime', 'source lifetime';
  update affiliate_settings set lifetime_days = 0;
end $$;

-- @test Адмін: ручна зміна статусу з коментарем, коригування, зняття / призначення партнера
do $$
declare
  o   uuid;
  num bigint;
  aff uuid := t_aff();
  b   integer;
  k   affiliate_commissions;
begin
  o := t_order('+380 93 000 00 14', '[{"id":"P3","qty":1,"price":10000}]');
  perform public.affiliate_on_new_order(o, t('code'), now(), t_cats());
  b := public.affiliate_balance(aff);
  k := public.affiliate_set_commission_status((t_commission(o)).id, 'approved', 'Підтверджено вручну', null);
  assert k.status = 'approved' and public.affiliate_balance(aff) = b + 300, 'manual approve';
  begin
    perform public.affiliate_set_commission_status(k.id, 'pending', 'x', null);
    assert false, 'approved -> pending not allowed';
  exception when raise_exception then null;
  end;
  begin
    perform public.affiliate_adjust(aff, 50, '', null);
    assert false, 'adjust without comment must fail';
  exception when raise_exception then null;
  end;
  assert public.affiliate_adjust(aff, -50, 'Помилкове нарахування', null) = b + 250, 'adjust';
  select number into num from orders where id = o;
  perform public.affiliate_admin_set_order(num, null, null, null);
  assert t_commission(o) is null and public.affiliate_balance(aff) = b - 50, 'unassigned with reversal';
  assert (public.affiliate_admin_set_order(num, t('code'), t_cats(), null) ->> 'attached')::boolean, 'assigned back';
  assert (t_commission(o)).source = 'admin' and (t_commission(o)).status = 'pending', 'admin commission pending';
  assert (select count(*) from affiliate_admin_log) >= 4, 'admin actions logged';
end $$;

-- @test Журнал і баланс сходяться: по кожному нарахуванню сума в журналі = підтверджені бали
do $$
declare
  aff uuid := t_aff();
  bad integer;
begin
  assert public.affiliate_balance(aff) = (select sum(amount) from affiliate_transactions where affiliate_id = aff), 'ledger sum';
  select count(*) into bad
    from affiliate_commissions k
   where k.affiliate_id = aff
     and (select coalesce(sum(amount), 0) from affiliate_transactions where ref_type = 'commission' and ref_id = k.id::text)
         <> case when k.status = 'approved' then k.commission_amount else 0 end;
  assert bad = 0, bad || ' commissions do not match ledger';
  -- Зняті адміном нарахування: у журналі нуль (нарахування + сторно).
  assert (select coalesce(sum(amount), 0) from affiliate_transactions t
           where t.ref_type = 'commission' and not exists (select 1 from affiliate_commissions k where k.id::text = t.ref_id)) = 0,
         'removed commissions net to zero';
end $$;
