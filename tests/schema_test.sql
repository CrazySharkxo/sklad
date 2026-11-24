-- Сценарії перевірки бізнес-логіки. Кожна перевірка падає з exception, якщо щось не так.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ivan@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'olena@example.com');

-- тригер створив профілі
do $$ begin
  assert (select count(*) from public.profiles) = 2, 'профілі не створено';
  assert (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'ivan';
end $$;

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
update public.profiles set department_id = (select id from public.departments where name = 'Прийом замовлень')
 where id = auth.uid();

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
end $$;
reset role;

-- realtime підключено
do $$ begin
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 11;
end $$;

\echo ALL SCHEMA TESTS PASSED
