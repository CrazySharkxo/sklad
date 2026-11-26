-- =====================================================================
--  Склад — схема бази для Supabase (Postgres 15+)
--  Виконати один раз: Supabase → SQL Editor → New query → вставити → Run.
--  Скрипт можна запускати повторно: він нічого не видаляє.
--  Права: ролі й галочки — розділ «Ролі та права» нижче.
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
  insert into public.profiles (id, display_name, role_id)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1),
          (select id from public.roles
            where name = case when exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                                            where p.active and 'admin' = any(coalesce(p.perms, r.perms)))
                              then 'Лише перегляд' else 'Адміністратор' end))
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
--  Порядок позицій у «Залишках» — спільний для всіх. Міняє його лише
--  set_item_order() (право «змінювати позиції складу»); нова позиція стає в кінець.
--  Наявні позиції отримують місця за назвою — так список сортувався досі;
--  повторний запуск чіпає лише ті, що ще без місця.
-- ---------------------------------------------------------------------
alter table public.items add column if not exists sort_order integer;
update public.items i set sort_order = s.n
  from (select id,
               coalesce((select max(sort_order) from public.items), 0)
                 + row_number() over (order by name, created_at, id) as n
          from public.items where sort_order is null) s
 where i.id = s.id;
alter table public.items alter column sort_order set not null;

create or replace function public.item_sort_new()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.sort_order is null then
    new.sort_order := coalesce((select max(sort_order) from public.items), 0) + 1;
  end if;
  return new;
end $$;
drop trigger if exists items_sort_new on public.items;
create trigger items_sort_new before insert on public.items
  for each row execute function public.item_sort_new();

-- ---------------------------------------------------------------------
--  Серійні номери готових виробів: у замовленні на N штук — N виробів,
--  кожен зі своїм номером (друкується на QR-етикетці, скан відкриває
--  замовлення), відмітками «зібрано» і «протестовано».
-- ---------------------------------------------------------------------
create table if not exists public.order_units (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  position      int not null default 0,
  serial        text not null check (length(trim(serial)) > 0),
  assembled     boolean not null default false,
  assembled_by  uuid references auth.users(id) on delete set null,
  assembled_at  timestamptz,
  tested        boolean not null default false,
  tested_by     uuid references auth.users(id) on delete set null,
  tested_at     timestamptz,
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists order_units_order_idx on public.order_units (order_id, position);
create unique index if not exists order_units_serial_uq on public.order_units (lower(trim(serial)));

-- хто й коли зібрав / протестував — ставить сервер
create or replace function public.order_unit_stamp()
returns trigger language plpgsql as $$
begin
  new.serial := trim(new.serial);
  if not new.assembled then
    new.assembled_by := null; new.assembled_at := null;
  elsif tg_op = 'INSERT' or not old.assembled then
    new.assembled_by := auth.uid(); new.assembled_at := now();
  else
    new.assembled_by := old.assembled_by; new.assembled_at := old.assembled_at;
  end if;
  if not new.tested then
    new.tested_by := null; new.tested_at := null;
  elsif tg_op = 'INSERT' or not old.tested then
    new.tested_by := auth.uid(); new.tested_at := now();
  else
    new.tested_by := old.tested_by; new.tested_at := old.tested_at;
  end if;
  return new;
end $$;
drop trigger if exists order_units_stamp on public.order_units;
create trigger order_units_stamp before insert or update on public.order_units
  for each row execute function public.order_unit_stamp();

-- ---------------------------------------------------------------------
--  Резерв: скільки кожної позиції обіцяно активним замовленням (деталі
--  замовлення мінус уже видане під нього). Вільний залишок = qty − reserved.
--  Представлення працює від імені власника, тож рахує всі відділи, навіть
--  для людини, яка бачить лише свій.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
--  Залишки рахуються, а не зберігаються: сума руху без скасованих операцій
-- ---------------------------------------------------------------------
drop view if exists public.stock;
create view public.stock with (security_invoker = true) as
select i.*,
       coalesce(sum(m.qty) filter (where o.cancelled_at is null), 0)::numeric as qty,
       coalesce(r.reserved, 0)::numeric as reserved
from public.items i
left join public.movements    m on m.item_id = i.id
left join public.operations   o on o.id = m.operation_id
left join public.reserved_qty r on r.item_id = i.id
group by i.id, r.reserved;

-- ---------------------------------------------------------------------
--  Налаштування програми (один рядок) і сповіщення в Telegram.
--  Токен бота читається лише функціями; застосунок бачить його маску.
--  Відправка — через розширення pg_net (є в Supabase); без нього
--  функції мовчки нічого не надсилають, решта програми працює.
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  id               int primary key default 1 check (id = 1),
  org_name         text not null default '',      -- шапка друкованих документів
  app_url          text not null default '',      -- адреса програми для посилань у повідомленнях
  tg_token         text not null default '',      -- токен бота від @BotFather
  tg_chat          text not null default '',      -- головний чат/група
  tg_orders        boolean not null default true, -- нові замовлення, передачі, доопрацювання
  tg_low           boolean not null default true, -- позиція впала нижче мінімуму
  tg_overdue       boolean not null default true, -- щоденний список прострочених
  overdue_sent_on  date,
  backup_at        timestamptz,
  updated_at       timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
-- порядок кнопок категорій у «Залишках» — спільний для всіх (set_category_order);
-- категорії, яких тут немає, застосунок показує в кінці за абеткою
alter table public.app_settings add column if not exists category_order text[] not null default '{}';

-- у відділу може бути свій чат: туди йдуть замовлення, що приходять у цей відділ
alter table public.departments add column if not exists tg_chat text not null default '';

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net недоступне (%): сповіщення Telegram не надсилатимуться', sqlerrm;
end $$;

create or replace function public.tg_esc(p text)
returns text language sql immutable as $$
  select replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

create or replace function public.order_status_label(p text)
returns text language sql immutable as $$
  select case p
    when 'new' then 'Нове' when 'in_work' then 'В роботі' when 'testing' then 'На тестуванні'
    when 'rework' then 'На доопрацюванні' when 'done' then 'Готово' when 'shipped' then 'Відвантажено'
    when 'cancelled' then 'Скасовано' else coalesce(p, '') end
$$;

-- надіслати повідомлення; повертає id запиту pg_net або null, якщо нікуди/нічим
create or replace function public.tg_send(p_chat text, p_text text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  s    public.app_settings%rowtype;
  v_id bigint;
begin
  select * into s from public.app_settings where id = 1;
  if s.tg_token = '' or coalesce(trim(p_chat), '') = '' or coalesce(p_text, '') = '' then
    return null;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return null;
  end if;
  execute format('select net.http_post(url := %L, body := %L::jsonb, headers := %L::jsonb)',
                 'https://api.telegram.org/bot' || s.tg_token || '/sendMessage',
                 jsonb_build_object('chat_id', trim(p_chat), 'text', p_text, 'parse_mode', 'HTML',
                                    'disable_web_page_preview', true)::text,
                 '{"Content-Type":"application/json"}')
    into v_id;
  return v_id;
exception when others then
  raise warning 'tg_send: %', sqlerrm;
  return null;
end $$;

-- у головний чат і, якщо в відділу свій чат — ще й туди
create or replace function public.tg_notify(p_text text, p_department uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_main text;
  v_dep  text;
begin
  select tg_chat into v_main from public.app_settings where id = 1;
  if p_department is not null then
    select tg_chat into v_dep from public.departments where id = p_department;
  end if;
  perform public.tg_send(v_main, p_text);
  if coalesce(v_dep, '') <> '' and v_dep is distinct from v_main then
    perform public.tg_send(v_dep, p_text);
  end if;
end $$;

create or replace function public.order_link(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when app_url <> '' then E'\n' || rtrim(app_url, '/') || '/#/order/' || p_id::text else '' end
    from public.app_settings where id = 1
$$;

-- подія в історії замовлення → повідомлення
create or replace function public.notify_order_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s     public.app_settings%rowtype;
  o     public.orders%rowtype;
  v_who text;
  v_txt text;
  v_dep text;
begin
  select * into s from public.app_settings where id = 1;
  if not s.tg_orders or s.tg_token = '' or new.kind = 'comment' then
    return null;
  end if;
  select * into o from public.orders where id = new.order_id;
  select display_name into v_who from public.profiles where id = new.created_by;
  v_who := coalesce(nullif(v_who, ''), '—');
  select name into v_dep from public.departments where id = new.to_department;
  v_dep := coalesce(v_dep, 'без відділу');

  if new.kind = 'created' then
    v_txt := format(E'🆕 <b>Замовлення №%s</b> «%s»%s\n', o.number, public.tg_esc(o.title),
                    case when o.qty <> 1 then ' × ' || trim_scale(o.qty) else '' end)
          || case when o.customer <> '' then '👤 ' || public.tg_esc(o.customer) || E'\n' else '' end
          || case when o.due_date is not null then '📅 термін ' || to_char(o.due_date, 'DD.MM.YYYY') || E'\n' else '' end
          || format('➡️ %s · прийняв: %s', public.tg_esc(v_dep), public.tg_esc(v_who));
  else
    v_txt := format('%s <b>№%s</b> «%s»: ',
                    case new.to_status when 'rework' then '🔁' when 'testing' then '🧪' when 'done' then '✅'
                                       when 'shipped' then '📦' when 'cancelled' then '❌' when 'in_work' then '🔧' else '➡️' end,
                    o.number, public.tg_esc(o.title))
          || case when new.from_status is distinct from new.to_status
                  then public.order_status_label(new.from_status) || ' → <b>' || public.order_status_label(new.to_status) || '</b>'
                  else 'передано' end
          || case when new.from_department is distinct from new.to_department then E'\n➡️ ' || public.tg_esc(v_dep) else '' end
          || E'\n' || public.tg_esc(v_who)
          || case when new.text <> '' then ': ' || public.tg_esc(new.text) else '' end;
  end if;
  perform public.tg_notify(v_txt || public.order_link(o.id), new.to_department);
  return null;
exception when others then
  raise warning 'notify_order_event: %', sqlerrm;
  return null;
end $$;
drop trigger if exists order_events_notify on public.order_events;
create trigger order_events_notify after insert on public.order_events
  for each row execute function public.notify_order_event();

-- прострочені замовлення — раз на добу (викликає застосунок після входу, і pg_cron, якщо є)
create or replace function public.notify_overdue()
returns int language plpgsql security definer set search_path = public as $$
declare
  s     public.app_settings%rowtype;
  v_txt text := '';
  v_n   int := 0;
  r     record;
begin
  if not public.is_active() then
    raise exception 'Немає доступу';
  end if;
  select * into s from public.app_settings where id = 1 for update;
  if not s.tg_overdue or s.tg_token = '' or s.overdue_sent_on is not distinct from current_date then
    return 0;
  end if;
  for r in
    select o.number, o.title, o.due_date, d.name as dep
      from public.orders o left join public.departments d on d.id = o.department_id
     where o.deleted_at is null and o.status in ('new', 'in_work', 'testing', 'rework', 'done')
       and o.due_date < current_date
     order by o.due_date, o.number
  loop
    v_n := v_n + 1;
    if v_n <= 30 then
      v_txt := v_txt || format(E'\n№%s «%s» — до %s (%s дн.)%s', r.number, public.tg_esc(r.title),
                               to_char(r.due_date, 'DD.MM'), current_date - r.due_date,
                               case when r.dep is not null then ' · ' || public.tg_esc(r.dep) else '' end);
    end if;
  end loop;
  update public.app_settings set overdue_sent_on = current_date where id = 1;
  if v_n = 0 then
    return 0;
  end if;
  perform public.tg_send(s.tg_chat, format('⏰ <b>Прострочені замовлення: %s</b>', v_n) || v_txt
                                    || case when v_n > 30 then E'\n…' else '' end);
  return v_n;
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$ select cron.unschedule(jobid) from cron.job where jobname = 'sklad-overdue' $c$;
    execute $c$ select cron.schedule('sklad-overdue', '0 6 * * *', 'select public.notify_overdue()') $c$;
  end if;
exception when others then
  raise notice 'pg_cron: % — прострочені перевіряє застосунок при вході', sqlerrm;
end $$;

-- налаштування для адміністратора (токен — лише маскою) і їх збереження
create or replace function public.admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.app_settings%rowtype;
begin
  perform public.require('admin');
  select * into s from public.app_settings where id = 1;
  return jsonb_build_object(
    'org_name', s.org_name, 'app_url', s.app_url, 'tg_chat', s.tg_chat,
    'tg_orders', s.tg_orders, 'tg_low', s.tg_low, 'tg_overdue', s.tg_overdue,
    'tg_token_set', s.tg_token <> '',
    'tg_token_hint', case when length(s.tg_token) > 6 then '…' || right(s.tg_token, 4) else '' end,
    'overdue_sent_on', s.overdue_sent_on, 'backup_at', s.backup_at,
    'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'),
    'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'));
end $$;

-- p: лише ті ключі, що треба змінити; "tg_token": "" — прибрати токен
create or replace function public.admin_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require('admin');
  update public.app_settings set
    org_name   = coalesce(trim(p->>'org_name'), org_name),
    app_url    = coalesce(trim(p->>'app_url'), app_url),
    tg_token   = case when p ? 'tg_token' then trim(p->>'tg_token') else tg_token end,
    tg_chat    = coalesce(trim(p->>'tg_chat'), tg_chat),
    tg_orders  = coalesce((p->>'tg_orders')::boolean, tg_orders),
    tg_low     = coalesce((p->>'tg_low')::boolean, tg_low),
    tg_overdue = coalesce((p->>'tg_overdue')::boolean, tg_overdue),
    backup_at  = coalesce((p->>'backup_at')::timestamptz, backup_at)
  where id = 1;
end $$;

-- тестове повідомлення в головний чат: повертає id запиту (null — нема токена/чату/pg_net)
create or replace function public.tg_test()
returns bigint language plpgsql security definer set search_path = public as $$
declare v_chat text;
begin
  perform public.require('admin');
  select tg_chat into v_chat from public.app_settings where id = 1;
  return public.tg_send(v_chat, '✅ Склад: сповіщення Telegram працюють');
end $$;

-- результат запиту pg_net (відповідь Telegram), коли вже є
create or replace function public.tg_result(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  perform public.require('admin');
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'pg_net не ввімкнено';
  end if;
  execute 'select coalesce(status_code::text, '''') || '' '' || coalesce(content, error_msg, '''') from net._http_response where id = $1'
    into v using p_id;
  return v;
end $$;

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
--  p_op_id — id, який придумав клієнт (офлайн-черга): повторна відправка
--            тієї самої операції не створює дубля, а повертає наявну.
--  Списання нижче нуля — помилка з назвою позиції.
-- ---------------------------------------------------------------------
-- старі версії з іншою кількістю аргументів: інакше лишилося б кілька функцій з одним імʼям
drop function if exists public.post_operation(text, jsonb, text, text, uuid, numeric);
drop function if exists public.post_operation(text, jsonb, text, text, uuid, numeric, uuid);

create or replace function public.post_operation(
  p_type          text,
  p_lines         jsonb,
  p_comment       text default '',
  p_counterparty  text default '',
  p_kit_id        uuid default null,
  p_kit_qty       numeric default null,
  p_order_id      uuid default null,
  p_op_id         uuid default null
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
  v_min   numeric;
  v_unit  text;
  v_n     int := 0;
  v_low   text := '';
  v_set   public.app_settings%rowtype;
begin
  perform public.require('ops.edit');
  if p_type not in ('in', 'out', 'adjust', 'kit_out') then
    raise exception 'Невідомий тип операції: %', p_type;
  end if;
  if p_op_id is not null then
    select id into v_op from public.operations where id = p_op_id;
    if v_op is not null then
      return v_op;   -- уже проведено (повтор з офлайн-черги)
    end if;
  end if;
  if p_order_id is not null and not exists (select 1 from public.orders
                                              where id = p_order_id and deleted_at is null and public.can_see_order(department_id)) then
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

  insert into public.operations (id, type, comment, counterparty, kit_id, kit_qty, order_id)
  values (coalesce(p_op_id, gen_random_uuid()), p_type, coalesce(p_comment, ''), coalesce(p_counterparty, ''),
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
    select name, deleted_at, min_qty, unit into v_name, v_del, v_min, v_unit from public.items where id = r.item_id;
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
    -- саме цією операцією позиція опустилася нижче мінімуму
    if v_delta < 0 and v_min > 0 and v_have >= v_min and v_have + v_delta < v_min then
      v_low := v_low || format(E'\n«%s» — є %s з мін. %s %s', public.tg_esc(v_name),
                               trim_scale(v_have + v_delta), trim_scale(v_min), public.tg_esc(v_unit));
    end if;
  end loop;

  -- інвентаризація без розбіжностей теж фіксується (як факт перерахунку),
  -- а порожній прихід/видаток — ні
  if v_n = 0 and p_type <> 'adjust' then
    raise exception 'Немає що проводити';
  end if;

  if v_low <> '' then
    select * into v_set from public.app_settings where id = 1;
    if v_set.tg_low then
      perform public.tg_send(v_set.tg_chat, '⚠️ <b>Мало на складі</b>' || v_low);
    end if;
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
  perform public.require('ops.delete');

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
  perform public.require('ops.delete');
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
  perform public.require('ops.delete');
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
  perform public.require('stock.delete');
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
  perform public.require('stock.delete');
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
  perform public.require('stock.delete');
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

-- ---------------------------------------------------------------------
--  Порядок позицій і категорій у «Залишках» (один виклик на весь новий порядок)
-- ---------------------------------------------------------------------
-- p_ids — позиції в новому порядку. Вони переставляються між собою в межах тих
-- місць, які займали; решта (архів, кошик, приховані фільтром, щойно додані
-- кимось іншим) лишається де була. Заодно місця перенумеровуються 1..N.
create or replace function public.set_item_order(p_ids uuid[])
returns void
language plpgsql
set search_path = public
as $$
begin
  perform public.require('stock.edit');
  if (select count(*) <> count(distinct x) from unnest(p_ids) x) then
    raise exception 'Позиція в порядку повторюється';
  end if;
  -- двоє впорядковують одночасно — по черзі, а не впереміш
  lock table public.items in share row exclusive mode;
  with cur as (
         select id, row_number() over (order by sort_order, name, id) as rn from public.items),
       want as (
         select c.id, row_number() over (order by u.ord) as k
           from unnest(p_ids) with ordinality u(id, ord)
           join cur c on c.id = u.id),
       slot as (
         select c.rn, row_number() over (order by c.rn) as k
           from cur c join want w on w.id = c.id),
       fin as (
         select c.id, coalesce(s.rn, c.rn)::integer as n
           from cur c
           left join want w on w.id = c.id
           left join slot s on s.k = w.k)
  update public.items i set sort_order = f.n
    from fin f
   where i.id = f.id and i.sort_order <> f.n;
end $$;

-- p_names — усі кнопки категорій у новому порядку (порожні й повтори відкидаються)
create or replace function public.set_category_order(p_names text[])
returns void
language plpgsql
set search_path = public
as $$
begin
  perform public.require('stock.edit');
  update public.app_settings
     set category_order = coalesce((
           select array_agg(q.n order by q.ord)
             from (select distinct on (trim(u.x)) trim(u.x) as n, u.ord
                     from unnest(p_names) with ordinality u(x, ord)
                    where trim(u.x) <> ''
                    order by trim(u.x), u.ord) q), '{}')
   where id = 1;
end $$;

-- оновлення updated_at у позиціях (перестановка в списку — не зміна позиції)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row when (old.sort_order = new.sort_order) execute function public.touch_updated_at();
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();
drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch before update on public.app_settings
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
  perform public.require('orders.edit');
  if p_status not in ('new', 'in_work', 'testing', 'rework', 'done', 'shipped', 'cancelled') then
    raise exception 'Невідомий статус: %', p_status;
  end if;
  select * into v from public.orders where id = p_id and deleted_at is null for update;
  if not found or not public.can_see_order(v.department_id) then
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
  perform public.require('orders.delete');
  update public.orders set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id and deleted_at is null and public.can_see_order(department_id);
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
  perform public.require('orders.delete');
  update public.orders set deleted_at = null, deleted_by = null
   where id = p_id and deleted_at is not null and public.can_see_order(department_id);
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
  perform public.require('orders.delete');
  delete from public.orders where id = p_id and deleted_at is not null and public.can_see_order(department_id);
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
  if not public.is_active() then
    raise exception 'Немає доступу';
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
--  Ролі та права
--    розділи: stock  — позиції й залишки
--             ops    — прихід / видаток, журнал, інвентаризація
--             kits   — комплекти
--             orders — замовлення
--    дії:     .view (перегляд) .edit (зміна) .delete (видалення, кошик)
--    orders.all — замовлення всіх відділів (без нього — лише свого відділу)
--    admin      — користувачі, ролі, відділи і всі інші права
--  Права людини = власні галочки (profiles.perms), а якщо їх нема — права ролі.
-- ---------------------------------------------------------------------
create or replace function public.all_perms()
returns text[] language sql immutable as $$
  select array['stock.view', 'stock.edit', 'stock.delete',
               'ops.view', 'ops.edit', 'ops.delete',
               'kits.view', 'kits.edit', 'kits.delete',
               'orders.view', 'orders.edit', 'orders.delete', 'orders.all',
               'admin']
$$;

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  perms       text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create unique index if not exists roles_name_uq on public.roles (lower(name));
alter table public.roles drop constraint if exists roles_perms_chk;
alter table public.roles add constraint roles_perms_chk check (perms <@ public.all_perms());

-- стартові ролі — лише в порожню таблицю, щоб змінені адміністратором не поверталися
insert into public.roles (name, perms)
select v.name, v.perms from (values
  ('Адміністратор', array['admin']),
  ('Комірник',      array['stock.view', 'stock.edit', 'stock.delete', 'ops.view', 'ops.edit', 'ops.delete',
                          'kits.view', 'kits.edit', 'kits.delete', 'orders.view', 'orders.all']),
  ('Виробництво',   array['stock.view', 'ops.view', 'ops.edit', 'kits.view', 'orders.view', 'orders.edit']),
  ('Лише перегляд', array['stock.view', 'ops.view', 'kits.view', 'orders.view', 'orders.all'])
) as v(name, perms)
where not exists (select 1 from public.roles);

alter table public.profiles
  add column if not exists role_id uuid references public.roles(id) on delete set null,
  add column if not exists perms   text[],                          -- null = як у ролі
  add column if not exists active  boolean not null default true;  -- false = заблокований
alter table public.profiles drop constraint if exists profiles_perms_chk;
alter table public.profiles add constraint profiles_perms_chk check (perms is null or perms <@ public.all_perms());

-- перший запуск: до появи ролей усі були рівні — тож усі наявні стають адміністраторами
update public.profiles
   set role_id = (select id from public.roles where name = 'Адміністратор')
 where role_id is null and perms is null
   and not exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                    where 'admin' = any(coalesce(p.perms, r.perms)));

-- права поточного користувача (заблокований — без прав)
create or replace function public.my_perms()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when p.active then coalesce(p.perms, r.perms, '{}') else '{}' end
      from public.profiles p left join public.roles r on r.id = p.role_id
     where p.id = auth.uid()), '{}')
$$;

create or replace function public.has_perm(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_perm = any(x) or 'admin' = any(x) from (select public.my_perms() as x) s
$$;

create or replace function public.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.my_department()
returns uuid language sql stable security definer set search_path = public as $$
  select department_id from public.profiles where id = auth.uid()
$$;

-- чи бачить людина замовлення, що лежить у відділі p_dep
create or replace function public.can_see_order(p_dep uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_perm('orders.view')
     and (public.has_perm('orders.all') or p_dep is not distinct from public.my_department())
$$;

create or replace function public.can_see_order_id(p_order uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.can_see_order(department_id) from public.orders where id = p_order), false)
$$;

create or replace function public.perm_label(p_perm text)
returns text language sql immutable as $$
  select case p_perm
    when 'stock.view'    then 'переглядати склад'
    when 'stock.edit'    then 'змінювати позиції складу'
    when 'stock.delete'  then 'видаляти позиції складу'
    when 'ops.view'      then 'переглядати журнал'
    when 'ops.edit'      then 'проводити прихід і видаток'
    when 'ops.delete'    then 'видаляти операції'
    when 'kits.view'     then 'переглядати комплекти'
    when 'kits.edit'     then 'змінювати комплекти'
    when 'kits.delete'   then 'видаляти комплекти'
    when 'orders.view'   then 'переглядати замовлення'
    when 'orders.edit'   then 'змінювати замовлення'
    when 'orders.delete' then 'видаляти замовлення'
    when 'orders.all'    then 'бачити замовлення всіх відділів'
    when 'admin'         then 'адміністрування'
    else p_perm end
$$;

-- перевірка на початку кожної функції, що щось змінює
create or replace function public.require(p_perm text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if not public.has_perm(p_perm) then
    raise exception 'Немає права %', public.perm_label(p_perm);
  end if;
end $$;

-- хоч один активний адміністратор має лишитися завжди
create or replace function public.assert_admin_left()
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.profiles) and not exists (
       select 1 from public.profiles p left join public.roles r on r.id = p.role_id
        where p.active and 'admin' = any(coalesce(p.perms, r.perms, '{}'))) then
    raise exception 'Має лишитися хоча б один активний адміністратор';
  end if;
end $$;

create or replace function public.roles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_admin_left();
  return null;
end $$;
drop trigger if exists roles_guard on public.roles;
create trigger roles_guard after update or delete on public.roles
  for each statement execute function public.roles_guard();

-- ---------------------------------------------------------------------
--  Керування користувачами — лише адміністратор
-- ---------------------------------------------------------------------
create or replace function public.admin_users()
returns table (id uuid, email text, display_name text, role_id uuid, department_id uuid,
               perms text[], active boolean, last_sign_in_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require('admin');
  return query
    select p.id, u.email::text, p.display_name, p.role_id, p.department_id, p.perms, p.active,
           u.last_sign_in_at, u.created_at
      from public.profiles p join auth.users u on u.id = p.id
     order by lower(p.display_name);
end $$;

create or replace function public.admin_create_user(
  p_email text, p_password text, p_name text default '', p_role uuid default null, p_department uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v       uuid := gen_random_uuid();
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform public.require('admin');
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Неправильний email';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Пароль — мінімум 6 символів';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Користувач з таким email уже є';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v, v::text,
          jsonb_build_object('sub', v::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());
  -- профіль створив тригер; доводимо до потрібного вигляду
  update public.profiles
     set display_name  = coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
         role_id       = p_role,
         department_id = p_department
   where id = v;
  return v;
end $$;

create or replace function public.admin_update_user(
  p_user uuid, p_name text, p_role uuid, p_department uuid, p_perms text[], p_active boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require('admin');
  if p_user = auth.uid() and not p_active then
    raise exception 'Не можна заблокувати самого себе';
  end if;
  if p_perms is not null and not (p_perms <@ public.all_perms()) then
    raise exception 'Невідоме право';
  end if;
  update public.profiles
     set display_name  = coalesce(nullif(trim(p_name), ''), display_name),
         role_id       = p_role,
         department_id = p_department,
         perms         = p_perms,
         active        = p_active
   where id = p_user;
  if not found then
    raise exception 'Користувача не знайдено';
  end if;
  if p_user = auth.uid() and not public.has_perm('admin') then
    raise exception 'Не можна забрати права адміністратора в самого себе';
  end if;
  perform public.assert_admin_left();
  -- заблокований не зможе й увійти
  update auth.users set banned_until = case when p_active then null else 'infinity'::timestamptz end
   where id = p_user;
end $$;

create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require('admin');
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Пароль — мінімум 6 символів';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user;
  if not found then
    raise exception 'Користувача не знайдено';
  end if;
end $$;

-- журнал і замовлення лишаються: у них автор просто стає «—»
create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require('admin');
  if p_user = auth.uid() then
    raise exception 'Не можна видалити самого себе';
  end if;
  delete from auth.users where id = p_user;
  if not found then
    raise exception 'Користувача не знайдено';
  end if;
  perform public.assert_admin_left();
end $$;

-- свій відділ людина обирає сама лише коли бачить усі відділи; інакше його призначає адміністратор
create or replace function public.set_my_department(p_dep uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Потрібно увійти';
  end if;
  if not public.has_perm('orders.all') then
    raise exception 'Відділ вам призначає адміністратор';
  end if;
  update public.profiles set department_id = p_dep where id = auth.uid();
end $$;

-- ---------------------------------------------------------------------
--  Доступ за правами (has_perm). Анонім і заблокований не бачать нічого.
--  Читати довідники (позиції, залишки, журнал) може кожен активний — назви
--  потрібні всюди; розділи без права перегляду застосунок просто не показує.
--  Замовлення — лише свого відділу, якщо немає orders.all.
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

alter table public.roles enable row level security;

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
drop policy if exists profiles_upd   on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using ((select public.is_active()));
create policy profiles_upd  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists roles_read  on public.roles;
drop policy if exists roles_admin on public.roles;
create policy roles_read  on public.roles for select to authenticated using ((select public.is_active()));
create policy roles_admin on public.roles for all to authenticated
  using ((select public.has_perm('admin'))) with check ((select public.has_perm('admin')));

drop policy if exists items_all    on public.items;
drop policy if exists items_read   on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
drop policy if exists items_delete on public.items;
create policy items_read   on public.items for select to authenticated using ((select public.is_active()));
create policy items_insert on public.items for insert to authenticated with check ((select public.has_perm('stock.edit')));
create policy items_update on public.items for update to authenticated
  using ((select public.has_perm('stock.edit'))) with check ((select public.has_perm('stock.edit')));
create policy items_delete on public.items for delete to authenticated using ((select public.has_perm('stock.delete')));

drop policy if exists kits_all    on public.kits;
drop policy if exists kits_read   on public.kits;
drop policy if exists kits_insert on public.kits;
drop policy if exists kits_update on public.kits;
drop policy if exists kits_delete on public.kits;
create policy kits_read   on public.kits for select to authenticated using ((select public.is_active()));
create policy kits_insert on public.kits for insert to authenticated with check ((select public.has_perm('kits.edit')));
create policy kits_update on public.kits for update to authenticated
  using ((select public.has_perm('kits.edit'))) with check ((select public.has_perm('kits.edit')));
create policy kits_delete on public.kits for delete to authenticated using ((select public.has_perm('kits.delete')));

drop policy if exists kit_components_all   on public.kit_components;
drop policy if exists kit_components_read  on public.kit_components;
drop policy if exists kit_components_write on public.kit_components;
create policy kit_components_read  on public.kit_components for select to authenticated using ((select public.is_active()));
create policy kit_components_write on public.kit_components for all to authenticated
  using ((select public.has_perm('kits.edit'))) with check ((select public.has_perm('kits.edit')));

drop policy if exists operations_read   on public.operations;
drop policy if exists operations_insert on public.operations;
drop policy if exists operations_update on public.operations;
create policy operations_read on public.operations for select to authenticated using ((select public.is_active()));

drop policy if exists movements_read   on public.movements;
drop policy if exists movements_insert on public.movements;
create policy movements_read on public.movements for select to authenticated using ((select public.is_active()));

drop policy if exists departments_all   on public.departments;
drop policy if exists departments_read  on public.departments;
drop policy if exists departments_admin on public.departments;
create policy departments_read  on public.departments for select to authenticated using ((select public.is_active()));
create policy departments_admin on public.departments for all to authenticated
  using ((select public.has_perm('admin'))) with check ((select public.has_perm('admin')));

drop policy if exists orders_read   on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
create policy orders_read on public.orders for select to authenticated
  using ((select public.has_perm('orders.view'))
         and ((select public.has_perm('orders.all')) or department_id is not distinct from (select public.my_department())));
create policy orders_insert on public.orders for insert to authenticated
  with check (created_by = auth.uid() and (select public.has_perm('orders.edit'))
              and ((select public.has_perm('orders.all')) or department_id is not distinct from (select public.my_department())));
create policy orders_update on public.orders for update to authenticated
  using ((select public.has_perm('orders.edit'))
         and ((select public.has_perm('orders.all')) or department_id is not distinct from (select public.my_department())))
  with check ((select public.has_perm('orders.edit')));

drop policy if exists order_tasks_all   on public.order_tasks;
drop policy if exists order_tasks_read  on public.order_tasks;
drop policy if exists order_tasks_write on public.order_tasks;
create policy order_tasks_read  on public.order_tasks for select to authenticated using (public.can_see_order_id(order_id));
create policy order_tasks_write on public.order_tasks for all to authenticated
  using ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id))
  with check ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id));

drop policy if exists order_parts_all   on public.order_parts;
drop policy if exists order_parts_read  on public.order_parts;
drop policy if exists order_parts_write on public.order_parts;
create policy order_parts_read  on public.order_parts for select to authenticated using (public.can_see_order_id(order_id));
create policy order_parts_write on public.order_parts for all to authenticated
  using ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id))
  with check ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id));

-- вироби (серійні номери) — як чекліст: бачить, хто бачить замовлення; змінює — хто має orders.edit
alter table public.order_units enable row level security;
drop policy if exists order_units_read  on public.order_units;
drop policy if exists order_units_write on public.order_units;
create policy order_units_read  on public.order_units for select to authenticated using (public.can_see_order_id(order_id));
create policy order_units_write on public.order_units for all to authenticated
  using ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id))
  with check ((select public.has_perm('orders.edit')) and public.can_see_order_id(order_id));

-- налаштування: несекретні поля читає кожен активний (шапка документів), змінює — лише адміністратор через функції
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using ((select public.is_active()));

-- історію напряму можна лише доповнити власним коментарем; передачі пише move_order
drop policy if exists order_events_read    on public.order_events;
drop policy if exists order_events_comment on public.order_events;
create policy order_events_read    on public.order_events for select to authenticated using (public.can_see_order_id(order_id));
create policy order_events_comment on public.order_events for insert to authenticated
  with check (kind = 'comment' and created_by = auth.uid() and length(trim(text)) > 0
              and (select public.has_perm('orders.edit')) and public.can_see_order_id(order_id));

-- явні дозволи: не залежимо від галочки «Grant API access to new tables automatically»
grant usage on schema public to authenticated;
revoke insert, update on public.items, public.profiles from authenticated;
grant select, delete on public.items to authenticated;
grant insert (id, name, code, category, unit, location, min_qty, note, photo_path, archived) on public.items to authenticated;
grant update (name, code, category, unit, location, min_qty, note, photo_path, archived) on public.items to authenticated;
grant select, insert, update, delete on public.kits, public.kit_components to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
revoke all on public.roles from anon;
grant select, insert, update, delete on public.roles to authenticated;
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

-- вироби: відмітки «хто/коли» ставить тригер, напряму їх не записати
revoke all on public.order_units from anon;
revoke insert, update on public.order_units from authenticated;
grant select, delete on public.order_units to authenticated;
grant insert (id, order_id, position, serial, assembled, tested, note) on public.order_units to authenticated;
grant update (position, serial, assembled, tested, note) on public.order_units to authenticated;

-- резерв і налаштування: токен бота з таблиці не читається — лише маска з admin_settings()
revoke all on public.reserved_qty, public.app_settings from anon, authenticated;
grant select on public.reserved_qty to authenticated;
grant select (id, org_name, app_url, backup_at, updated_at, category_order) on public.app_settings to authenticated;

-- функції працюють від імені власника схеми (обходять revoke вище),
-- але самі перевіряють auth.uid()
alter function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid, uuid) security definer;
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
alter function public.set_item_order(uuid[]) security definer;
alter function public.set_category_order(text[]) security definer;
revoke execute on function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid, uuid) from public, anon;
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
revoke execute on function public.set_item_order(uuid[]) from public, anon;
revoke execute on function public.set_category_order(text[]) from public, anon;
grant  execute on function public.post_operation(text, jsonb, text, text, uuid, numeric, uuid, uuid) to authenticated;
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
grant  execute on function public.set_item_order(uuid[]) to authenticated;
grant  execute on function public.set_category_order(text[]) to authenticated;
revoke execute on function public.my_perms() from public, anon;
revoke execute on function public.has_perm(text) from public, anon;
revoke execute on function public.is_active() from public, anon;
revoke execute on function public.my_department() from public, anon;
revoke execute on function public.can_see_order(uuid) from public, anon;
revoke execute on function public.can_see_order_id(uuid) from public, anon;
revoke execute on function public.require(text) from public, anon;
revoke execute on function public.admin_users() from public, anon;
revoke execute on function public.admin_create_user(text, text, text, uuid, uuid) from public, anon;
revoke execute on function public.admin_update_user(uuid, text, uuid, uuid, text[], boolean) from public, anon;
revoke execute on function public.admin_set_password(uuid, text) from public, anon;
revoke execute on function public.admin_delete_user(uuid) from public, anon;
revoke execute on function public.set_my_department(uuid) from public, anon;
grant  execute on function public.my_perms() to authenticated;
grant  execute on function public.has_perm(text) to authenticated;
grant  execute on function public.is_active() to authenticated;
grant  execute on function public.my_department() to authenticated;
grant  execute on function public.can_see_order(uuid) to authenticated;
grant  execute on function public.can_see_order_id(uuid) to authenticated;
grant  execute on function public.require(text) to authenticated;
grant  execute on function public.admin_users() to authenticated;
grant  execute on function public.admin_create_user(text, text, text, uuid, uuid) to authenticated;
grant  execute on function public.admin_update_user(uuid, text, uuid, uuid, text[], boolean) to authenticated;
grant  execute on function public.admin_set_password(uuid, text) to authenticated;
grant  execute on function public.admin_delete_user(uuid) to authenticated;
grant  execute on function public.set_my_department(uuid) to authenticated;
revoke execute on function public.assert_admin_left() from public, anon, authenticated;

-- сповіщення й налаштування: відправляти вміють лише функції (security definer), з застосунку — лише тест/прострочені
revoke execute on function public.tg_send(text, text) from public, anon, authenticated;
revoke execute on function public.tg_notify(text, uuid) from public, anon, authenticated;
revoke execute on function public.order_link(uuid) from public, anon, authenticated;
revoke execute on function public.notify_overdue() from public, anon;
revoke execute on function public.admin_settings() from public, anon;
revoke execute on function public.admin_save_settings(jsonb) from public, anon;
revoke execute on function public.tg_test() from public, anon;
revoke execute on function public.tg_result(bigint) from public, anon;
grant  execute on function public.notify_overdue() to authenticated;
grant  execute on function public.admin_settings() to authenticated;
grant  execute on function public.admin_save_settings(jsonb) to authenticated;
grant  execute on function public.tg_test() to authenticated;
grant  execute on function public.tg_result(bigint) to authenticated;

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
--  Резервні копії: приватне сховище «backups», доступ лише адміністратору.
--  Копію (JSON усіх таблиць + Excel) робить застосунок, коли адміністратор
--  входить і останній копії більше доби; старші 30 днів він же прибирає.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

drop policy if exists backups_read   on storage.objects;
drop policy if exists backups_insert on storage.objects;
drop policy if exists backups_update on storage.objects;
drop policy if exists backups_delete on storage.objects;
create policy backups_read   on storage.objects for select to authenticated
  using (bucket_id = 'backups' and (select public.has_perm('admin')));
create policy backups_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and (select public.has_perm('admin')));
create policy backups_update on storage.objects for update to authenticated
  using (bucket_id = 'backups' and (select public.has_perm('admin')));
create policy backups_delete on storage.objects for delete to authenticated
  using (bucket_id = 'backups' and (select public.has_perm('admin')));

-- повний знімок даних для резервної копії — лише адміністратору (без токена бота)
create or replace function public.admin_dump()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require('admin');
  return jsonb_build_object(
    'items',          (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.items t),
    'kits',           (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.kits t),
    'kit_components', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.kit_components t),
    'operations',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.operations t),
    'movements',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.movements t),
    'departments',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.departments t),
    'orders',         (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.orders t),
    'order_tasks',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.order_tasks t),
    'order_parts',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.order_parts t),
    'order_events',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.order_events t),
    'order_units',    (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.order_units t),
    'roles',          (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.roles t),
    'profiles',       (select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('email', u.email)), '[]')
                         from public.profiles t join auth.users u on u.id = t.id),
    'settings',       (select to_jsonb(t) - 'tg_token' from public.app_settings t where id = 1));
end $$;
revoke execute on function public.admin_dump() from public, anon;
grant  execute on function public.admin_dump() to authenticated;

-- ---------------------------------------------------------------------
--  Живе оновлення: зміни з телефону одразу з'являються на ПК
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['items', 'kits', 'kit_components', 'operations', 'movements',
                             'departments', 'orders', 'order_tasks', 'order_parts', 'order_events', 'profiles', 'roles',
                             'order_units', 'app_settings'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
