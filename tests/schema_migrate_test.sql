-- Міграція зі схеми, де порядку позицій і категорій ще не було: відкочуємо ці
-- частини, запускаємо schema.sql (двічі) і дивимось, що дані на місці, наявні
-- позиції стали за назвою, а повторний запуск збережений порядок не збиває.
-- Так само — головний адміністратор і дві нові ролі: на базі без них головним стає
-- найстарший активний адміністратор, ролі додаються один раз.
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

-- стара схема: без sort_order, category_order і функцій порядку
drop function public.set_item_order(uuid[]);
drop function public.set_category_order(text[]);
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
do $$
declare v_first uuid := (select id from public.items order by sort_order limit 1);
begin
  assert (select sort_order = (select max(sort_order) from public.items) from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000041');
  -- користувач переставив: нова — першою; і вибрав порядок категорій
  perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000041', v_first]);
  perform public.set_category_order(array['Стара', 'Мотори']);
  assert (select id from public.items order by sort_order limit 1) = 'aaaaaaaa-0000-0000-0000-000000000041';
end $$;
reset role;
create temp table mig_order as select id, sort_order, updated_at from public.items;

-- повторний запуск на вже мігрованій базі нічого не збиває
\ir ../supabase/schema.sql

do $$ begin
  assert (select count(*) from public.items i join mig_order o using (id)
           where i.sort_order <> o.sort_order or i.updated_at <> o.updated_at) = 0, 'повторний запуск збив порядок';
  assert (select count(*) from public.items) = (select count(*) from mig_order);
  assert (select category_order from public.app_settings) = array['Стара', 'Мотори'], 'повторний запуск збив порядок категорій';
  assert (select array_agg(id) from public.profiles where is_owner) = array['22222222-2222-2222-2222-222222222222'::uuid],
    'повторний запуск змінив головного';
  assert not exists (select 1 from public.roles where name = 'Звичайний користувач'), 'видалена роль воскресла';
  assert (select perms from public.roles where name = 'Старший користувач') = array['stock.view'], 'змінену роль перезаписано';
  assert (select count(*) from public.roles) = (select count(*) from mig_roles) + 1, 'повторний запуск додав ролі';
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
