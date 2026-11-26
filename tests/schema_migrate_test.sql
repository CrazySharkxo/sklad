-- Міграція зі схеми, де порядку позицій і категорій ще не було: відкочуємо ці
-- частини, запускаємо schema.sql (двічі) і дивимось, що дані на місці, наявні
-- позиції стали за назвою, а повторний запуск збережений порядок не збиває.
\set ON_ERROR_STOP on

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
end $$;

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
end $$;

\echo MIGRATION TESTS PASSED
