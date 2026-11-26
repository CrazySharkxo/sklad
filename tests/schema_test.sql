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
end $$;

-- без права «змінювати позиції складу» порядок видно, але не змінити
reset role;
update public.profiles set perms = array['stock.view'] where id = (select id from auth.users where email = 'view@example.com');
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'view@example.com'), false);
set role authenticated;
do $$ begin
  assert (select category_order from public.app_settings) = array['Кабелі', 'Мотори', 'Електроніка'], 'порядок категорій видно всім';
  assert (select count(sort_order) from public.stock) > 3, 'порядок позицій видно всім';
  begin
    perform public.set_item_order(array['aaaaaaaa-0000-0000-0000-000000000031'::uuid]);
    raise exception 'порядок позицій змінено без stock.edit';
  exception when raise_exception then assert sqlerrm = 'Немає права змінювати позиції складу', sqlerrm;
  end;
  begin
    perform public.set_category_order(array['Мотори']);
    raise exception 'порядок категорій змінено без stock.edit';
  exception when raise_exception then assert sqlerrm = 'Немає права змінювати позиції складу', sqlerrm;
  end;
end $$;
reset role;
update public.profiles set perms = array['stock.view', 'stock.edit'] where id = (select id from auth.users where email = 'view@example.com');
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
end $$;
reset role;

-- realtime підключено
do $$ begin
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 14;
end $$;

\echo ALL SCHEMA TESTS PASSED
