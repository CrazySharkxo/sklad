-- =====================================================================
--  Склад — схема бази для Supabase (Postgres 15+)
--  Виконати один раз: Supabase → SQL Editor → New query → вставити → Run.
--  Скрипт можна запускати повторно: він нічого не видаляє.
-- =====================================================================

-- ---------------------------------------------------------------------
--  Профілі користувачів (ім'я для журналу)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
--  Номенклатура (позиції складу)
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  code        text,                      -- штрихкод / артикул
  category    text not null default '',
  unit        text not null default 'шт',
  location    text not null default '',  -- місце зберігання: стелаж, коробка
  min_qty     numeric not null default 0 check (min_qty >= 0),
  note        text not null default '',
  photo_path  text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Комплекти (специфікації)
-- ---------------------------------------------------------------------
create table if not exists public.kits (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  note        text not null default '',
  photo_path  text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users(id) on delete set null
);

create table if not exists public.kit_components (
  kit_id   uuid not null references public.kits(id) on delete cascade,
  item_id  uuid not null references public.items(id) on delete restrict,
  qty      numeric not null check (qty > 0),
  primary key (kit_id, item_id)
);

-- ---------------------------------------------------------------------
--  Операції (документи) і рядки руху
--    in      — прихід
--    out     — видаток
--    adjust  — інвентаризація (коригування до фактичної кількості)
--    kit_out — видача комплектів (списання всіх компонентів)
-- ---------------------------------------------------------------------
create table if not exists public.operations (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('in', 'out', 'adjust', 'kit_out')),
  comment       text not null default '',
  counterparty  text not null default '',
  kit_id        uuid references public.kits(id) on delete set null,
  kit_qty       numeric,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users(id) on delete set null
);
create index if not exists operations_created_idx on public.operations (created_at desc);

create table if not exists public.movements (
  id            bigint generated always as identity primary key,
  operation_id  uuid not null references public.operations(id) on delete cascade,
  item_id       uuid not null references public.items(id) on delete restrict,
  qty           numeric not null check (qty <> 0),   -- зі знаком: + надходить, − списується
  created_at    timestamptz not null default now()
);
create index if not exists movements_item_idx on public.movements (item_id, id desc);
create index if not exists movements_op_idx   on public.movements (operation_id);

-- ---------------------------------------------------------------------
--  Відділи. Кожен користувач позначає свій у профілі; замовлення
--  в кожен момент «лежить» в одному відділі.
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now()
);
create unique index if not exists departments_name_uq on public.departments (lower(name));

-- стартовий набір — лише в порожню таблицю, щоб перейменовані й видалені не поверталися
insert into public.departments (name)
select n from unnest(array['Прийом замовлень', 'Виробництво', 'Тестування']) as n
 where not exists (select 1 from public.departments);

alter table public.profiles
  add column if not exists department_id uuid references public.departments(id) on delete set null;

-- ---------------------------------------------------------------------
--  Замовлення
--    new → in_work → testing → done → shipped
--                       ↓
--                    rework (повернуто на доопрацювання) → testing …
--    cancelled — скасоване (з будь-якого стану)
--  Статус і відділ змінюються лише функцією move_order — вона пише історію.
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  number         bigint generated always as identity unique,
  title          text not null check (length(trim(title)) > 0),   -- що замовили
  customer       text not null default '',
  qty            numeric not null default 1 check (qty > 0),
  due_date       date,
  description    text not null default '',                         -- опис продукту
  status         text not null default 'new'
                 check (status in ('new', 'in_work', 'testing', 'rework', 'done', 'shipped', 'cancelled')),
  department_id  uuid references public.departments(id) on delete restrict,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index if not exists orders_dep_idx on public.orders (department_id, status);

-- що потрібно зробити: чекліст
create table if not exists public.order_tasks (
  id        uuid primary key default gen_random_uuid(),
  order_id  uuid not null references public.orders(id) on delete cascade,
  position  int not null default 0,
  text      text not null check (length(trim(text)) > 0),
  done      boolean not null default false,
  done_by   uuid references auth.users(id) on delete set null,
  done_at   timestamptz
);
create index if not exists order_tasks_order_idx on public.order_tasks (order_id, position);

-- деталі зі складу під замовлення (кількість — на все замовлення)
create table if not exists public.order_parts (
  order_id  uuid not null references public.orders(id) on delete cascade,
  item_id   uuid not null references public.items(id) on delete restrict,
  qty       numeric not null check (qty > 0),
  primary key (order_id, item_id)
);

-- історія: прийом, кожна передача між статусами/відділами, коментарі
create table if not exists public.order_events (
  id               bigint generated always as identity primary key,
  order_id         uuid not null references public.orders(id) on delete cascade,
  kind             text not null check (kind in ('created', 'move', 'comment')),
  from_status      text,
  to_status        text,
  from_department  uuid references public.departments(id) on delete set null,
  to_department    uuid references public.departments(id) on delete set null,
  text             text not null default '',
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references auth.users(id) on delete set null
);
create index if not exists order_events_order_idx on public.order_events (order_id, id);

-- видача зі складу під конкретне замовлення
alter table public.operations
  add column if not exists order_id uuid references public.orders(id) on delete set null;
create index if not exists operations_order_idx on public.operations (order_id) where order_id is not null;

-- ---------------------------------------------------------------------
--  Кошик: видалене лежить 30 днів, потім його прибирає purge_trash().
--    позиції й замовлення — deleted_at;
--    операції — cancelled_at: видалена операція не рахується в залишках.
-- ---------------------------------------------------------------------
alter table public.items
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.orders
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

-- код унікальний лише серед невидалених позицій
drop index if exists public.items_code_uq;
create unique index items_code_uq
  on public.items (lower(code)) where code is not null and code <> '' and deleted_at is null;

-- ---------------------------------------------------------------------
--  Залишки рахуються, а не зберігаються: сума руху без скасованих операцій
-- ---------------------------------------------------------------------
drop view if exists public.stock;
create view public.stock with (security_invoker = true) as
select i.*,
       coalesce(sum(m.qty) filter (where o.cancelled_at is null), 0)::numeric as qty
from public.items i
left join public.movements  m on m.item_id = i.id
left join public.operations o on o.id = m.operation_id
group by i.id;

-- поточний залишок однієї позиції (для перевірок у функціях)
create or replace function public.item_qty(p_item uuid)
returns numeric language sql stable as $$
  select coalesce(sum(m.qty), 0)
  from public.movements m
  join public.operations o on o.id = m.operation_id
  where m.item_id = p_item and o.cancelled_at is null
$$;

-- ---------------------------------------------------------------------
--  Провести операцію атомарно.
--  p_lines: [{"item_id": "...", "qty": 5}, ...]
--    in / out  — qty > 0 (знак ставить сервер)
--    adjust    — qty = фактична кількість (≥ 0); сервер рахує різницю
--    kit_out   — p_lines ігнорується, розкладається p_kit_id × p_kit_qty
--  p_order_id — необовʼязково: операція під замовлення (видача деталей).
--  Списання нижче нуля — помилка з назвою позиції.
-- ---------------------------------------------------------------------
-- стара версія без p_order_id: інакше лишилося б дві функції з одним імʼям
drop function if exists public.post_operation(text, jsonb, text, text, uuid, numeric);

create or replace function public.post_operation(
  p_type          text,
  p_lines         jsonb,
  p_comment       text default '',
  p_counterparty  text default '',
  p_kit_id        uuid default null,
  p_kit_qty       numeric default null,
  p_order_id      uuid default null
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_op    uuid;
  v_lines jsonb;
  r       record;
  v_have  numeric;
  v_delta numeric;
  v_name  text;
  v_del   timestamptz;
  v_n     int := 0;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if p_type not in ('in', 'out', 'adjust', 'kit_out') then
    raise exception 'Невідомий тип операції: %', p_type;
  end if;
  if p_order_id is not null and not exists (select 1 from public.orders where id = p_order_id and deleted_at is null) then
    raise exception 'Замовлення не знайдено (можливо, воно в кошику)';
  end if;

  if p_type = 'kit_out' then
    if p_kit_id is null or p_kit_qty is null or p_kit_qty <= 0 then
      raise exception 'Вкажіть комплект і кількість';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('item_id', kc.item_id, 'qty', kc.qty * p_kit_qty)), '[]'::jsonb)
      into v_lines
      from public.kit_components kc where kc.kit_id = p_kit_id;
    if jsonb_array_length(v_lines) = 0 then
      raise exception 'Комплект порожній';
    end if;
  else
    v_lines := coalesce(p_lines, '[]'::jsonb);
  end if;

  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'Додайте хоча б одну позицію';
  end if;

  -- блокуємо задіяні позиції, щоб два одночасні видатки не пішли в мінус
  perform 1 from public.items
   where id in (select (e->>'item_id')::uuid from jsonb_array_elements(v_lines) e)
   order by id for update;

  insert into public.operations (type, comment, counterparty, kit_id, kit_qty, order_id)
  values (p_type, coalesce(p_comment, ''), coalesce(p_counterparty, ''),
          case when p_type = 'kit_out' then p_kit_id end,
          case when p_type = 'kit_out' then p_kit_qty end,
          p_order_id)
  returning id into v_op;

  -- однакові позиції в документі зводимо в один рядок
  for r in
    select (e->>'item_id')::uuid as item_id, sum((e->>'qty')::numeric) as qty
      from jsonb_array_elements(v_lines) e
     group by 1
  loop
    select name, deleted_at into v_name, v_del from public.items where id = r.item_id;
    if v_name is null then
      raise exception 'Позицію не знайдено';
    end if;
    if v_del is not null then
      raise exception 'Позиція «%» у кошику — спершу відновіть її', v_name;
    end if;
    if r.qty is null or (p_type <> 'adjust' and r.qty <= 0) or (p_type = 'adjust' and r.qty < 0) then
      raise exception 'Неправильна кількість для «%»', v_name;
    end if;

    v_have := public.item_qty(r.item_id);
    v_delta := case p_type
                 when 'in'     then r.qty
                 when 'adjust' then r.qty - v_have
                 else -r.qty
               end;

    if v_have + v_delta < 0 then
      raise exception 'Недостатньо «%»: є %, потрібно %', v_name, trim_scale(v_have), trim_scale(r.qty);
    end if;

    if v_delta <> 0 then
      insert into public.movements (operation_id, item_id, qty) values (v_op, r.item_id, v_delta);
      v_n := v_n + 1;
    end if;
  end loop;

  -- інвентаризація без розбіжностей теж фіксується (як факт перерахунку),
  -- а порожній прихід/видаток — ні
  if v_n = 0 and p_type <> 'adjust' then
    raise exception 'Немає що проводити';
  end if;

  return v_op;
end $$;

-- ---------------------------------------------------------------------
--  Видалити операцію (у кошик). Залишки рахуються без неї. Заборонено,
--  якщо залишок піде в мінус: наприклад, видалити прихід, з якого вже видали.
-- ---------------------------------------------------------------------
create or replace function public.cancel_operation(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  r record;
  v_have numeric;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;

  perform 1 from public.operations where id = p_id and cancelled_at is null for update;
  if not found then
    raise exception 'Операцію не знайдено або її вже видалено';
  end if;

  perform 1 from public.items
   where id in (select item_id from public.movements where operation_id = p_id)
   order by id for update;

  for r in
    select m.item_id, sum(m.qty) as qty, i.name
      from public.movements m join public.items i on i.id = m.item_id
     where m.operation_id = p_id
     group by m.item_id, i.name
  loop
    v_have := public.item_qty(r.item_id);
    if v_have - r.qty < 0 then
      raise exception 'Не можна видалити: залишок «%» стане %', r.name, trim_scale(v_have - r.qty);
    end if;
  end loop;

  update public.operations
     set cancelled_at = now(), cancelled_by = auth.uid()
   where id = p_id;
end $$;

-- повернути операцію з кошика — якщо від цього нічого не піде в мінус
create or replace function public.restore_operation(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  r record;
  v_have numeric;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  perform 1 from public.operations where id = p_id and cancelled_at is not null for update;
  if not found then
    raise exception 'Операцію не знайдено в кошику';
  end if;
  perform 1 from public.items
   where id in (select item_id from public.movements where operation_id = p_id)
   order by id for update;
  for r in
    select m.item_id, sum(m.qty) as qty, i.name
      from public.movements m join public.items i on i.id = m.item_id
     where m.operation_id = p_id
     group by m.item_id, i.name
  loop
    v_have := public.item_qty(r.item_id);
    if v_have + r.qty < 0 then
      raise exception 'Не можна відновити: залишок «%» стане %', r.name, trim_scale(v_have + r.qty);
    end if;
  end loop;
  update public.operations set cancelled_at = null, cancelled_by = null where id = p_id;
end $$;

-- остаточно видалити операцію з кошика
create or replace function public.purge_operation(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  delete from public.operations where id = p_id and cancelled_at is not null;
  if not found then
    raise exception 'Операцію не знайдено в кошику';
  end if;
end $$;

-- ---------------------------------------------------------------------
--  Позиції: у кошик / назад / остаточно
-- ---------------------------------------------------------------------
create or replace function public.trash_item(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  update public.items set deleted_at = now(), deleted_by = auth.uid() where id = p_id and deleted_at is null;
  if not found then
    raise exception 'Позицію не знайдено або вона вже в кошику';
  end if;
end $$;

create or replace function public.restore_item(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  update public.items set deleted_at = null, deleted_by = null where id = p_id and deleted_at is not null;
  if not found then
    raise exception 'Позицію не знайдено в кошику';
  end if;
end $$;

-- повертає шлях фото, щоб застосунок прибрав і його
create or replace function public.purge_item(p_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_photo text;
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if not exists (select 1 from public.items where id = p_id and deleted_at is not null) then
    raise exception 'Позицію не знайдено в кошику';
  end if;
  if exists (select 1 from public.movements where item_id = p_id)
     or exists (select 1 from public.kit_components where item_id = p_id)
     or exists (select 1 from public.order_parts where item_id = p_id) then
    raise exception 'Позиція має історію руху або є в комплекті чи замовленні — остаточно її видалити не можна. Через 30 днів вона сама зникне з кошика, а в журналі лишиться її назва';
  end if;
  delete from public.items where id = p_id returning photo_path into v_photo;
  return v_photo;
end $$;

-- оновлення updated_at у позиціях
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
--  Замовлення: перший запис історії створюється сам
-- ---------------------------------------------------------------------
create or replace function public.order_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.order_events (order_id, kind, to_status, to_department, created_by)
  values (new.id, 'created', new.status, new.department_id, new.created_by);
  return new;
end $$;
drop trigger if exists orders_created on public.orders;
create trigger orders_created after insert on public.orders
  for each row execute function public.order_created();

-- хто й коли відмітив пункт чекліста — ставить сервер, а не клієнт
create or replace function public.order_task_done()
returns trigger language plpgsql as $$
begin
  if not new.done then
    new.done_by := null;
    new.done_at := null;
  elsif tg_op = 'INSERT' or not old.done then
    new.done_by := auth.uid();
    new.done_at := now();
  else
    new.done_by := old.done_by;
    new.done_at := old.done_at;
  end if;
  return new;
end $$;
drop trigger if exists order_tasks_done on public.order_tasks;
create trigger order_tasks_done before insert or update on public.order_tasks
  for each row execute function public.order_task_done();

-- ---------------------------------------------------------------------
--  Передати замовлення: новий статус і/або інший відділ + запис в історію.
--  Повернення на доопрацювання і скасування — лише з коментарем.
-- ---------------------------------------------------------------------
create or replace function public.move_order(
  p_id          uuid,
  p_status      text,
  p_department  uuid default null,
  p_comment     text default ''
) returns void
language plpgsql
set search_path = public
as $$
declare
  v    public.orders%rowtype;
  v_dep uuid;
  v_txt text := trim(coalesce(p_comment, ''));
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if p_status not in ('new', 'in_work', 'testing', 'rework', 'done', 'shipped', 'cancelled') then
    raise exception 'Невідомий статус: %', p_status;
  end if;
  select * into v from public.orders where id = p_id and deleted_at is null for update;
  if not found then
    raise exception 'Замовлення не знайдено';
  end if;
  v_dep := coalesce(p_department, v.department_id);
  if p_status = 'rework' and v_txt = '' then
    raise exception 'Напишіть у коментарі, що треба доопрацювати';
  end if;
  if p_status = 'cancelled' and v_txt = '' then
    raise exception 'Напишіть у коментарі причину скасування';
  end if;
  if p_status = v.status and v_dep is not distinct from v.department_id then
    raise exception 'Нічого не змінилося';
  end if;

  update public.orders set status = p_status, department_id = v_dep where id = p_id;
  insert into public.order_events (order_id, kind, from_status, to_status, from_department, to_department, text)
  values (p_id, 'move', v.status, p_status, v.department_id, v_dep, v_txt);
end $$;

-- ---------------------------------------------------------------------
--  Замовлення: у кошик / назад / остаточно (тоді зникають чекліст, деталі
--  й історія; видача зі складу лишається в журналі без привʼязки).
-- ---------------------------------------------------------------------
create or replace function public.delete_order(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  update public.orders set deleted_at = now(), deleted_by = auth.uid() where id = p_id and deleted_at is null;
  if not found then
    raise exception 'Замовлення не знайдено або воно вже в кошику';
  end if;
end $$;

create or replace function public.restore_order(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  update public.orders set deleted_at = null, deleted_by = null where id = p_id and deleted_at is not null;
  if not found then
    raise exception 'Замовлення не знайдено в кошику';
  end if;
end $$;

create or replace function public.purge_order(p_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  delete from public.orders where id = p_id and deleted_at is not null;
  if not found then
    raise exception 'Замовлення не знайдено в кошику';
  end if;
end $$;

-- ---------------------------------------------------------------------
--  Прибрати з кошика все старше 30 днів. Викликає застосунок після входу.
--  Позиція з історією руху не видаляється — лише зникає з кошика
--  (інакше зламалися б залишки й журнал). Повертає шляхи фото видалених.
-- ---------------------------------------------------------------------
create or replace function public.purge_trash()
returns setof text
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  delete from public.orders where deleted_at < now() - interval '30 days';
  delete from public.operations where cancelled_at < now() - interval '30 days';
  return query
    with gone as (
      delete from public.items i
       where i.deleted_at < now() - interval '30 days'
         and not exists (select 1 from public.movements m where m.item_id = i.id)
         and not exists (select 1 from public.kit_components k where k.item_id = i.id)
         and not exists (select 1 from public.order_parts o where o.item_id = i.id)
      returning i.photo_path)
    select g.photo_path from gone g where g.photo_path is not null;
end $$;

-- ---------------------------------------------------------------------
--  Доступ: усі увійшлі користувачі рівні. Анонім не бачить нічого.
--  Операції не видаляються — лише скасовуються (історія не губиться).
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.items          enable row level security;
alter table public.kits           enable row level security;
alter table public.kit_components enable row level security;
alter table public.operations     enable row level security;
alter table public.movements      enable row level security;
alter table public.departments    enable row level security;
alter table public.orders         enable row level security;
alter table public.order_tasks    enable row level security;
alter table public.order_parts    enable row level security;
alter table public.order_events   enable row level security;

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
drop policy if exists profiles_upd   on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_write on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_upd   on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists items_all on public.items;
create policy items_all on public.items for all to authenticated using (true) with check (true);

drop policy if exists kits_all on public.kits;
create policy kits_all on public.kits for all to authenticated using (true) with check (true);

drop policy if exists kit_components_all on public.kit_components;
create policy kit_components_all on public.kit_components for all to authenticated using (true) with check (true);

drop policy if exists operations_read   on public.operations;
drop policy if exists operations_insert on public.operations;
drop policy if exists operations_update on public.operations;
create policy operations_read   on public.operations for select to authenticated using (true);
create policy operations_insert on public.operations for insert to authenticated with check (created_by = auth.uid());
create policy operations_update on public.operations for update to authenticated using (true) with check (true);

drop policy if exists movements_read   on public.movements;
drop policy if exists movements_insert on public.movements;
create policy movements_read   on public.movements for select to authenticated using (true);
create policy movements_insert on public.movements for insert to authenticated with check (true);

drop policy if exists departments_all on public.departments;
create policy departments_all on public.departments for all to authenticated using (true) with check (true);

drop policy if exists orders_read   on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
create policy orders_read   on public.orders for select to authenticated using (true);
create policy orders_insert on public.orders for insert to authenticated with check (created_by = auth.uid());
create policy orders_update on public.orders for update to authenticated using (true) with check (true);

drop policy if exists order_tasks_all on public.order_tasks;
create policy order_tasks_all on public.order_tasks for all to authenticated using (true) with check (true);

drop policy if exists order_parts_all on public.order_parts;
create policy order_parts_all on public.order_parts for all to authenticated using (true) with check (true);

-- історію напряму можна лише доповнити власним коментарем; передачі пише move_order
drop policy if exists order_events_read    on public.order_events;
drop policy if exists order_events_comment on public.order_events;
create policy order_events_read    on public.order_events for select to authenticated using (true);
create policy order_events_comment on public.order_events for insert to authenticated
  with check (kind = 'comment' and created_by = auth.uid() and length(trim(text)) > 0);

-- явні дозволи: не залежимо від галочки «Grant API access to new tables automatically»
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.items, public.kits, public.kit_components to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.operations, public.movements to authenticated;
revoke all on public.items, public.kits, public.kit_components, public.profiles from anon;

-- операції змінюються лише через функції: напряму можна тільки читати
revoke insert, update, delete on public.operations from anon, authenticated;
revoke insert, update, delete on public.movements  from anon, authenticated;
revoke all on public.stock from anon;
grant select on public.stock to authenticated;

-- замовлення: статус, відділ, номер і автора не можна переписати напряму —
-- спершу знімаємо табличні права (це знімає й колонкові), потім даємо колонкові
revoke all on public.departments, public.orders, public.order_tasks, public.order_parts, public.order_events from anon;
revoke insert, update, delete on public.orders, public.order_events from authenticated;
grant select on public.departments, public.orders, public.order_tasks, public.order_parts, public.order_events to authenticated;
grant insert, update, delete on public.departments, public.order_tasks, public.order_parts to authenticated;
grant insert (id, title, customer, qty, due_date, description, department_id) on public.orders to authenticated;
grant update (title, customer, qty, due_date, description) on public.orders to authenticated;
grant insert (order_id, kind, text) on public.order_events to authenticated;

-- функції працюють від імені власника схеми (обходять revoke вище),
-- але самі перевіряють auth.uid()
alter function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid) security definer;
alter function public.cancel_operation(uuid) security definer;
alter function public.move_order(uuid, text, uuid, text) security definer;
alter function public.delete_order(uuid) security definer;
alter function public.restore_operation(uuid) security definer;
alter function public.purge_operation(uuid) security definer;
alter function public.trash_item(uuid) security definer;
alter function public.restore_item(uuid) security definer;
alter function public.purge_item(uuid) security definer;
alter function public.restore_order(uuid) security definer;
alter function public.purge_order(uuid) security definer;
alter function public.purge_trash() security definer;
revoke execute on function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid) from public, anon;
revoke execute on function public.cancel_operation(uuid) from public, anon;
revoke execute on function public.move_order(uuid, text, uuid, text) from public, anon;
revoke execute on function public.delete_order(uuid) from public, anon;
revoke execute on function public.restore_operation(uuid) from public, anon;
revoke execute on function public.purge_operation(uuid) from public, anon;
revoke execute on function public.trash_item(uuid) from public, anon;
revoke execute on function public.restore_item(uuid) from public, anon;
revoke execute on function public.purge_item(uuid) from public, anon;
revoke execute on function public.restore_order(uuid) from public, anon;
revoke execute on function public.purge_order(uuid) from public, anon;
revoke execute on function public.purge_trash() from public, anon;
grant  execute on function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid) to authenticated;
grant  execute on function public.cancel_operation(uuid) to authenticated;
grant  execute on function public.move_order(uuid, text, uuid, text) to authenticated;
grant  execute on function public.delete_order(uuid) to authenticated;
grant  execute on function public.restore_operation(uuid) to authenticated;
grant  execute on function public.purge_operation(uuid) to authenticated;
grant  execute on function public.trash_item(uuid) to authenticated;
grant  execute on function public.restore_item(uuid) to authenticated;
grant  execute on function public.purge_item(uuid) to authenticated;
grant  execute on function public.restore_order(uuid) to authenticated;
grant  execute on function public.purge_order(uuid) to authenticated;
grant  execute on function public.purge_trash() to authenticated;

-- ---------------------------------------------------------------------
--  Фото: приватне сховище «photos», доступ лише увійшлим
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists photos_read   on storage.objects;
drop policy if exists photos_insert on storage.objects;
drop policy if exists photos_update on storage.objects;
drop policy if exists photos_delete on storage.objects;
create policy photos_read   on storage.objects for select to authenticated using (bucket_id = 'photos');
create policy photos_insert on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy photos_update on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy photos_delete on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- ---------------------------------------------------------------------
--  Живе оновлення: зміни з телефону одразу з'являються на ПК
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['items', 'kits', 'kit_components', 'operations', 'movements',
                             'departments', 'orders', 'order_tasks', 'order_parts', 'order_events', 'profiles'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
