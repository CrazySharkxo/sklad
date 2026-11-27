-- Сценарії перевірки бізнес-логіки. Кожна перевірка падає з exception, якщо щось не так.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ivan@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'olena@example.com');

-- тригер створив профілі
do $$ begin
  assert (select count(*) from public.profiles) = 2, 'профілі не створено';
  assert (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'ivan';
  -- перший користувач стає адміністратором, наступні — «Лише перегляд»
  assert (select r.name from public.profiles p join public.roles r on r.id = p.role_id
           where p.id = '11111111-1111-1111-1111-111111111111') = 'Адміністратор';
  assert (select r.name from public.profiles p join public.roles r on r.id = p.role_id
           where p.id = '22222222-2222-2222-2222-222222222222') = 'Лише перегляд';
  -- перший акаунт — головний адміністратор, і він один
  assert (select array_agg(id) from public.profiles where is_owner) = array['11111111-1111-1111-1111-111111111111'::uuid], 'головний';
  -- ролі: чотири стартові + дві нові, з точним набором прав; повторний запуск schema.sql їх не подвоїв
  assert (select count(*) from public.roles) = 6, 'ролей має бути 6';
  assert (select perms from public.roles where name = 'Звичайний користувач')
       = array['stock.view', 'ops.view', 'kits.view', 'orders.view'], 'Звичайний користувач';
  assert (select perms from public.roles where name = 'Старший користувач')
       = array['stock.view', 'stock.edit', 'ops.view', 'ops.edit', 'kits.view', 'kits.edit',
               'orders.view', 'orders.edit', 'orders.all'], 'Старший користувач';
  assert (select perms from public.roles where name = 'Адміністратор') = array['admin'];
  assert (select perms from public.roles where name = 'Лише перегляд') = array['stock.view', 'ops.view', 'kits.view', 'orders.view', 'orders.all'];
  assert (select roles_seed from public.app_settings) = 1;
end $$;
-- для перевірок складу обидва — адміністратори (обмежені права — окремо, в кінці)
update public.profiles set role_id = (select id from public.roles where name = 'Адміністратор');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

insert into public.items (id, name, code, category, unit, min_qty) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Мотор 2207', '4820000000017', 'Мотори', 'шт', 8),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Польотник F7', null, 'Електроніка', 'шт', 2),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Дріт 14AWG', null, 'Кабелі', 'м', 5);

-- унікальність коду без урахування регістру
do $$ begin
  begin
    insert into public.items (name, code) values ('дубль', '4820000000017');
    raise exception 'дубль коду пройшов';
  exception when unique_violation then null;
  end;
end $$;

-- прихід
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":10},
                                      {"item_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":3},
                                      {"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":12.5},
                                      {"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2}]', 'перша поставка', 'Постачальник А');
do $$ begin
  assert (select qty from public.stock where name = 'Мотор 2207') = 12, 'дубль рядків не зведено';
  assert (select qty from public.stock where name = 'Дріт 14AWG') = 12.5, 'дробова кількість';
  assert (select created_by from public.operations limit 1) = '11111111-1111-1111-1111-111111111111', 'автор операції';
end $$;

-- видаток понад залишок — помилка з назвою
do $$ begin
  begin
    perform public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":5}]');
    raise exception 'мінус пройшов';
  exception when raise_exception then
    assert sqlerrm like 'Недостатньо «Польотник F7»: є 3, потрібно 5', sqlerrm;
  end;
end $$;

-- нічого не записалося від невдалої операції
do $$ begin assert (select count(*) from public.operations) = 1, 'невдала операція лишила слід'; end $$;

-- видаток іншим користувачем
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":2.5}]', '', 'Збірка #1');
do $$ begin assert (select qty from public.stock where name = 'Дріт 14AWG') = 10; end $$;

-- комплект: 4 мотори + 1 FC + 0.5 м дроту
insert into public.kits (id, name) values ('bbbbbbbb-0000-0000-0000-000000000001', 'Дрон 7"');
insert into public.kit_components values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 4),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 1),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 0.5);

select public.post_operation('kit_out', null, 'видача', 'Екіпаж 3', 'bbbbbbbb-0000-0000-0000-000000000001', 2);
do $$ begin
  assert (select qty from public.stock where name = 'Мотор 2207') = 4;
  assert (select qty from public.stock where name = 'Польотник F7') = 1;
  assert (select qty from public.stock where name = 'Дріт 14AWG') = 9;
end $$;

-- ще 2 комплекти — моторів не вистачає (4 < 8)
do $$ begin
  begin
    perform public.post_operation('kit_out', null, '', '', 'bbbbbbbb-0000-0000-0000-000000000001', 2);
    raise exception 'комплект у мінус пройшов';
  exception when raise_exception then
    assert sqlerrm like 'Недостатньо%', sqlerrm;
  end;
end $$;

-- інвентаризація: моторів фактично 5, дроту 9 (без змін)
select public.post_operation('adjust', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":5},
                                          {"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":9}]', 'інвентаризація');
do $$ begin
  assert (select qty from public.stock where name = 'Мотор 2207') = 5;
  assert (select count(*) from public.movements m join public.operations o on o.id = m.operation_id where o.type = 'adjust') = 1,
         'нульова різниця не має давати рядок';
end $$;

-- скасування першого приходу заборонене (з нього вже видали)
do $$ begin
  begin
    perform public.cancel_operation((select id from public.operations where type = 'in'));
    raise exception 'скасування в мінус пройшло';
  exception when raise_exception then
    assert sqlerrm like 'Не можна видалити%', sqlerrm;
  end;
end $$;

-- скасування видачі комплекту — компоненти повертаються
select public.cancel_operation((select id from public.operations where type = 'kit_out'));
do $$ begin
  assert (select qty from public.stock where name = 'Мотор 2207') = 13;
  assert (select qty from public.stock where name = 'Польотник F7') = 3;
  assert (select cancelled_by from public.operations where type = 'kit_out') = '22222222-2222-2222-2222-222222222222';
end $$;

-- повторне скасування — помилка
do $$ begin
  begin
    perform public.cancel_operation((select id from public.operations where type = 'kit_out'));
    raise exception 'повторне скасування пройшло';
  exception when raise_exception then null;
  end;
end $$;

-- прямий запис в операції заборонено
do $$ begin
  begin
    insert into public.operations (type) values ('in');
    raise exception 'прямий insert пройшов';
  exception when insufficient_privilege then null;
  end;
end $$;

-- позицію з рухом видалити не можна (лише архів)
do $$ begin
  begin
    delete from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'видалення позиції з історією пройшло';
  exception when foreign_key_violation then null;
  end;
end $$;

-- =====================================================================
--  Замовлення
-- =====================================================================
do $$ begin
  assert (select count(*) from public.departments) = 3, 'стартові відділи';
end $$;

-- свій відділ у профілі
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.set_my_department((select id from public.departments where name = 'Прийом замовлень'));

insert into public.orders (id, title, customer, qty, description, department_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'Дрон 7"', 'Екіпаж 5', 2, 'Камера денна, антена 5.8',
   (select id from public.departments where name = 'Прийом замовлень'));
do $$ begin
  assert (select number from public.orders) = 1, 'номер замовлення';
  assert (select status from public.orders) = 'new';
  assert (select created_by from public.orders) = '11111111-1111-1111-1111-111111111111', 'хто прийняв';
  assert (select count(*) from public.order_events where kind = 'created') = 1, 'подія прийому не записалась';
end $$;

-- статус і відділ напряму не змінити — лише через move_order
do $$ begin
  begin
    update public.orders set status = 'done';
    raise exception 'прямий update статусу пройшов';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.orders (title, status) values ('обхід', 'done');
    raise exception 'insert зі статусом пройшов';
  exception when insufficient_privilege then null;
  end;
end $$;
update public.orders set description = 'Камера нічна' where number = 1;  -- опис — можна

-- чекліст: хто відмітив, ставить сервер
insert into public.order_tasks (order_id, position, text) values
  ('cccccccc-0000-0000-0000-000000000001', 0, 'Зібрати раму'),
  ('cccccccc-0000-0000-0000-000000000001', 1, 'Прошити польотник');
update public.order_tasks set done = true, done_by = '22222222-2222-2222-2222-222222222222' where text = 'Зібрати раму';
do $$ begin
  assert (select done_by from public.order_tasks where text = 'Зібрати раму') = '11111111-1111-1111-1111-111111111111', 'done_by підмінено';
  assert (select done_at from public.order_tasks where text = 'Зібрати раму') is not null;
end $$;
update public.order_tasks set done = false where text = 'Зібрати раму';
do $$ begin assert (select done_by from public.order_tasks where text = 'Зібрати раму') is null; end $$;

-- видача деталей під замовлення
insert into public.order_parts values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 8);
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":8}]', '', 'Замовлення №1',
                             null, null, 'cccccccc-0000-0000-0000-000000000001');
do $$ begin
  assert (select count(*) from public.operations where order_id = 'cccccccc-0000-0000-0000-000000000001') = 1, 'операція не привʼязана';
  assert (select qty from public.stock where name = 'Мотор 2207') = 5;
  begin
    perform public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1}]', '', '',
                                  null, null, 'cccccccc-0000-0000-0000-00000000dead');
    raise exception 'неіснуюче замовлення пройшло';
  exception when raise_exception then
    assert sqlerrm like 'Замовлення не знайдено%', sqlerrm;
  end;
end $$;

-- передача: у роботу → на тестування (інший відділ) → на доопрацювання
select public.move_order('cccccccc-0000-0000-0000-000000000001', 'in_work');
select public.move_order('cccccccc-0000-0000-0000-000000000001', 'testing',
                         (select id from public.departments where name = 'Тестування'), 'перевірити відео');
do $$ begin
  assert (select status from public.orders where number = 1) = 'testing';
  assert (select d.name from public.orders o join public.departments d on d.id = o.department_id) = 'Тестування';
  assert (select count(*) from public.order_events where kind = 'move') = 2;
  assert (select from_status || '>' || to_status from public.order_events where kind = 'move' order by id desc limit 1) = 'in_work>testing';
  begin
    perform public.move_order('cccccccc-0000-0000-0000-000000000001', 'rework', null, '  ');
    raise exception 'доопрацювання без коментаря пройшло';
  exception when raise_exception then
    assert sqlerrm like 'Напишіть у коментарі, що треба%', sqlerrm;
  end;
  begin
    perform public.move_order('cccccccc-0000-0000-0000-000000000001', 'testing');
    raise exception 'порожня передача пройшла';
  exception when raise_exception then
    assert sqlerrm = 'Нічого не змінилося', sqlerrm;
  end;
end $$;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.move_order('cccccccc-0000-0000-0000-000000000001', 'rework',
                         (select id from public.departments where name = 'Прийом замовлень'), 'немає відео з камери');
do $$ begin
  assert (select created_by from public.order_events order by id desc limit 1) = '22222222-2222-2222-2222-222222222222';
  assert (select text from public.order_events order by id desc limit 1) = 'немає відео з камери';
end $$;

-- коментар можна, підробити передачу — ні
insert into public.order_events (order_id, kind, text) values ('cccccccc-0000-0000-0000-000000000001', 'comment', 'камеру замінили');
do $$ begin
  begin
    insert into public.order_events (order_id, kind, to_status) values ('cccccccc-0000-0000-0000-000000000001', 'move', 'done');
    raise exception 'підроблена передача пройшла';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.order_events;
    raise exception 'історію видалено';
  exception when insufficient_privilege then null;
  end;
end $$;

-- відділ із замовленнями не видалити; позицію з деталей замовлення — теж
do $$ begin
  begin
    delete from public.departments where name = 'Прийом замовлень';
    raise exception 'видалення відділу з замовленнями пройшло';
  exception when foreign_key_violation then null;
  end;
end $$;
delete from public.departments where name = 'Виробництво';  -- порожній — можна

-- =====================================================================
--  Кошик
-- =====================================================================
-- замовлення: напряму не видалити; delete_order кладе в кошик — навіть із виданими деталями
insert into public.orders (id, title) values ('cccccccc-0000-0000-0000-000000000002', 'Помилково створене');
insert into public.order_tasks (order_id, position, text) values ('cccccccc-0000-0000-0000-000000000002', 0, 'пункт');
insert into public.order_events (order_id, kind, text) values ('cccccccc-0000-0000-0000-000000000002', 'comment', 'коментар');
do $$ begin
  begin
    delete from public.orders where id = 'cccccccc-0000-0000-0000-000000000002';
    raise exception 'пряме видалення замовлення пройшло';
  exception when insufficient_privilege then null;
  end;
end $$;
select public.delete_order('cccccccc-0000-0000-0000-000000000001');
do $$ begin
  assert (select deleted_by from public.orders where number = 1) = '22222222-2222-2222-2222-222222222222', 'хто видалив';
  begin
    perform public.move_order('cccccccc-0000-0000-0000-000000000001', 'done');
    raise exception 'передано замовлення з кошика';
  exception when raise_exception then
    assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
  begin
    perform public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1}]',
                                  '', '', null, null, 'cccccccc-0000-0000-0000-000000000001');
    raise exception 'видано під замовлення з кошика';
  exception when raise_exception then
    assert sqlerrm like 'Замовлення не знайдено%', sqlerrm;
  end;
  begin
    perform public.delete_order('cccccccc-0000-0000-0000-000000000001');
    raise exception 'повторне видалення пройшло';
  exception when raise_exception then null;
  end;
end $$;
select public.restore_order('cccccccc-0000-0000-0000-000000000001');
do $$ begin
  assert (select deleted_at from public.orders where number = 1) is null, 'не відновлено';
  begin
    perform public.purge_order('cccccccc-0000-0000-0000-000000000001');  -- не в кошику
    raise exception 'остаточно видалено замовлення не з кошика';
  exception when raise_exception then
    assert sqlerrm = 'Замовлення не знайдено в кошику', sqlerrm;
  end;
end $$;
select public.delete_order('cccccccc-0000-0000-0000-000000000002');
select public.purge_order('cccccccc-0000-0000-0000-000000000002');
do $$ begin
  assert not exists (select 1 from public.orders where id = 'cccccccc-0000-0000-0000-000000000002'), 'замовлення не видалено';
  assert not exists (select 1 from public.order_tasks where order_id = 'cccccccc-0000-0000-0000-000000000002'), 'чекліст лишився';
  assert not exists (select 1 from public.order_events where order_id = 'cccccccc-0000-0000-0000-000000000002'), 'історія лишилася';
end $$;

-- операції: у кошик → залишок без неї; назад; у мінус не відновити; остаточно
insert into public.items (id, name, code) values ('aaaaaaaa-0000-0000-0000-000000000009', 'Тест кошика', 'DUP1');
select public.post_operation('in',  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000009","qty":5}]', 'A');
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000009","qty":5}]', 'B');
select public.cancel_operation((select id from public.operations where comment = 'B'));
do $$ begin assert public.item_qty('aaaaaaaa-0000-0000-0000-000000000009') = 5; end $$;
select public.cancel_operation((select id from public.operations where comment = 'A'));
do $$ begin
  assert public.item_qty('aaaaaaaa-0000-0000-0000-000000000009') = 0;
  begin
    perform public.restore_operation((select id from public.operations where comment = 'B'));  -- 0 − 5
    raise exception 'відновлення в мінус пройшло';
  exception when raise_exception then
    assert sqlerrm like 'Не можна відновити: залишок «Тест кошика» стане -5', sqlerrm;
  end;
end $$;
select public.restore_operation((select id from public.operations where comment = 'A'));
select public.restore_operation((select id from public.operations where comment = 'B'));
do $$ begin
  assert public.item_qty('aaaaaaaa-0000-0000-0000-000000000009') = 0;
  begin
    perform public.restore_operation((select id from public.operations where comment = 'B'));
    raise exception 'відновлено операцію не з кошика';
  exception when raise_exception then
    assert sqlerrm = 'Операцію не знайдено в кошику', sqlerrm;
  end;
end $$;
select public.cancel_operation((select id from public.operations where comment = 'B'));
select public.purge_operation((select id from public.operations where comment = 'B'));
do $$ begin
  assert not exists (select 1 from public.operations where comment = 'B'), 'операцію не видалено назавжди';
  assert public.item_qty('aaaaaaaa-0000-0000-0000-000000000009') = 5;
end $$;

-- позиції: у кошику не проводиться; код звільняється; з історією назавжди не видалити
select public.trash_item('aaaaaaaa-0000-0000-0000-000000000009');
do $$ begin
  assert (select deleted_at from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000009') is not null;
  begin
    perform public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000009","qty":1}]');
    raise exception 'прихід на позицію з кошика пройшов';
  exception when raise_exception then
    assert sqlerrm = 'Позиція «Тест кошика» у кошику — спершу відновіть її', sqlerrm;
  end;
end $$;
insert into public.items (id, name, code) values ('aaaaaaaa-0000-0000-0000-000000000010', 'Новий з тим самим кодом', 'dup1');
do $$ begin
  begin
    perform public.restore_item('aaaaaaaa-0000-0000-0000-000000000009');
    raise exception 'відновлено позицію із зайнятим кодом';
  exception when unique_violation then null;
  end;
  begin
    perform public.purge_item('aaaaaaaa-0000-0000-0000-000000000009');
    raise exception 'остаточно видалено позицію з історією';
  exception when raise_exception then
    assert sqlerrm like 'Позиція має історію руху%', sqlerrm;
  end;
end $$;
delete from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000010';  -- без історії — можна
select public.restore_item('aaaaaaaa-0000-0000-0000-000000000009');
insert into public.items (id, name, photo_path) values ('aaaaaaaa-0000-0000-0000-000000000011', 'Без історії', 'y.jpg');
select public.trash_item('aaaaaaaa-0000-0000-0000-000000000011');
do $$ begin
  assert public.purge_item('aaaaaaaa-0000-0000-0000-000000000011') = 'y.jpg', 'фото не повернуто';
  assert not exists (select 1 from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000011');
end $$;

-- purge_trash: старше 30 днів зникає; позиція з історією лишається (лише ховається)
insert into public.orders (id, title) values ('cccccccc-0000-0000-0000-000000000003', 'Старе в кошику');
select public.delete_order('cccccccc-0000-0000-0000-000000000003');
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000009","qty":2}]', 'C');
select public.cancel_operation((select id from public.operations where comment = 'C'));
insert into public.items (id, name, photo_path) values ('aaaaaaaa-0000-0000-0000-000000000012', 'Старе без історії', 'z.jpg');
select public.trash_item('aaaaaaaa-0000-0000-0000-000000000012');
select public.trash_item('aaaaaaaa-0000-0000-0000-000000000009');
reset role;
update public.orders set deleted_at = now() - interval '31 days' where id = 'cccccccc-0000-0000-0000-000000000003';
update public.operations set cancelled_at = now() - interval '31 days' where comment = 'C';
update public.items set deleted_at = now() - interval '31 days'
 where id in ('aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000009');
set role authenticated;
do $$ begin
  assert (select array_agg(x) from public.purge_trash() x) = array['z.jpg'], 'purge_trash: фото';
  assert not exists (select 1 from public.orders where id = 'cccccccc-0000-0000-0000-000000000003'), 'старе замовлення лишилося';
  assert not exists (select 1 from public.operations where comment = 'C'), 'стара операція лишилася';
  assert not exists (select 1 from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000012'), 'стара позиція лишилася';
  assert exists (select 1 from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000009'), 'позицію з історією видалено';
  assert exists (select 1 from public.orders where id = 'cccccccc-0000-0000-0000-000000000001'), 'зачеплено живе замовлення';
end $$;

-- =====================================================================
--  Ролі та права
-- =====================================================================
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);  -- ivan, адмін
set role authenticated;

select public.admin_create_user('Prod@Example.com', 'secret1', 'Петро',
  (select id from public.roles where name = 'Виробництво'), (select id from public.departments where name = 'Тестування'));
select public.admin_create_user('view@example.com', 'secret1', '',
  (select id from public.roles where name = 'Лише перегляд'), null);
do $$ begin
  assert (select count(*) from public.admin_users()) = 4, 'admin_users';
  assert (select display_name from public.admin_users() where email = 'prod@example.com') = 'Петро', 'імʼя';
  assert (select display_name from public.admin_users() where email = 'view@example.com') = 'view', 'імʼя з email';
  begin
    perform public.admin_create_user('prod@example.com', 'secret1');
    raise exception 'дубль email пройшов';
  exception when raise_exception then assert sqlerrm = 'Користувач з таким email уже є', sqlerrm;
  end;
  begin
    perform public.admin_create_user('x@example.com', '123');
    raise exception 'короткий пароль пройшов';
  exception when raise_exception then assert sqlerrm like 'Пароль%', sqlerrm;
  end;
  begin
    perform public.admin_create_user('без-собачки', 'secret1');
    raise exception 'кривий email пройшов';
  exception when raise_exception then assert sqlerrm = 'Неправильний email', sqlerrm;
  end;
end $$;
reset role;
do $$ begin
  assert (select email_confirmed_at from auth.users where email = 'prod@example.com') is not null, 'не підтверджено';
  assert (select count(*) from auth.identities i join auth.users u on u.id = i.user_id where u.email = 'prod@example.com') = 1, 'identity';
end $$;

-- ---- Петро: Виробництво, відділ «Тестування» ----
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'prod@example.com'), false);
set role authenticated;
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1}]', 'Петро');  -- ops.edit — можна
do $$ begin
  assert public.has_perm('ops.edit') and not public.has_perm('ops.delete'), 'my perms';
  begin
    insert into public.items (name) values ('без права');
    raise exception 'позицію створено без stock.edit';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cancel_operation((select id from public.operations where comment = 'Петро'));
    raise exception 'операцію видалено без ops.delete';
  exception when raise_exception then assert sqlerrm = 'Немає права видаляти операції', sqlerrm;
  end;
  begin
    perform public.trash_item('aaaaaaaa-0000-0000-0000-000000000003');
    raise exception 'позицію видалено без stock.delete';
  exception when raise_exception then assert sqlerrm = 'Немає права видаляти позиції складу', sqlerrm;
  end;
  begin
    perform * from public.admin_users();
    raise exception 'не-адмін побачив користувачів';
  exception when raise_exception then assert sqlerrm = 'Немає права адміністрування', sqlerrm;
  end;
  begin
    insert into public.departments (name) values ('Самочинний');
    raise exception 'відділ створено без адміна';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.roles (name, perms) values ('Самочинна', array['admin']);
    raise exception 'роль створено без адміна';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set role_id = null where id = auth.uid();
    raise exception 'роль змінено самому собі';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_my_department(null);
    raise exception 'відділ змінено без orders.all';
  exception when raise_exception then assert sqlerrm = 'Відділ вам призначає адміністратор', sqlerrm;
  end;
  -- замовлення: лише свого відділу
  assert not exists (select 1 from public.orders where department_id is distinct from public.my_department()), 'видно чужий відділ';
  begin
    insert into public.orders (title, department_id) values ('у чужий відділ', (select id from public.departments where name = 'Прийом замовлень'));
    raise exception 'замовлення в чужий відділ пройшло';
  exception when insufficient_privilege then null;
  end;
end $$;
update public.profiles set display_name = 'Петро І.' where id = auth.uid();  -- своє імʼя — можна
insert into public.orders (id, title, department_id)
  values ('cccccccc-0000-0000-0000-000000000005', 'Своє', (select id from public.departments where name = 'Тестування'));
insert into public.order_tasks (order_id, position, text) values ('cccccccc-0000-0000-0000-000000000005', 0, 'пункт');
do $$ begin
  assert (select count(*) from public.orders where id = 'cccccccc-0000-0000-0000-000000000005') = 1, 'своє не видно';
  begin
    perform public.delete_order('cccccccc-0000-0000-0000-000000000005');
    raise exception 'замовлення видалено без orders.delete';
  exception when raise_exception then assert sqlerrm = 'Немає права видаляти замовлення', sqlerrm;
  end;
  -- передав у чужий відділ — далі вже не бачить і не змінює
  perform public.move_order('cccccccc-0000-0000-0000-000000000005', 'in_work', (select id from public.departments where name = 'Прийом замовлень'));
  assert not exists (select 1 from public.orders where id = 'cccccccc-0000-0000-0000-000000000005'), 'після передачі видно';
  begin
    perform public.move_order('cccccccc-0000-0000-0000-000000000005', 'testing');
    raise exception 'передано чуже замовлення';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
end $$;

-- ---- «Лише перегляд» ----
reset role;
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.orders) > 0, 'orders.all: не видно замовлень';
  assert (select count(*) from public.stock) > 0, 'не видно залишків';
  begin
    perform public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1}]');
    raise exception 'перегляд провів прихід';
  exception when raise_exception then assert sqlerrm = 'Немає права проводити прихід і видаток', sqlerrm;
  end;
end $$;

-- ---- адмін: свої галочки замість ролі, блокування, пароль, захист від самоблокування ----
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
select public.admin_update_user((select id from public.admin_users() where email = 'view@example.com'), 'Оля',
  (select id from public.roles where name = 'Лише перегляд'), null, array['stock.view', 'stock.edit'], true);
do $$ begin
  begin
    perform public.admin_update_user('11111111-1111-1111-1111-111111111111', 'ivan',
      (select id from public.roles where name = 'Комірник'), null, null, true);
    raise exception 'адмін забрав собі адмінку';
  exception when raise_exception then assert sqlerrm like 'Не можна забрати права адміністратора%', sqlerrm;
  end;
  begin
    perform public.admin_update_user('11111111-1111-1111-1111-111111111111', 'ivan', null, null, array['admin'], false);
    raise exception 'адмін заблокував себе';
  exception when raise_exception then assert sqlerrm = 'Не можна заблокувати самого себе', sqlerrm;
  end;
  begin
    perform public.admin_delete_user('11111111-1111-1111-1111-111111111111');
    raise exception 'адмін видалив себе';
  exception when raise_exception then assert sqlerrm = 'Не можна видалити самого себе', sqlerrm;
  end;
  begin
    update public.roles set perms = '{}' where name = 'Адміністратор';
    raise exception 'роль адміна спорожнено';
  exception when raise_exception then assert sqlerrm like 'Має лишитися хоча б один%', sqlerrm;
  end;
  begin
    insert into public.roles (name, perms) values ('Крива', array['fly']);
    raise exception 'невідоме право пройшло';
  exception when check_violation then null;
  end;
  begin
    perform public.admin_set_password((select id from public.admin_users() where email = 'prod@example.com'), '123');
    raise exception 'короткий пароль пройшов';
  exception when raise_exception then null;
  end;
  perform public.admin_set_password((select id from public.admin_users() where email = 'prod@example.com'), 'newpass1');
  perform public.admin_update_user((select id from public.admin_users() where email = 'prod@example.com'), 'Петро',
    (select id from public.roles where name = 'Виробництво'), null, null, false);   -- заблокувати
end $$;
insert into public.roles (name, perms) values ('Склад-плюс', array['stock.view', 'stock.edit']);
reset role;
do $$ begin
  assert (select banned_until from auth.users where email = 'prod@example.com') = 'infinity', 'не заблоковано в auth';
  assert (select encrypted_password from auth.users where email = 'prod@example.com') = md5('newpass1' || 'bf$salt'), 'пароль';
end $$;

-- Оля зі своїми галочками: позиції створює, а замовлень не бачить
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
insert into public.items (name) values ('Створила Оля');
do $$ begin
  assert (select count(*) from public.orders) = 0, 'без orders.view видно замовлення';
end $$;

-- заблокований Петро не бачить нічого й нічого не проводить
reset role;
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'prod@example.com'), false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.items) = 0, 'заблокований бачить позиції';
  assert public.my_perms() = '{}', 'заблокований має права';
  begin
    perform public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1}]');
    raise exception 'заблокований провів операцію';
  exception when raise_exception then null;
  end;
end $$;

-- видалення користувача: його операції лишаються, автор — порожній
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
select public.admin_delete_user((select id from public.admin_users() where email = 'prod@example.com'));
do $$ begin
  assert not exists (select 1 from public.admin_users() where email = 'prod@example.com'), 'не видалено';
  assert (select created_by from public.operations where comment = 'Петро') is null, 'автор лишився';
end $$;

-- =====================================================================
--  Головний адміністратор: користувачами й ролями керує лише він
-- =====================================================================
-- ---- olena: роль «Адміністратор», але не головна ----
reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;
do $$
declare
  v_olya uuid := (select id from public.admin_users() where email = 'view@example.com');
  v_ivan uuid := '11111111-1111-1111-1111-111111111111';
  v_role uuid := (select id from public.roles where name = 'Комірник');
  v_snap jsonb := (select jsonb_agg(to_jsonb(r) order by r.id) from public.roles r);
  v_prof jsonb := (select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p);
  v_n    int;
begin
  assert public.has_perm('admin') and not public.is_owner(), 'olena: адмін, але не головна';
  assert public.owner_id() = v_ivan, 'owner_id';
  assert (select count(*) from public.admin_users()) = 3, 'список людей адміну видно';
  -- RPC: створити, змінити (роль / права / відділ / активність), пароль, видалити — нікого
  begin
    perform public.admin_create_user('new@example.com', 'secret1');
    raise exception 'не головний створив користувача';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_olya, 'Оля', v_role, null, null, true);
    raise exception 'не головний змінив роль';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_olya, 'Оля', null, null, array['admin'], true);
    raise exception 'не головний змінив права';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_olya, 'Оля', null, null, array['stock.view', 'stock.edit'], false);
    raise exception 'не головний заблокував людину';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_update_user(auth.uid(), 'olena', v_role, null, null, true);
    raise exception 'не головний змінив роль собі';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_set_password(v_olya, 'hacked12');
    raise exception 'не головний змінив пароль';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_delete_user(v_olya);
    raise exception 'не головний видалив людину';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  -- головного не торкнутись
  begin
    perform public.admin_update_user(v_ivan, 'ivan', v_role, null, null, false);
    raise exception 'не головний змінив головного';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_set_password(v_ivan, 'hacked12');
    raise exception 'не головний змінив пароль головного';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.admin_delete_user(v_ivan);
    raise exception 'не головний видалив головного';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  -- напряму в таблиці, в обхід RPC: profiles
  begin
    update public.profiles set is_owner = true where id = auth.uid();
    raise exception 'призначив себе головним';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set is_owner = false where id = v_ivan;
    raise exception 'зняв головного';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set role_id = v_role where id = v_olya;
    raise exception 'роль напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set perms = array['admin'] where id = v_olya;
    raise exception 'права напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set active = false where id = v_ivan;
    raise exception 'блокування напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set department_id = null where id = v_olya;
    raise exception 'відділ напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.profiles (id, display_name) values (gen_random_uuid(), 'самозванець');
    raise exception 'профіль напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.profiles where id = v_ivan;
    raise exception 'профіль головного видалено';
  exception when insufficient_privilege then null;
  end;
  update public.profiles set display_name = 'чуже імʼя' where id = v_ivan;   -- RLS: лише свій рядок
  get diagnostics v_n = row_count;
  assert v_n = 0, 'чуже імʼя змінено';
  -- напряму в таблиці: roles (RLS — лише головний)
  begin
    insert into public.roles (name, perms) values ('Самочинна', array['admin']);
    raise exception 'не головний створив роль';
  exception when insufficient_privilege then null;
  end;
  update public.roles set perms = array['admin'] where name = 'Лише перегляд';
  get diagnostics v_n = row_count;
  assert v_n = 0, 'не головний змінив роль';
  update public.roles set name = 'Перейменована' where name = 'Комірник';
  get diagnostics v_n = row_count;
  assert v_n = 0, 'не головний перейменував роль';
  delete from public.roles where name = 'Склад-плюс';
  get diagnostics v_n = row_count;
  assert v_n = 0, 'не головний видалив роль';
  assert (select jsonb_agg(to_jsonb(r) order by r.id) from public.roles r) = v_snap, 'ролі змінилися';
  assert (select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p) = v_prof, 'профілі змінилися';
  assert (select count(*) from public.roles) = 7;   -- їх видно всім
  -- решта адмінського лишилась: налаштування, знімок для копії, відділи, своє імʼя
  assert (public.admin_settings() ->> 'org_name') is not null;
  perform public.admin_save_settings('{"org_name": "ТОВ Тест"}');
  assert (public.admin_dump() -> 'roles') is not null;
  insert into public.departments (name) values ('Тимчасовий відділ');
  update public.departments set name = 'Тимчасовий 2' where name = 'Тимчасовий відділ';
  delete from public.departments where name = 'Тимчасовий 2';
  update public.profiles set display_name = 'olena' where id = auth.uid();
end $$;

-- ---- ivan: головний — може все, але себе не вимкне й не понизить ----
reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
do $$
declare
  v_ivan  uuid := '11111111-1111-1111-1111-111111111111';
  v_olena uuid := '22222222-2222-2222-2222-222222222222';
  v_admin uuid := (select id from public.roles where name = 'Адміністратор');
  v_new   uuid;
  v_role  uuid;
begin
  assert public.is_owner() and public.owner_id() = v_ivan;
  -- користувач: створити (нова роль), роль, свої права, відділ, блокування, пароль, видалити
  v_new := public.admin_create_user('senior@example.com', 'secret1', 'Старший',
    (select id from public.roles where name = 'Старший користувач'), null);
  perform public.admin_update_user(v_new, 'Старший', (select id from public.roles where name = 'Звичайний користувач'),
    (select id from public.departments where name = 'Тестування'), null, true);
  assert (select r.name from public.profiles p join public.roles r on r.id = p.role_id where p.id = v_new) = 'Звичайний користувач';
  perform public.admin_update_user(v_new, 'Старший', null, null, array['stock.view'], false);
  assert (select not active and perms = array['stock.view'] and department_id is null from public.profiles where id = v_new);
  perform public.admin_set_password(v_new, 'newpass2');
  perform public.admin_delete_user(v_new);
  assert not exists (select 1 from public.profiles where id = v_new);
  -- роль: створити, змінити, видалити
  insert into public.roles (name, perms) values ('Тимчасова', array['stock.view']) returning id into v_role;
  update public.roles set name = 'Тимчасова 2', perms = array['stock.view', 'ops.view'] where id = v_role;
  assert (select perms from public.roles where id = v_role) = array['stock.view', 'ops.view'];
  delete from public.roles where id = v_role;
  assert not exists (select 1 from public.roles where id = v_role);
  -- себе: не заблокувати, не понизити (ні роллю, ні галочками, ні «без ролі»), не видалити
  begin
    perform public.admin_update_user(v_ivan, 'ivan', v_admin, null, null, false);
    raise exception 'головний заблокував себе';
  exception when raise_exception then assert sqlerrm = 'Не можна заблокувати самого себе', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_ivan, 'ivan', (select id from public.roles where name = 'Старший користувач'), null, null, true);
    raise exception 'головний понизив себе роллю';
  exception when raise_exception then assert sqlerrm like 'Не можна забрати права адміністратора%', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_ivan, 'ivan', v_admin, null, array['stock.view'], true);
    raise exception 'головний понизив себе галочками';
  exception when raise_exception then assert sqlerrm like 'Не можна забрати права адміністратора%', sqlerrm;
  end;
  begin
    perform public.admin_update_user(v_ivan, 'ivan', null, null, null, true);
    raise exception 'головний лишив себе без ролі';
  exception when raise_exception then assert sqlerrm like 'Не можна забрати права адміністратора%', sqlerrm;
  end;
  begin
    perform public.admin_delete_user(v_ivan);
    raise exception 'головний видалив себе';
  exception when raise_exception then assert sqlerrm = 'Не можна видалити самого себе', sqlerrm;
  end;
  -- через роль теж ні: інший адміністратор лишається (свої галочки), а головний втратив би права
  perform public.admin_update_user(v_olena, 'olena', v_admin, null, array['admin'], true);
  begin
    update public.roles set perms = array['stock.view'] where id = v_admin;
    raise exception 'головного понижено зміною ролі';
  exception when raise_exception then assert sqlerrm like 'Головного адміністратора не можна%', sqlerrm;
  end;
  begin
    delete from public.roles where id = v_admin;
    raise exception 'головного понижено видаленням ролі';
  exception when raise_exception then assert sqlerrm like 'Головного адміністратора не можна%', sqlerrm;
  end;
  perform public.admin_update_user(v_olena, 'olena', v_admin, null, null, true);
  assert (select role_id = v_admin and active and is_owner from public.profiles where id = v_ivan), 'головний на місці';
  -- своє імʼя міняє, як усі; дані (name) зберіг
  perform public.admin_update_user(v_ivan, 'ivan', v_admin, null, null, true);
end $$;
reset role;
do $$ begin
  -- рівно один: другого головного база не прийме навіть від власника схеми
  begin
    update public.profiles set is_owner = true where id = '22222222-2222-2222-2222-222222222222';
    raise exception 'другий головний пройшов';
  exception when unique_violation then null;
  end;
  assert (select count(*) from public.profiles where is_owner) = 1;
  assert (select count(*) from public.roles) = 7, 'ролі: 6 стартових + Склад-плюс';
end $$;

-- не-адмін (Оля, свої галочки): хто головний — бачить, керувати не може
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
do $$ begin
  assert public.owner_id() = '11111111-1111-1111-1111-111111111111' and not public.is_owner();
  begin
    perform public.admin_create_user('new2@example.com', 'secret1');
    raise exception 'не-адмін створив користувача';
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
end $$;

-- без входу — нічого не видно і нічого не провести
reset role;
set role anon;
do $$ begin
  begin
    perform count(*) from public.stock;
    raise exception 'анонім читає залишки';
  exception when insufficient_privilege then null;
  end;
  begin
    assert (select count(*) from public.items) = 0, 'анонім бачить позиції';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.post_operation('in', '[]');
    raise exception 'анонім провів операцію';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.orders;
    raise exception 'анонім читає замовлення';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.move_order('cccccccc-0000-0000-0000-000000000001', 'done');
    raise exception 'анонім передав замовлення';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.purge_trash();
    raise exception 'анонім почистив кошик';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.admin_users();
    raise exception 'анонім побачив користувачів';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_id();
    raise exception 'анонім дізнався головного';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_create_user('anon@example.com', 'secret1');
    raise exception 'анонім створив користувача';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- =====================================================================
--  Резерв під замовлення, повтор з офлайн-черги, серійні номери,
--  налаштування й сповіщення (без pg_net — нічого не падає)
-- =====================================================================
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.orders (id, title, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000007', 'Резерв', 2, (select id from public.departments where name = 'Прийом замовлень'));
insert into public.order_parts values ('cccccccc-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000003', 3);
do $$ begin
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000003') = 3, 'резерв не порахований';
  assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0, 'видане під №1 ще в резерві';
end $$;
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1}]', '', '',
                             null, null, 'cccccccc-0000-0000-0000-000000000007');
do $$ begin assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000003') = 2, 'видача не зменшила резерв'; end $$;
select public.move_order('cccccccc-0000-0000-0000-000000000007', 'cancelled', null, 'перевірка резерву');
do $$ begin assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000003') = 0, 'скасоване резервує'; end $$;
select public.move_order('cccccccc-0000-0000-0000-000000000007', 'in_work');
do $$ begin assert (select reserved from public.stock where id = 'aaaaaaaa-0000-0000-0000-000000000003') = 2, 'відновлене не резервує'; end $$;

-- повтор тієї самої операції з офлайн-черги (той самий p_op_id) не створює дубля
do $$
declare a uuid; b uuid;
begin
  a := public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":4}]', 'офлайн', '', null, null, null,
                             'eeeeeeee-0000-0000-0000-000000000001');
  b := public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":4}]', 'офлайн', '', null, null, null,
                             'eeeeeeee-0000-0000-0000-000000000001');
  assert a = b and a = 'eeeeeeee-0000-0000-0000-000000000001', 'повтор дав інший id';
  assert (select count(*) from public.operations where comment = 'офлайн') = 1, 'повтор створив дубль';
end $$;

-- вироби: унікальний номер (без урахування регістру й пробілів), відмітки ставить сервер
insert into public.order_units (order_id, position, serial) values
  ('cccccccc-0000-0000-0000-000000000007', 0, '0007-01'),
  ('cccccccc-0000-0000-0000-000000000007', 1, '0007-02');
do $$ begin
  begin
    insert into public.order_units (order_id, serial) values ('cccccccc-0000-0000-0000-000000000001', ' 0007-01 ');
    raise exception 'дубль серійного номера пройшов';
  exception when unique_violation then null;
  end;
  begin
    update public.order_units set assembled_at = now() where serial = '0007-01';
    raise exception 'assembled_at записано напряму';
  exception when insufficient_privilege then null;
  end;
end $$;
update public.order_units set assembled = true where serial = '0007-01';
do $$ begin
  assert (select assembled_by from public.order_units where serial = '0007-01') = '11111111-1111-1111-1111-111111111111', 'assembled_by';
  assert (select assembled_at from public.order_units where serial = '0007-01') is not null;
  assert (select tested_by from public.order_units where serial = '0007-01') is null;
end $$;
update public.order_units set assembled = false, tested = true where serial = '0007-01';
do $$ begin
  assert (select assembled_by from public.order_units where serial = '0007-01') is null, 'assembled_by не скинуто';
  assert (select tested_at from public.order_units where serial = '0007-01') is not null, 'tested_at';
end $$;

-- налаштування: токен видно лише маскою; не-адміну — ні
do $$ begin
  assert (public.admin_settings() ->> 'tg_token_set') = 'false';
  perform public.admin_save_settings('{"tg_token": "123:ABCDEFGH", "tg_chat": "-100", "org_name": "ТОВ Тест", "tg_low": true}');
  assert (public.admin_settings() ->> 'tg_token_set') = 'true';
  assert (public.admin_settings() ->> 'tg_token_hint') = '…EFGH', public.admin_settings() ->> 'tg_token_hint';
  assert (select org_name from public.app_settings) = 'ТОВ Тест', 'org_name читається всім';
  begin
    perform tg_token from public.app_settings;
    raise exception 'токен прочитано з таблиці';
  exception when insufficient_privilege then null;
  end;
  assert public.tg_test() is null, 'без pg_net тест має повернути null';
end $$;

-- сповіщення без pg_net: передача замовлення і падіння нижче мінімуму проходять мовчки
insert into public.items (id, name, min_qty) values ('aaaaaaaa-0000-0000-0000-000000000020', 'Низький запас', 3);
select public.post_operation('in',  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000020","qty":5}]');
select public.post_operation('out', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000020","qty":3}]');
select public.move_order('cccccccc-0000-0000-0000-000000000007', 'testing', (select id from public.departments where name = 'Тестування'));
do $$ begin assert public.item_qty('aaaaaaaa-0000-0000-0000-000000000020') = 2; end $$;

-- прострочені: рахуються раз на добу
update public.orders set due_date = current_date - 3 where id = 'cccccccc-0000-0000-0000-000000000007';
do $$ begin
  assert public.notify_overdue() = 1, 'має бути одне прострочене';
  assert (public.admin_settings() ->> 'overdue_sent_on') = current_date::text;
  assert public.notify_overdue() = 0, 'повторно за день не надсилати';
end $$;

-- знімок для резервної копії
do $$
declare d jsonb := public.admin_dump();
begin
  assert jsonb_array_length(d -> 'order_units') = 2, 'dump: вироби';
  assert jsonb_array_length(d -> 'items') > 0 and jsonb_array_length(d -> 'operations') > 0, 'dump: таблиці';
  assert not (d -> 'settings' ? 'tg_token'), 'dump містить токен';
  assert (d -> 'settings' ->> 'org_name') = 'ТОВ Тест';
end $$;

-- Оля (свої галочки, без адміна): налаштувань не бачить, знімка не отримує
reset role;
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
do $$ begin
  begin
    perform public.admin_settings();
    raise exception 'не-адмін побачив налаштування';
  exception when raise_exception then assert sqlerrm = 'Немає права адміністрування', sqlerrm;
  end;
  begin
    perform public.admin_dump();
    raise exception 'не-адмін отримав знімок';
  exception when raise_exception then assert sqlerrm = 'Немає права адміністрування', sqlerrm;
  end;
  assert (select org_name from public.app_settings) = 'ТОВ Тест', 'назва організації має бути видна всім';
end $$;
reset role;

-- =====================================================================
--  Порядок позицій і категорій у «Залишках»
-- =====================================================================
do $$ begin
  assert (select count(*) = count(distinct sort_order) from public.items), 'місця позицій мають бути різні';
  assert (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'stock' and column_name = 'sort_order') = 1, 'stock без sort_order';
end $$;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
-- нова позиція стає в кінець, хоч би як називалась
insert into public.items (id, name) values ('aaaaaaaa-0000-0000-0000-000000000031', 'Яяя порядок 1');
insert into public.items (id, name) values ('aaaaaaaa-0000-0000-0000-000000000032', 'Ааа порядок 2');
insert into public.items (id, name) values ('aaaaaaaa-0000-0000-0000-000000000033', 'Ммм порядок 3');
create temp table ord_before as select id, sort_order, updated_at from public.items;
do $$
declare
  a constant uuid := 'aaaaaaaa-0000-0000-0000-000000000031';
  b constant uuid := 'aaaaaaaa-0000-0000-0000-000000000032';
  c constant uuid := 'aaaaaaaa-0000-0000-0000-000000000033';
  v_max int := (select max(sort_order) from public.items);
begin
  assert (select array_agg(id order by sort_order) from public.stock where id in (a, b, c)) = array[a, b, c], 'нові — в кінець, за часом створення';
  assert (select sort_order from public.items where id = c) = v_max;
  -- напряму місце не змінити й не задати — лише функцією
  begin
    update public.items set sort_order = 1 where id = c;
    raise exception 'sort_order змінено напряму';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.items (name, sort_order) values ('з місцем', 1);
    raise exception 'sort_order задано напряму';
  exception when insufficient_privilege then null;
  end;
  -- перестановка трьох: решта позицій лишається на своїх місцях
  perform public.set_item_order(array[c, a, b]);
  assert (select array_agg(id order by sort_order) from public.items where id in (a, b, c)) = array[c, a, b], 'новий порядок';
  assert (select count(*) from public.items i join ord_before o using (id)
           where i.id not in (a, b, c) and i.sort_order <> o.sort_order) = 0, 'зачепило сторонні позиції';
  assert (select count(*) = count(distinct sort_order) and max(sort_order) = count(*) and min(sort_order) = 1 from public.items), 'місця — 1..N без повторів';
  -- перестановка — не зміна позиції: updated_at той самий
  assert (select count(*) from public.items i join ord_before o using (id) where i.updated_at <> o.updated_at) = 0, 'updated_at змінився';
  -- підмножина (як під фільтром категорії): міняються місцями лише названі
  perform public.set_item_order(array[b, c]);
  assert (select array_agg(id order by sort_order) from public.items where id in (a, b, c)) = array[b, a, c], 'підмножина';
  -- невідомий id пропускається, повтор — помилка, порожній список нічого не міняє
  perform public.set_item_order(array[a, gen_random_uuid(), b]);
  assert (select array_agg(id order by sort_order) from public.items where id in (a, b, c)) = array[a, b, c], 'невідомий id';
  perform public.set_item_order('{}');
  perform public.set_item_order(null);
  assert (select array_agg(id order by sort_order) from public.items where id in (a, b, c)) = array[a, b, c];
  begin
    perform public.set_item_order(array[a, b, a]);
    raise exception 'повтор пройшов';
  exception when raise_exception then assert sqlerrm = 'Позиція в порядку повторюється', sqlerrm;
  end;
  -- звичайна зміна позиції updated_at оновлює, місця не чіпає
  update public.items set note = 'x' where id = a;
  assert (select i.updated_at >= o.updated_at and i.sort_order = v_max - 2 from public.items i join ord_before o using (id) where i.id = a);

  -- категорії: порядок зберігається як є, без порожніх і повторів
  assert (select category_order from public.app_settings) = '{}', 'спершу порожньо';
  perform public.set_category_order(array['Кабелі', ' Мотори ', '', 'Кабелі', 'Електроніка']);
  assert (select category_order from public.app_settings) = array['Кабелі', 'Мотори', 'Електроніка'], (select category_order::text from public.app_settings);
  begin
    update public.app_settings set category_order = '{}';
    raise exception 'порядок категорій змінено напряму';
  exception when insufficient_privilege then null;
  end;
  assert (public.admin_dump() -> 'settings' -> 'category_order') = '["Кабелі", "Мотори", "Електроніка"]'::jsonb, 'dump: порядок категорій';
  assert (public.admin_dump() -> 'items' -> 0) ? 'sort_order', 'dump: порядок позицій';

  -- меню: ключі розділів зберігаються як є, без порожніх і повторів; які з них існують — справа застосунку
  assert (select nav_order from public.app_settings) = '{}', 'меню: спершу порожньо';
  perform public.set_nav_order(array['stock', ' kits ', '', 'stock', 'nema-takoho', 'orders']);
  assert (select nav_order from public.app_settings) = array['stock', 'kits', 'nema-takoho', 'orders'], (select nav_order::text from public.app_settings);
  perform public.set_nav_order(null);
  assert (select nav_order from public.app_settings) = '{}', 'меню: null — порядок за замовчуванням';
  perform public.set_nav_order(array['orders', 'stock', 'kits']);
  begin
    update public.app_settings set nav_order = '{}';
    raise exception 'порядок меню змінено напряму';
  exception when insufficient_privilege then null;
  end;
  assert (public.admin_dump() -> 'settings' -> 'nav_order') = '["orders", "stock", "kits"]'::jsonb, 'dump: порядок меню';
end $$;

-- порядок (меню, позицій, категорій) видно всім активним, а міняє лише головний адміністратор:
-- ні інший адміністратор, ні людина з правом «змінювати позиції складу» — ні
reset role;
create temp table ord_fixed as
  select (select jsonb_agg(jsonb_build_array(id, sort_order) order by id) from public.items) as items,
         (select category_order from public.app_settings) as cats, (select nav_order from public.app_settings) as nav;
grant select on ord_fixed to authenticated;
update public.profiles set perms = array['stock.view', 'stock.edit'] where id = (select id from auth.users where email = 'view@example.com');
do $$ begin
  assert (select p.active and not p.is_owner and 'admin' = any(coalesce(p.perms, r.perms))
            from public.profiles p left join public.roles r on r.id = p.role_id
           where p.id = '22222222-2222-2222-2222-222222222222'), 'olena має бути активним адміністратором, але не головною';
end $$;
-- :who — хто пробує; одна й та сама перевірка для обох
create temp table ord_who (label text, uid uuid);
grant select on ord_who to authenticated;
insert into ord_who values ('інший адміністратор', '22222222-2222-2222-2222-222222222222'),
                           ('користувач зі stock.edit', (select id from auth.users where email = 'view@example.com'));
create function pg_temp.order_denied() returns void language plpgsql as $$
declare v_who text := (select label from ord_who where uid = auth.uid());
begin
  assert v_who is not null and public.has_perm('stock.edit') and not public.is_owner(), 'хто це: ' || coalesce(v_who, '?');
  assert (v_who like 'інший%') = public.has_perm('admin'), v_who;
  assert (select category_order from public.app_settings) = array['Кабелі', 'Мотори', 'Електроніка'], 'порядок категорій видно всім';
  assert (select nav_order from public.app_settings) = array['orders', 'stock', 'kits'], 'порядок меню видно всім';
  assert (select count(sort_order) from public.stock) > 3, 'порядок позицій видно всім';
  begin
    perform public.set_nav_order(array['kits', 'stock']);
    raise exception 'порядок меню змінив %', v_who;
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000033'::uuid, 'aaaaaaaa-0000-0000-0000-000000000031'::uuid]);
    raise exception 'порядок позицій змінив %', v_who;
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
  begin
    perform public.set_category_order(array['Мотори']);
    raise exception 'порядок категорій змінив %', v_who;
  exception when raise_exception then assert sqlerrm = 'Права надає лише головний адміністратор', sqlerrm;
  end;
end $$;
grant execute on function pg_temp.order_denied() to authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;
select pg_temp.order_denied();
reset role;
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
select pg_temp.order_denied();
reset role;
do $$ begin
  assert (select o.items = (select jsonb_agg(jsonb_build_array(id, sort_order) order by id) from public.items)
             and o.cats = s.category_order and o.nav = s.nav_order
            from ord_fixed o, public.app_settings s), 'відмова щось змінила';
end $$;
-- заблокований порядку меню не бачить (як і решти налаштувань)
update public.profiles set active = false where id = (select id from auth.users where email = 'view@example.com');
set role authenticated;
do $$ begin
  assert (select count(*) from public.app_settings) = 0, 'заблокований читає налаштування';
end $$;
reset role;
update public.profiles set active = true where id = (select id from auth.users where email = 'view@example.com');
-- головний може все три
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
do $$ begin
  assert public.is_owner();
  perform public.set_nav_order(array['kits', 'stock', 'orders']);
  perform public.set_category_order(array['Мотори', 'Кабелі']);
  perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000033'::uuid, 'aaaaaaaa-0000-0000-0000-000000000031'::uuid]);
  assert (select nav_order from public.app_settings) = array['kits', 'stock', 'orders'];
  assert (select category_order from public.app_settings) = array['Мотори', 'Кабелі'];
  assert (select array_agg(id order by sort_order) from public.items
           where id in ('aaaaaaaa-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000033'))
       = array['aaaaaaaa-0000-0000-0000-000000000033'::uuid, 'aaaaaaaa-0000-0000-0000-000000000031'::uuid];
end $$;
reset role;
set role anon;
do $$ begin
  begin
    perform public.set_item_order('{}');
    raise exception 'anon викликав set_item_order';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_category_order('{}');
    raise exception 'anon викликав set_category_order';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_nav_order('{}');
    raise exception 'anon викликав set_nav_order';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- =====================================================================
--  Видача замовнику частинами, борг (неповний комплект) і довидача
-- =====================================================================
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.items (id, name) values ('aaaaaaaa-0000-0000-0000-000000000051', 'ВЗ камера'),
                                           ('aaaaaaaa-0000-0000-0000-000000000052', 'ВЗ кабель');
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":7}]');
insert into public.orders (id, title, customer, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000031', 'МАД - аналог - фпв (CM4)', 'Замовник ВЗ', 55,
   (select id from public.departments where name = 'Прийом замовлень'));
insert into public.order_parts values ('cccccccc-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000051', 55);
do $$ begin assert (select reserved from public.stock where name = 'ВЗ камера') = 55; end $$;

-- часткова видача: лишок, статус не міняється, подія ship
select public.ship_order('cccccccc-0000-0000-0000-000000000031', 20, '2026-11-20', 'накладна 17');
do $$ begin
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000031') = 'new', 'часткова видача змінила статус';
  assert (select sum(qty) from public.order_shipments where order_id = 'cccccccc-0000-0000-0000-000000000031') = 20;
  assert (select shipped_at::text || '|' || comment || '|' || created_by from public.order_shipments)
       = '2026-11-20|накладна 17|11111111-1111-1111-1111-111111111111', 'поля видачі';
  assert (select text from public.order_events where kind = 'ship')
       = E'Видано замовнику 20 — усього 20 з 55, лишилось 35\nнакладна 17', (select text from public.order_events where kind = 'ship');
  -- понад лишок, нуль — відмова; нічого не записалось
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 36);
    raise exception 'видано понад лишок';
  exception when raise_exception then assert sqlerrm = 'Не можна видати 36: лишилось видати 35 з 55', sqlerrm;
  end;
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 0);
    raise exception 'нульова видача пройшла';
  exception when raise_exception then assert sqlerrm = 'Вкажіть, скільки виробів видано', sqlerrm;
  end;
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 5, null, '', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":0}]');
    raise exception 'борг з нульовою кількістю пройшов';
  exception when raise_exception then assert sqlerrm = 'Неправильна кількість для «ВЗ камера»', sqlerrm;
  end;
  assert (select count(*) from public.order_shipments) = 1 and (select count(*) from public.order_debts) = 0, 'невдала видача лишила слід';
  -- напряму в таблиці не записати
  begin
    insert into public.order_shipments (order_id, qty) values ('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'прямий запис видачі пройшов';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.order_debts set qty = 1;
    raise exception 'прямий update боргу пройшов';
  exception when insufficient_privilege then null;
  end;
end $$;

-- видача неповним комплектом: борг 10 камер (два рядки однієї позиції зводяться), резерв росте
select public.ship_order('cccccccc-0000-0000-0000-000000000031', 10, null, '',
  '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":4},{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":6}]');
do $$ begin
  assert (select count(*) from public.order_debts) = 1 and (select qty from public.order_debts) = 10, 'борг';
  assert (select left_qty from public.order_debts_left) = 10 and (select closed_qty from public.order_debts_left) = 0;
  assert (select shipped_at from public.order_shipments where qty = 10) = current_date, 'дата за замовчуванням — сьогодні';
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000031') = 'new';
  assert (select reserved from public.stock where name = 'ВЗ камера') = 65, 'борг не потрапив у резерв';
  assert (select text from public.order_events where kind = 'ship' order by id desc limit 1)
       = E'Видано замовнику 10 — усього 30 з 55, лишилось 25\nНеповним комплектом, бракує: ВЗ камера × 10 шт';
  -- кількість у замовленні не може стати меншою за видане
  begin
    update public.orders set qty = 29 where id = 'cccccccc-0000-0000-0000-000000000031';
    raise exception 'кількість зменшено нижче виданого';
  exception when raise_exception then assert sqlerrm = 'Замовнику вже видано 30 — кількість у замовленні не може бути меншою', sqlerrm;
  end;
  update public.orders set qty = 30 where id = 'cccccccc-0000-0000-0000-000000000031';
  update public.orders set qty = 55 where id = 'cccccccc-0000-0000-0000-000000000031';
end $$;

-- довидача: частково (списує склад, у «видане на збірку» не рахується), понад борг і понад залишок — відмова
do $$
declare v_op uuid;
begin
  begin
    perform public.close_order_debt((select id from public.order_debts), 11);
    raise exception 'довидано понад борг';
  exception when raise_exception then assert sqlerrm = 'Не можна довидати 11 «ВЗ камера»: борг — 10', sqlerrm;
  end;
  v_op := public.close_order_debt((select id from public.order_debts), 4);
  assert (select qty from public.stock where name = 'ВЗ камера') = 3, 'довидача не списала склад';
  assert (select left_qty from public.order_debts_left) = 6 and (select closed_qty from public.order_debts_left) = 4;
  assert (select type || '|' || order_id || '|' || counterparty from public.operations where id = v_op)
       = 'out|cccccccc-0000-0000-0000-000000000031|Замовник ВЗ', 'операція довидачі';
  assert (select debt_id from public.operations where id = v_op) = (select id from public.order_debts);
  assert (select reserved from public.stock where name = 'ВЗ камера') = 61, 'резерв: 55 на збірку + 6 боргу';
  assert (select text from public.order_events where kind = 'debt') = 'Довидано замовнику: ВЗ камера × 4 шт — борг лишився 6';
  begin
    perform public.close_order_debt((select id from public.order_debts), 6);
    raise exception 'довидано більше, ніж є на складі';
  exception when raise_exception then assert sqlerrm = 'Недостатньо «ВЗ камера»: є 3, потрібно 6', sqlerrm;
  end;
  assert (select left_qty from public.order_debts_left) = 6 and (select count(*) from public.operations where debt_id is not null) = 1, 'невдала довидача лишила слід';
  -- видалена в журналі довидача знову відкриває борг і повертає склад; відновлена — закриває
  perform public.cancel_operation(v_op);
  assert (select left_qty from public.order_debts_left) = 10 and (select qty from public.stock where name = 'ВЗ камера') = 7;
  perform public.restore_operation(v_op);
  assert (select left_qty from public.order_debts_left) = 6 and (select qty from public.stock where name = 'ВЗ камера') = 3;
end $$;

-- права: без orders.edit — ні; чужий відділ без orders.all — не видно й не змінити; довидача — ще й ops.edit
reset role;
create temp table ship_olya as select id, perms, active, department_id from public.profiles
 where id = (select id from auth.users where email = 'view@example.com');
update public.profiles set perms = array['orders.view', 'orders.all', 'ops.edit'], active = true
 where id = (select id from ship_olya);
select set_config('request.jwt.claim.sub', (select id::text from ship_olya), false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.order_shipments) = 2 and (select count(*) from public.order_debts_left) = 1, 'з orders.view видачі видно';
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'видано без orders.edit';
  exception when raise_exception then assert sqlerrm = 'Немає права змінювати замовлення', sqlerrm;
  end;
  begin
    perform public.cancel_order_shipment((select id from public.order_shipments where qty = 20));
    raise exception 'видачу скасовано без orders.edit';
  exception when raise_exception then assert sqlerrm = 'Немає права змінювати замовлення', sqlerrm;
  end;
  begin
    perform public.close_order_debt((select id from public.order_debts), 1);
    raise exception 'довидано без orders.edit';
  exception when raise_exception then assert sqlerrm = 'Немає права змінювати замовлення', sqlerrm;
  end;
end $$;
reset role;
update public.profiles set perms = array['orders.view', 'orders.edit', 'ops.edit'],
       department_id = (select id from public.departments where name = 'Тестування')
 where id = (select id from ship_olya);
set role authenticated;
do $$ begin
  assert (select count(*) from public.order_shipments) = 0 and (select count(*) from public.order_debts) = 0
     and (select count(*) from public.order_debts_left) = 0, 'видно видачі чужого відділу';
  assert (select reserved from public.stock where name = 'ВЗ камера') = 61, 'резерв рахується за всіма відділами';
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'видано з чужого відділу';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
end $$;
reset role;
do $$
declare v_ship uuid := (select id from public.order_shipments where qty = 20);
        v_debt uuid := (select id from public.order_debts);
begin
  set local role authenticated;
  begin
    perform public.cancel_order_shipment(v_ship);
    raise exception 'скасовано видачу чужого відділу';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
  begin
    perform public.close_order_debt(v_debt, 1);
    raise exception 'довидано борг чужого відділу';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
end $$;
update public.profiles set perms = array['orders.view', 'orders.edit', 'orders.all'] where id = (select id from ship_olya);
set role authenticated;
do $$ begin
  begin
    perform public.close_order_debt((select id from public.order_debts), 1);
    raise exception 'довидано без права на видаток';
  exception when raise_exception then assert sqlerrm = 'Немає права проводити прихід і видаток', sqlerrm;
  end;
  assert (select left_qty from public.order_debts_left) = 6;
end $$;
reset role;
update public.profiles p set perms = o.perms, active = o.active, department_id = o.department_id from ship_olya o where p.id = o.id;
drop table ship_olya;
set role anon;
do $$ begin
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'anon викликав ship_order';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- видано все → «Відвантажено» тим самим move_order (подія move); борг лишається в резерві
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
select public.ship_order('cccccccc-0000-0000-0000-000000000031', 25);
do $$ begin
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000031') = 'shipped', 'повна видача не закрила замовлення';
  assert (select from_status || '>' || to_status || '|' || text from public.order_events
           where order_id = 'cccccccc-0000-0000-0000-000000000031' order by id desc limit 1)
       = 'new>shipped|Видано замовнику 25 — усього 55 з 55';
  assert (select count(*) from public.order_events where order_id = 'cccccccc-0000-0000-0000-000000000031' and kind = 'ship') = 2, 'остання видача — одна подія, не дві';
  assert (select closed_from from public.order_shipments where qty = 25) = 'new';
  assert (select count(*) from public.order_shipments where auto) = 0;
  assert (select reserved from public.stock where name = 'ВЗ камера') = 6, 'після відвантаження в резерві лишається борг';
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'видано з відвантаженого';
  exception when raise_exception then assert sqlerrm = 'Замовлення закрите (відвантажено) — видати замовнику не можна', sqlerrm;
  end;
end $$;

-- скасування видачі, що закрила замовлення: лишок і статус повертаються
select public.cancel_order_shipment((select id from public.order_shipments where qty = 25));
do $$ begin
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000031') = 'new', 'статус не повернувся';
  assert (select sum(qty) from public.order_shipments where cancelled_at is null) = 30;
  assert (select cancelled_by from public.order_shipments where qty = 25) = '11111111-1111-1111-1111-111111111111';
  assert (select from_status || '>' || to_status from public.order_events
           where order_id = 'cccccccc-0000-0000-0000-000000000031' order by id desc limit 1) = 'shipped>new';
  assert (select reserved from public.stock where name = 'ВЗ камера') = 61;
  begin
    perform public.cancel_order_shipment((select id from public.order_shipments where qty = 25));
    raise exception 'повторне скасування пройшло';
  exception when raise_exception then assert sqlerrm = 'Видачу не знайдено або її вже скасовано', sqlerrm;
  end;
  -- за видачею з боргом уже довидано 4 — її не скасувати
  begin
    perform public.cancel_order_shipment((select id from public.order_shipments where qty = 10));
    raise exception 'скасовано видачу з довиданим боргом';
  exception when raise_exception then assert sqlerrm like 'За цією видачею вже довидано деталі%', sqlerrm;
  end;
  assert (select count(*) from public.order_debts) = 1;
end $$;

-- ручне «Відвантажено» на частково виданому: залишок дописується сам; «Відновити» його знімає
select public.move_order('cccccccc-0000-0000-0000-000000000031', 'in_work');
select public.move_order('cccccccc-0000-0000-0000-000000000031', 'shipped');
do $$ begin
  assert (select qty || '|' || closed_from from public.order_shipments where auto and cancelled_at is null) = '25|in_work', 'залишок не дописано';
  assert (select sum(qty) from public.order_shipments where cancelled_at is null) = 55;
end $$;
select public.move_order('cccccccc-0000-0000-0000-000000000031', 'in_work');
do $$ begin
  assert (select sum(qty) from public.order_shipments where cancelled_at is null) = 30, '«Відновити» не зняло дописаний залишок';
  assert (select count(*) from public.order_shipments where closed_from is not null) = 0;
end $$;
-- те саме, але скасовують сам дописаний залишок: замовлення повертається туди, звідки закрилось
select public.move_order('cccccccc-0000-0000-0000-000000000031', 'shipped');
select public.cancel_order_shipment((select id from public.order_shipments where auto and cancelled_at is null));
do $$ begin
  assert (select status from public.orders where id = 'cccccccc-0000-0000-0000-000000000031') = 'in_work';
  assert (select sum(qty) from public.order_shipments where cancelled_at is null) = 30;
end $$;

-- серійні номери: які саме вироби пішли (необовʼязково); скасування видачі знімає позначку
insert into public.order_units (id, order_id, position, serial) values
  ('eeeeeeee-0000-0000-0000-000000000031', 'cccccccc-0000-0000-0000-000000000031', 0, 'VZ-01'),
  ('eeeeeeee-0000-0000-0000-000000000032', 'cccccccc-0000-0000-0000-000000000031', 1, 'VZ-02'),
  ('eeeeeeee-0000-0000-0000-000000000033', 'cccccccc-0000-0000-0000-000000000031', 2, 'VZ-03');
do $$
declare v uuid;
begin
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1, null, '', '[]',
      array['eeeeeeee-0000-0000-0000-000000000031', 'eeeeeeee-0000-0000-0000-000000000032']::uuid[]);
    raise exception 'виробів більше, ніж видано';
  exception when raise_exception then assert sqlerrm = 'Вибрано виробів більше, ніж видається', sqlerrm;
  end;
  begin
    update public.order_units set shipment_id = (select id from public.order_shipments limit 1);
    raise exception 'позначку «видано» поставлено напряму';
  exception when insufficient_privilege then null;
  end;
  v := public.ship_order('cccccccc-0000-0000-0000-000000000031', 2, null, '', '[]',
    array['eeeeeeee-0000-0000-0000-000000000031', 'eeeeeeee-0000-0000-0000-000000000032']::uuid[]);
  assert (select count(*) from public.order_units where shipment_id = v) = 2;
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1, null, '', '[]', array['eeeeeeee-0000-0000-0000-000000000031']::uuid[]);
    raise exception 'виріб видано двічі';
  exception when raise_exception then assert sqlerrm = 'Серед вибраних виробів є чужий або вже виданий', sqlerrm;
  end;
  perform public.cancel_order_shipment(v);
  assert (select count(*) from public.order_units where shipment_id is not null) = 0, 'скасування не зняло позначку з виробів';
  assert (select text from public.order_events where kind = 'ship_cancel' order by id desc limit 1)
       = format('Скасовано видачу замовнику 2 від %s — видано 30 з 55', to_char(current_date, 'DD.MM.YYYY'));
end $$;
delete from public.order_units where order_id = 'cccccccc-0000-0000-0000-000000000031';

-- видача з боргом, за яким ще нічого не довидано, скасовується разом із боргом
do $$
declare v uuid;
begin
  v := public.ship_order('cccccccc-0000-0000-0000-000000000031', 3, null, '', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000052","qty":2}]');
  assert (select reserved from public.stock where name = 'ВЗ кабель') = 2;
  -- позицію, що є в боргу, остаточно не видалити
  perform public.trash_item('aaaaaaaa-0000-0000-0000-000000000052');
  begin
    perform public.purge_item('aaaaaaaa-0000-0000-0000-000000000052');
    raise exception 'позицію з боргу видалено назавжди';
  exception when raise_exception then assert sqlerrm like 'Позиція має історію руху%', sqlerrm;
  end;
  perform public.restore_item('aaaaaaaa-0000-0000-0000-000000000052');
  perform public.cancel_order_shipment(v);
  assert (select count(*) from public.order_debts) = 1 and (select reserved from public.stock where name = 'ВЗ кабель') = 0, 'борг скасованої видачі лишився';
end $$;

-- борг закривається повністю; у кошику замовлення не резервує; остаточне видалення прибирає видачі й борги
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000051","qty":5}]');
do $$
declare v_op uuid;
begin
  v_op := public.close_order_debt((select id from public.order_debts), 5, 'довезли');
  assert (select left_qty from public.order_debts_left) = 1 and (select qty from public.stock where name = 'ВЗ камера') = 3;
  assert (select comment from public.operations where id = v_op) = 'довезли';
  assert (select reserved from public.stock where name = 'ВЗ камера') = 56;   -- замовлення в роботі: 55 на збірку + 1 боргу
  perform public.delete_order('cccccccc-0000-0000-0000-000000000031');
  assert (select reserved from public.stock where name = 'ВЗ камера') = 0, 'замовлення в кошику тримає резерв';
  begin
    perform public.ship_order('cccccccc-0000-0000-0000-000000000031', 1);
    raise exception 'видано з кошика';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
  begin
    perform public.close_order_debt((select id from public.order_debts), 1);
    raise exception 'довидано борг замовлення з кошика';
  exception when raise_exception then assert sqlerrm = 'Замовлення не знайдено', sqlerrm;
  end;
  perform public.restore_order('cccccccc-0000-0000-0000-000000000031');
  assert (select reserved from public.stock where name = 'ВЗ камера') = 56;
  perform public.close_order_debt((select id from public.order_debts), 1);
  assert (select left_qty from public.order_debts_left) = 0 and (select closed_qty from public.order_debts_left) = 10;
  assert (select qty from public.stock where name = 'ВЗ камера') = 2;
  assert (select reserved from public.stock where name = 'ВЗ камера') = 55, 'закритий борг лишився в резерві';
  assert (select text from public.order_events where kind = 'debt' order by id desc limit 1) = 'Довидано замовнику: ВЗ камера × 1 шт — борг закрито';
  begin
    perform public.close_order_debt((select id from public.order_debts), 1);
    raise exception 'довидано за закритим боргом';
  exception when raise_exception then assert sqlerrm = 'Не можна довидати 1 «ВЗ камера»: борг — 0', sqlerrm;
  end;
end $$;
do $$
declare d jsonb := public.admin_dump();
begin
  assert jsonb_array_length(d -> 'order_shipments') = (select count(*) from public.order_shipments) and jsonb_array_length(d -> 'order_shipments') >= 5, 'dump: видачі';
  assert jsonb_array_length(d -> 'order_debts') = 1, 'dump: борги';
end $$;
select public.delete_order('cccccccc-0000-0000-0000-000000000031');
select public.purge_order('cccccccc-0000-0000-0000-000000000031');
do $$ begin
  assert (select count(*) from public.order_shipments) = 0 and (select count(*) from public.order_debts) = 0, 'видачі чи борги видаленого замовлення лишились';
  assert (select count(*) from public.operations where debt_id is not null or order_id = 'cccccccc-0000-0000-0000-000000000031') = 0;
  assert (select qty from public.stock where name = 'ВЗ камера') = 2, 'довидане лишається списаним';
  assert (select reserved from public.stock where name = 'ВЗ камера') = 0;
end $$;
-- purge_trash: старе замовлення з кошика зникає разом із видачами
insert into public.orders (id, title, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000032', 'ВЗ старе', 4, (select id from public.departments where name = 'Прийом замовлень'));
select public.ship_order('cccccccc-0000-0000-0000-000000000032', 1, null, '', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000052","qty":1}]');
select public.delete_order('cccccccc-0000-0000-0000-000000000032');
reset role;
update public.orders set deleted_at = now() - interval '31 days' where id = 'cccccccc-0000-0000-0000-000000000032';
set role authenticated;
select public.purge_trash();
do $$ begin
  assert (select count(*) from public.order_shipments) = 0 and (select count(*) from public.order_debts) = 0, 'purge_trash лишив видачі';
end $$;
reset role;

-- сповіщення Telegram про видачу, довидачу й скасування: tg_notify на час перевірки складає тексти в таблицю
select pg_get_functiondef('public.tg_notify(text, uuid)'::regprocedure) as tg_notify_def \gset
create table public.tg_seen (n serial, txt text);
create or replace function public.tg_notify(p_text text, p_department uuid default null)
returns void language sql security definer set search_path = public as $$ insert into public.tg_seen (txt) values (p_text) $$;
create temp table tg_was as select tg_token, tg_orders, app_url from public.app_settings;
update public.app_settings set tg_token = 'test-token', tg_orders = true, app_url = '';
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
insert into public.orders (id, title, qty, department_id) values
  ('cccccccc-0000-0000-0000-000000000033', 'ВЗ <сповіщення>', 5, (select id from public.departments where name = 'Прийом замовлень'));
select public.post_operation('in', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000052","qty":3}]');
select public.ship_order('cccccccc-0000-0000-0000-000000000033', 2, null, '', '[{"item_id":"aaaaaaaa-0000-0000-0000-000000000052","qty":2}]');
select public.close_order_debt((select id from public.order_debts), 2);
select public.ship_order('cccccccc-0000-0000-0000-000000000033', 1);
select public.cancel_order_shipment((select id from public.order_shipments where order_id = 'cccccccc-0000-0000-0000-000000000033' and qty = 1));
select public.ship_order('cccccccc-0000-0000-0000-000000000033', 3);
reset role;
do $$
declare v_who text := (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111');
        v_no  text := (select number::text from public.orders where id = 'cccccccc-0000-0000-0000-000000000033');
begin
  assert (select array_agg(txt order by n) from public.tg_seen where txt not like '🆕%') = array[
    format(E'📦 <b>№%s</b> «ВЗ &lt;сповіщення&gt;» × 5: Видано замовнику 2 — усього 2 з 5, лишилось 3\nНеповним комплектом, бракує: ВЗ кабель × 2 шт\n%s', v_no, v_who),
    format(E'🧩 <b>№%s</b> «ВЗ &lt;сповіщення&gt;» × 5: Довидано замовнику: ВЗ кабель × 2 шт — борг закрито\n%s', v_no, v_who),
    format(E'📦 <b>№%s</b> «ВЗ &lt;сповіщення&gt;» × 5: Видано замовнику 1 — усього 3 з 5, лишилось 2\n%s', v_no, v_who),
    format(E'↩️ <b>№%s</b> «ВЗ &lt;сповіщення&gt;» × 5: Скасовано видачу замовнику 1 від %s — видано 2 з 5\n%s', v_no, to_char(current_date, 'DD.MM.YYYY'), v_who),
    format(E'📦 <b>№%s</b> «ВЗ &lt;сповіщення&gt;»: Нове → <b>Відвантажено</b>\n%s: Видано замовнику 3 — усього 5 з 5', v_no, v_who)
  ], (select string_agg(txt, E'\n---\n' order by n) from public.tg_seen);
end $$;
update public.app_settings s set tg_token = w.tg_token, tg_orders = w.tg_orders, app_url = w.app_url from tg_was w;
drop table tg_was;
drop table public.tg_seen;
:tg_notify_def;
revoke execute on function public.tg_notify(text, uuid) from public, anon, authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;
select public.delete_order('cccccccc-0000-0000-0000-000000000033');
select public.purge_order('cccccccc-0000-0000-0000-000000000033');
reset role;

-- realtime підключено
do $$ begin
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 16;
end $$;

\echo ALL SCHEMA TESTS PASSED
