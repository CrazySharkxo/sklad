-- Міграція зі схеми, де порядку позицій і категорій ще не було: відкочуємо ці
-- частини, запускаємо schema.sql (двічі) і дивимось, що дані на місці, наявні
-- позиції стали за назвою, а повторний запуск збережений порядок не збиває.
-- Так само — головний адміністратор і дві нові ролі: на базі без них головним стає
-- найстарший активний адміністратор, ролі додаються один раз.
-- І видачі замовнику з боргами: на базі без них (order_shipments, order_debts, debt_id)
-- старі замовлення лишаються як були, нові таблиці зʼявляються порожні, повторний запуск
-- нічого не дублює, старий клієнт працює далі.
\set ON_ERROR_STOP on

-- стара схема: без головного адміністратора й нових ролей
delete from public.roles where name in ('Звичайний користувач', 'Старший користувач');
drop policy roles_admin on public.roles;
create policy roles_admin on public.roles for all to authenticated
  using ((select public.has_perm('admin'))) with check ((select public.has_perm('admin')));
drop function public.require_owner();
drop function public.owner_id();
drop function public.is_owner();
drop index public.profiles_owner_uq;
alter table public.profiles drop column is_owner;
alter table public.app_settings drop column roles_seed;
-- хто є: ivan і olena — «Адміністратор», Оля — свої галочки. Найстаршою робимо Олю,
-- але вона заблокований адміністратор; серед активних найстарша — olena
update public.profiles set perms = array['admin'], active = false, created_at = '2020-01-01'
 where id = (select id from auth.users where email = 'view@example.com');
update auth.users set created_at = '2020-01-01' where email = 'view@example.com';
update public.profiles set created_at = '2021-01-01' where id = '22222222-2222-2222-2222-222222222222';
update auth.users set created_at = '2021-01-01' where id = '22222222-2222-2222-2222-222222222222';
update public.profiles set created_at = '2022-01-01' where id = '11111111-1111-1111-1111-111111111111';
update auth.users set created_at = '2022-01-01' where id = '11111111-1111-1111-1111-111111111111';
create temp table mig_roles as select id, name, perms from public.roles;

-- стара схема: без sort_order, category_order, nav_order і функцій порядку
drop function public.set_item_order(uuid[]);
drop function public.set_category_order(text[]);
drop function public.set_nav_order(text[]);
alter table public.app_settings drop column nav_order;
drop trigger items_sort_new on public.items;
drop function public.item_sort_new();
drop trigger items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();
drop view public.stock;
alter table public.items drop column sort_order;
alter table public.app_settings drop column category_order;
create view public.stock with (security_invoker = true) as
select i.*,
       coalesce(sum(m.qty) filter (where o.cancelled_at is null), 0)::numeric as qty,
       coalesce(r.reserved, 0)::numeric as reserved
from public.items i
left join public.movements    m on m.item_id = i.id
left join public.operations   o on o.id = m.operation_id
left join public.reserved_qty r on r.item_id = i.id
group by i.id, r.reserved;
grant select on public.stock to authenticated;

-- стара схема: без видач замовнику й боргів — ні таблиць, ні функцій, ні нових видів подій,
-- резерв і move_order — як були до них
drop function public.ship_order(uuid, numeric, date, text, jsonb, uuid[]);
drop function public.cancel_order_shipment(uuid);
drop function public.close_order_debt(uuid, numeric, text);
drop trigger orders_qty_guard on public.orders;
drop function public.order_qty_guard();
drop view public.order_debts_left;
create or replace view public.reserved_qty as
select p.item_id,
       sum(greatest(0, p.qty - coalesce((
         select -sum(m.qty)
           from public.movements m
           join public.operations op on op.id = m.operation_id
          where op.order_id = p.order_id and op.type = 'out' and op.cancelled_at is null and m.item_id = p.item_id), 0)))::numeric as reserved
  from public.order_parts p
  join public.orders o on o.id = p.order_id
 where o.deleted_at is null and o.status in ('new', 'in_work', 'testing', 'rework', 'done')
 group by p.item_id;
alter table public.operations drop column debt_id;
alter table public.order_units drop column shipment_id;
drop table public.order_debts;
drop table public.order_shipments;
delete from public.order_events where kind in ('ship', 'ship_cancel', 'debt');
alter table public.order_events drop constraint order_events_kind_check;
alter table public.order_events add constraint order_events_kind_check check (kind in ('created', 'move', 'comment'));
create or replace function public.move_order(p_id uuid, p_status text, p_department uuid default null, p_comment text default '')
returns void language plpgsql security definer set search_path = public as $$
declare
  v    public.orders%rowtype;
  v_dep uuid;
  v_txt text := trim(coalesce(p_comment, ''));
begin
  perform public.require('orders.edit');
  select * into v from public.orders where id = p_id and deleted_at is null for update;
  if not found or not public.can_see_order(v.department_id) then
    raise exception 'Замовлення не знайдено';
  end if;
  v_dep := coalesce(p_department, v.department_id);
  update public.orders set status = p_status, department_id = v_dep where id = p_id;
  insert into public.order_events (order_id, kind, from_status, to_status, from_department, to_department, text)
  values (p_id, 'move', v.status, p_status, v.department_id, v_dep, v_txt);
end $$;

-- старий клієнт на старій схемі: одне замовлення відвантажив (по-старому, без видач), друге — в роботі з деталями
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.orders (id, title, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000041', 'Старе відвантажене', 3, (select id from public.departments where name = 'Прийом замовлень')),
  ('cccccccc-0000-0000-0000-000000000042', 'Старе в роботі', 5, (select id from public.departments where name = 'Прийом замовлень'));
insert into public.order_parts values ('cccccccc-0000-0000-0000-000000000042', 'aaaaaaaa-0000-0000-0000-000000000051', 5);
select public.move_order('cccccccc-0000-0000-0000-000000000041', 'shipped');
select public.move_order('cccccccc-0000-0000-0000-000000000042', 'in_work');
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":5}]');
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":1}]', '', '',
                             null, null, 'cccccccc-0000-0000-0000-000000000042');
reset role;
do $$ begin assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') = 4; end $$;
create temp table mig_orders as
  select (select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o) as orders,
         (select count(*) from public.order_events) as events, (select count(*) from public.operations) as ops;

-- старий клієнт на старій схемі додає позицію
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.items (name, category) values ('Ббб до міграції', 'Стара');
reset role;
create temp table mig_before as
  select (select count(*) from public.items) as items, (select count(*) from public.movements) as moves,
         (select org_name from public.app_settings) as org,
         (select jsonb_agg(to_jsonb(s) - 'sort_order' order by s.id) from public.stock s) as stock;

\ir ../supabase/schema.sql

do $$
declare b mig_before%rowtype;
begin
  select * into b from mig_before;
  assert (select count(*) from public.items) = b.items and (select count(*) from public.movements) = b.moves, 'міграція загубила рядки';
  assert (select org_name from public.app_settings) = b.org, 'міграція зачепила налаштування';
  assert (select jsonb_agg(to_jsonb(s) - 'sort_order' - 'updated_at' order by s.id) from public.stock s)
       = (select jsonb_agg(e - 'updated_at' order by e ->> 'id') from jsonb_array_elements(b.stock) e), 'міграція змінила позиції чи залишки';
  -- наявні позиції (разом з архівом і кошиком) — за назвою, місця 1..N
  assert (select array_agg(id order by sort_order) from public.items)
       = (select array_agg(id order by name, created_at, id) from public.items), 'початковий порядок — за назвою';
  assert (select min(sort_order) = 1 and max(sort_order) = count(*) and count(distinct sort_order) = count(*) from public.items);
  assert (select category_order from public.app_settings) = '{}';
  assert (select nav_order from public.app_settings) = '{}', 'після міграції порядок меню — за замовчуванням';
  -- головний — найстарший АКТИВНИЙ адміністратор, рівно один
  assert (select array_agg(id) from public.profiles where is_owner) = array['22222222-2222-2222-2222-222222222222'::uuid],
    'головний після міграції: ' || coalesce((select string_agg(id::text, ',') from public.profiles where is_owner), 'нема');
  -- нові ролі додано, старі не зачеплено
  assert (select perms from public.roles where name = 'Звичайний користувач') = array['stock.view', 'ops.view', 'kits.view', 'orders.view'];
  assert (select perms from public.roles where name = 'Старший користувач')
       = array['stock.view', 'stock.edit', 'ops.view', 'ops.edit', 'kits.view', 'kits.edit', 'orders.view', 'orders.edit', 'orders.all'];
  assert (select count(*) from public.roles) = (select count(*) from mig_roles) + 2;
  assert not exists (select 1 from mig_roles m left join public.roles r on r.id = m.id
                      where r.id is null or r.name <> m.name or r.perms <> m.perms), 'міграція зачепила старі ролі';
  -- ролі й права людей не змінились
  assert (select r.name from public.profiles p join public.roles r on r.id = p.role_id
           where p.id = '11111111-1111-1111-1111-111111111111') = 'Адміністратор';
  -- видачі замовнику: таблиці зʼявились порожні, замовлення, історія й операції — як були;
  -- старе відвантажене замовлення лишилось відвантаженим, видач йому ніхто не «домалював»
  assert (select count(*) from public.order_shipments) = 0 and (select count(*) from public.order_debts) = 0
     and (select count(*) from public.order_debts_left) = 0, 'нові таблиці не порожні';
  assert (select jsonb_agg(to_jsonb(o) order by o.id) from public.orders o) = (select orders from mig_orders), 'міграція змінила замовлення';
  assert (select count(*) from public.order_events) = (select events from mig_orders)
     and (select count(*) from public.operations) = (select ops from mig_orders), 'міграція змінила історію чи операції';
  assert (select count(*) from public.operations where debt_id is not null) = 0 and (select count(*) from public.order_units where shipment_id is not null) = 0;
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') = 4, 'резерв після міграції';
end $$;

-- після міграції: колишній адміністратор ivan уже не керує людьми, olena — керує
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
do $$ begin
  begin
    perform public.admin_create_user('mig@example.com', 'secret1');
    raise exception 'не головний створив користувача після міграції';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;
-- головна видаляє одну з нових ролей і змінює другу — повторний запуск цього не відкотить
delete from public.roles where name = 'Звичайний користувач';
update public.roles set perms = array['stock.view'] where name = 'Старший користувач';
reset role;
-- якби головного перераховували заново — ним став би ivan (тепер найстарший)
update auth.users set created_at = '2019-01-01' where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set created_at = '2019-01-01' where id = '11111111-1111-1111-1111-111111111111';

-- старий клієнт на новій схемі: вставка без sort_order працює, позиція — в кінці
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.items (id, name) values ('aaaaaaaa-0000-0000-0000-000000000041', 'Ааа після міграції');
do $$ begin
  assert (select sort_order = (select max(sort_order) from public.items) from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000041');
  -- старий клієнт ще показує «Порядок» кожному зі stock.edit: ivan (адміністратор, не головний) отримує відмову
  begin
    perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000041'::uuid]);
    raise exception 'не головний змінив порядок позицій після міграції';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.set_category_order(array['Стара']);
    raise exception 'не головний змінив порядок категорій після міграції';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.set_nav_order(array['stock']);
    raise exception 'не головний змінив порядок меню після міграції';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  assert (select nav_order from public.app_settings) = '{}', 'порядок меню читається';
end $$;
reset role;
-- головна (olena) переставила: нова — першою; вибрала порядок категорій і меню
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;
do $$
declare v_first uuid := (select id from public.items order by sort_order limit 1);
begin
  perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000041', v_first]);
  perform public.set_category_order(array['Стара', 'Мотори']);
  perform public.set_nav_order(array['orders', 'kits', 'stock']);
  assert (select id from public.items order by sort_order limit 1) = 'aaaaaaaa-0000-0000-0000-000000000041';
end $$;
reset role;

-- видачі замовнику після міграції. Старий клієнт на новій схемі (про видачі не знає): передає, коментує,
-- видає деталі, відвантажує по-старому — усе працює; відвантаження саме дописує видачу всієї кількості
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.order_events (order_id, kind, text) values ('cccccccc-0000-0000-0000-000000000042', 'comment', 'старий клієнт');
select public.move_order('cccccccc-0000-0000-0000-000000000042', 'testing', (select id from public.departments where name = 'Тестування'), 'на тест');
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":1}]', '', '',
                             null, null, 'cccccccc-0000-0000-0000-000000000042');
insert into public.orders (id, title, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000043', 'Нове після міграції', 2, (select id from public.departments where name = 'Прийом замовлень'));
select public.move_order('cccccccc-0000-0000-0000-000000000043', 'shipped');
do $$ begin
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') = 3, 'видача деталей старим клієнтом';
  assert (select count(*) from public.orders o left join public.order_units u on u.order_id = o.id) > 0;   -- старий select з order_units(*)
  assert (select qty || '|' || auto from public.order_shipments where order_id = 'cccccccc-0000-0000-0000-000000000043') = '2|true';
  -- відновлення старого відвантаженого (без видач) теж працює
  perform public.move_order('cccccccc-0000-0000-0000-000000000041', 'in_work');
  assert (select count(*) from public.order_shipments where order_id = 'cccccccc-0000-0000-0000-000000000041') = 0;
end $$;
-- новий клієнт: часткова видача з боргом на замовленні, що було ще до міграції
select public.ship_order('cccccccc-0000-0000-0000-000000000042', 2, null, 'після міграції',
                         '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":2}]');
do $$ begin
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000042') = 'testing';
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') = 5, '3 на збірку + 2 боргу';
  perform public.close_order_debt((select id from public.order_debts), 1);
  assert (select left_qty from public.order_debts_left) = 1;
end $$;
reset role;
create temp table mig_ship as
  select (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_shipments t) as ships,
         (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_debts_left t) as debts,
         (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_events t) as events,
         (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') as reserved;
create temp table mig_order as select id, sort_order, updated_at from public.items;

-- повторний запуск на вже мігрованій базі нічого не збиває
\ir ../supabase/schema.sql

do $$ begin
  assert (select count(*) from public.items i join mig_order o using (id)
           where i.sort_order <> o.sort_order or i.updated_at <> o.updated_at) = 0, 'повторний запуск збив порядок';
  assert (select count(*) from public.items) = (select count(*) from mig_order);
  assert (select category_order from public.app_settings) = array['Стара', 'Мотори'], 'повторний запуск збив порядок категорій';
  assert (select nav_order from public.app_settings) = array['orders', 'kits', 'stock'], 'повторний запуск збив порядок меню';
  assert (select array_agg(id) from public.profiles where is_owner) = array['22222222-2222-2222-2222-222222222222'::uuid],
    'повторний запуск змінив головного';
  assert not exists (select 1 from public.roles where name = 'Звичайний користувач'), 'видалена роль воскресла';
  assert (select perms from public.roles where name = 'Старший користувач') = array['stock.view'], 'змінену роль перезаписано';
  assert (select count(*) from public.roles) = (select count(*) from mig_roles) + 1, 'повторний запуск додав ролі';
  -- видачі, борги й історія — рядок у рядок, нічого не задвоїлось і не зникло
  assert (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_shipments t) = (select ships from mig_ship), 'повторний запуск змінив видачі';
  assert (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_debts_left t) = (select debts from mig_ship), 'повторний запуск змінив борги';
  assert (select jsonb_agg(to_jsonb(t) order by t.id) from public.order_events t) = (select events from mig_ship), 'повторний запуск змінив історію';
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000051') = (select reserved from mig_ship);
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename in ('order_shipments', 'order_debts')) = 2, 'політики видач';
  assert (select count(*) from pg_constraint where conrelid = 'public.order_events'::regclass and contype = 'c' and conname like '%kind%') = 1, 'обмеження видів подій задвоїлось';
  assert (select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_qty_guard') = 1;
  assert (select count(*) from pg_proc where proname in ('ship_order', 'cancel_order_shipment', 'close_order_debt')) = 3, 'зайві версії функцій';
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 16;
end $$;

-- ручна передача статусу головного (README): olena → ivan, далі керує ivan, olena — вже ні
begin;
update public.profiles set is_owner = false where is_owner;
update public.profiles set is_owner = true where id = (select id from auth.users where email = 'ivan@example.com');
commit;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
do $$ begin
  assert public.is_owner() and public.owner_id() = '11111111-1111-1111-1111-111111111111';
  perform public.admin_update_user('22222222-2222-2222-2222-222222222222', 'olena',
    (select id from public.roles where name = 'Адміністратор'), null, null, true);
end $$;
reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;
do $$ begin
  begin
    perform public.admin_set_password('11111111-1111-1111-1111-111111111111', 'secret12');
    raise exception 'колишня головна керує після передачі';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
end $$;
reset role;

\echo MIGRATION TESTS PASSED
