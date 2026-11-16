-- =====================================================================
-- Acceptance tests for build step 1 (schema, stock rules, roles, RLS).
-- Runs inside one transaction and rolls back: leaves no data behind.
--   psql -v ON_ERROR_STOP=1 -q -f supabase/tests/acceptance.sql "$DATABASE_URL"
-- Needs a fresh database with the migrations applied (receipt counter at
-- 1000) and the auth.users table + auth.uid() (see 00_local_shim.sql).
-- =====================================================================
\set ON_ERROR_STOP on
\o /dev/null
begin;

-- Test helpers -----------------------------------------------------------
create schema t;
grant usage on schema t to public;

-- Act as a user (or as anon / the superuser when p_uid is null).
create function t.become(p_uid uuid, p_role text default 'authenticated') returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims',
                     case when p_uid is null then '' else json_build_object('sub', p_uid)::text end, true);
  if p_role <> 'superuser' then
    execute format('set local role %I', p_role);
  end if;
end $$;

create function t.ok(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

-- Run p_sql, require it to fail with a message LIKE p_msg_like
-- (and, if given, a DETAIL LIKE p_detail_like).
create function t.fails(p_sql text, p_msg_like text, p_detail_like text default null) returns void
language plpgsql as $$
declare v_msg text; v_detail text;
begin
  begin
    execute p_sql;
    raise exception 'FAIL: expected an error like "%" but it succeeded: %', p_msg_like, p_sql;
  exception when others then
    if sqlerrm like 'FAIL: expected an error%' then raise; end if;
    get stacked diagnostics v_detail = pg_exception_detail;
    v_msg := sqlerrm;
  end;
  if v_msg not like p_msg_like then
    raise exception 'FAIL: expected error like "%" but got "%"', p_msg_like, v_msg;
  end if;
  if p_detail_like is not null and coalesce(v_detail, '') not like p_detail_like then
    raise exception 'FAIL: expected detail like "%" but got "%"', p_detail_like, v_detail;
  end if;
  raise notice 'PASS: blocked (%)', v_msg;
end $$;

grant execute on all functions in schema t to public;

-- Fixtures (as superuser) -------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@test'),
  ('a0000000-0000-0000-0000-000000000002', 'sales@test'),
  ('a0000000-0000-0000-0000-000000000003', 'warehouse@test'),
  ('a0000000-0000-0000-0000-000000000004', 'nobody@test');

insert into public.staff_roles (user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', 'admin'),
  ('a0000000-0000-0000-0000-000000000002', 'sales'),
  ('a0000000-0000-0000-0000-000000000003', 'warehouse');

insert into public.products (id, item_code, name, price_usd, price_syp, wireless_price_usd, wireless_price_syp, for_sale) values
  ('b0000000-0000-0000-0000-000000000001', 'T-001', 'Router',   10, 150000, 8, 120000, true),
  ('b0000000-0000-0000-0000-000000000002', 'T-002', 'No wireless price', 5, 75000, null, null, true),
  ('b0000000-0000-0000-0000-000000000003', 'T-003', 'Not for sale', 5, 75000, null, null, false),
  ('b0000000-0000-0000-0000-000000000004', 'T-KIT', 'Kit',      50, 750000, null, null, true),
  ('b0000000-0000-0000-0000-000000000005', 'T-C1',  'Kit component', 0, 0, null, null, false);

insert into public.kit_components (kit_id, component_id, qty) values
  ('b0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000005', 2);

-- Shorthands: user ids and a stock lookup that works for any role
\set admin     '''a0000000-0000-0000-0000-000000000001'''
\set sales     '''a0000000-0000-0000-0000-000000000002'''
\set wh        '''a0000000-0000-0000-0000-000000000003'''
\set nobody    '''a0000000-0000-0000-0000-000000000004'''
\set p1        '''b0000000-0000-0000-0000-000000000001'''
\set p2        '''b0000000-0000-0000-0000-000000000002'''
\set p3        '''b0000000-0000-0000-0000-000000000003'''
\set kit       '''b0000000-0000-0000-0000-000000000004'''
\set comp      '''b0000000-0000-0000-0000-000000000005'''

create function t.stock(p_product uuid, p_loc text) returns integer
language sql stable as $$
  select qty from public.stock_view where product_id = p_product and location = p_loc
$$;
grant execute on function t.stock(uuid, text) to public;

-- 1. Stock flow: receive 10 -> transfer 6 -> transfer 4 -> sell 2 --------
select t.become(:wh::uuid);
select public.receive_stock(:p1::uuid, 'warehouse', 10, 'delivery');
select public.transfer_stock(:p1::uuid, 'warehouse', 'storage', 6);
select public.transfer_stock(:p1::uuid, 'storage', 'display', 4);
select t.ok(t.stock(:p1::uuid,'warehouse') = 4 and t.stock(:p1::uuid,'storage') = 2 and t.stock(:p1::uuid,'display') = 4,
            'receive 10, transfer 6 and 4 -> warehouse 4 / storage 2 / display 4');

-- 2. Validation of movements ------------------------------------------
select t.fails(format('select public.transfer_stock(%L, ''display'', ''storage'', 5)', :p1), 'insufficient_stock:%');
select t.fails(format('select public.transfer_stock(%L, ''display'', ''display'', 1)', :p1), 'invalid_transfer:%');
select t.fails(format('select public.receive_stock(%L, ''display'', 0)', :p1), 'invalid_qty:%');
select t.fails(format('select public.receive_stock(%L, ''nowhere'', 1)', :p1), 'unknown_location:%');

-- 3. Sale in SYP, wireless tier, from display -----------------------------
select t.become(:sales::uuid);
create temp table sale1 as
  select public.complete_sale('SYP', 'wireless', 'display',
         jsonb_build_array(jsonb_build_object('product_id', :p1, 'qty', 2)),
         null, 'Test ISP') as r;
grant select on sale1 to public;

select t.ok((select r->>'receipt_number' from sale1) = 'R-1001', 'first receipt is R-1001');
select t.ok((select (r->>'total')::numeric from sale1) = 240000, 'wireless SYP price used: 2 x 120000');
select t.ok(t.stock(:p1::uuid,'display') = 2, 'sale deducted 2 from display');
select t.ok((select unit_price from public.sale_items where sale_id = (select (r->>'sale_id')::uuid from sale1)) = 120000
        and (select price_currency from public.sale_items where sale_id = (select (r->>'sale_id')::uuid from sale1)) = 'SYP',
        'unit price + currency frozen on the line');

select t.become(:admin::uuid);
select t.ok((select count(*) from public.stock_movements
              where type = 'sale' and from_location = 'display' and qty = 2
                and user_id = :sales::uuid and note = 'R-1001') = 1,
            'sale movement logged with the seller and receipt');

-- 4. Wireless tier falls back to the general price ---------------------
select t.become(:wh::uuid);
select public.receive_stock(:p2::uuid, 'display', 5);
select t.become(:sales::uuid);
select t.ok((select (public.complete_sale('USD', 'wireless', 'display',
              jsonb_build_array(jsonb_build_object('product_id', :p2, 'qty', 1)))->>'total')::numeric) = 5,
            'no wireless price -> general price used');

-- 5. Blocked sales + gap-free numbering ---------------------------------
select t.fails(format('select public.complete_sale(''USD'',''general'',''display'', jsonb_build_array(jsonb_build_object(''product_id'', %L, ''qty'', 3)))', :p1),
               'insufficient_stock:%', '%"item_code": "T-001"%');
select t.fails(format('select public.complete_sale(''USD'',''general'',''display'', jsonb_build_array(jsonb_build_object(''product_id'', %L, ''qty'', 1)))', :p3),
               'not_for_sale:%');
select t.fails('select public.complete_sale(''USD'',''general'',''display'', ''[]''::jsonb)', 'empty_cart:%');
select t.ok(t.stock(:p1::uuid,'display') = 2, 'blocked sales left stock untouched');
select t.ok((select public.complete_sale('USD', 'general', 'display',
              jsonb_build_array(jsonb_build_object('product_id', :p1, 'qty', 1)))->>'receipt_number') = 'R-1003',
            'receipt numbers stay sequential after failed attempts (R-1001, R-1002, R-1003)');

-- 6. Idempotent retry (offline queue) -----------------------------------
create temp table sale_retry as
  select public.complete_sale('USD', 'general', 'display',
         jsonb_build_array(jsonb_build_object('product_id', :p1, 'qty', 1)),
         null, null, 'c0000000-0000-0000-0000-00000000000a') as r;
grant select on sale_retry to public;
select t.ok(t.stock(:p1::uuid,'display') = 0, 'display P1 now 0 after R-1004');
select t.ok((select public.complete_sale('USD', 'general', 'display',
              jsonb_build_array(jsonb_build_object('product_id', :p1, 'qty', 1)),
              null, null, 'c0000000-0000-0000-0000-00000000000a')->>'receipt_number') = (select r->>'receipt_number' from sale_retry),
            'retry with the same client_ref returns the original receipt');
select t.ok(t.stock(:p1::uuid,'display') = 0, 'retry did not deduct again');

-- 7. Kits: kit line + components x BOM ratio ----------------------------
select t.become(:wh::uuid);
select public.receive_stock(:kit::uuid, 'display', 10);
select public.receive_stock(:comp::uuid, 'display', 6);
select t.become(:sales::uuid);
select t.fails(format('select public.complete_sale(''USD'',''general'',''display'', jsonb_build_array(jsonb_build_object(''product_id'', %L, ''qty'', 4)))', :kit),
               'insufficient_stock:%', '%"needed": 8%"item_code": "T-C1"%');
select public.complete_sale('USD', 'general', 'display',
       jsonb_build_array(jsonb_build_object('product_id', :kit, 'qty', 2)));
select t.ok(t.stock(:kit::uuid,'display') = 8 and t.stock(:comp::uuid,'display') = 2,
            'selling 2 kits deducts 2 kits and 4 components (BOM 2:1)');
select t.become(:admin::uuid);
select t.fails(format('insert into public.kit_components values (%L, %L, 1)', :comp, :p1), 'nested_kit:%');

-- 8. Stock take: up, down, no change ------------------------------------
select t.become(:wh::uuid);
select t.ok((select (public.stock_take(:p1::uuid, 'display', 5))->>'delta')::int = 5, 'stock take up: counted 5, books 0 -> +5');
select t.ok((select (public.stock_take(:p1::uuid, 'display', 1))->>'delta')::int = -4, 'stock take down: counted 1, books 5 -> -4');
select t.ok(t.stock(:p1::uuid,'display') = 1, 'display P1 equals the counted 1');
select t.ok((select (public.stock_take(:p1::uuid, 'display', 1))->>'movement_id') is null, 'stock take with no difference writes no movement');

-- 9. Cancel: admin only, returns stock, receipt number stays used --------
select t.become(:sales::uuid);
select t.fails(format('select public.cancel_sale(%L)', (select r->>'sale_id' from sale1)), 'forbidden:%');
select t.become(:admin::uuid);
select t.ok(t.stock(:p1::uuid,'display') = 1, 'before cancel: display P1 = 1');
select public.cancel_sale((select (r->>'sale_id')::uuid from sale1), 'customer returned');
select t.ok(t.stock(:p1::uuid,'display') = 3, 'cancelling R-1001 returned its 2 units to display');
select t.ok((select status from public.sales where receipt_number = 'R-1001') = 'cancelled', 'sale marked cancelled, not deleted');
select t.fails(format('select public.cancel_sale(%L)', (select r->>'sale_id' from sale1)), 'already_cancelled:%');

-- 10. Roles & RLS (enforced by the database) ----------------------------
select t.become(:wh::uuid);
select t.fails(format('select public.complete_sale(''USD'',''general'',''display'', jsonb_build_array(jsonb_build_object(''product_id'', %L, ''qty'', 1)))', :p1), 'forbidden:%');
select t.fails('select public.cancel_sale(gen_random_uuid())', 'forbidden:%');
select t.ok((select count(*) from public.sales) = 0, 'warehouse cannot read sales');
select t.ok((select count(*) from public.products) = 5, 'warehouse can read the catalog');
select t.ok((select count(*) from public.stock_movements) > 0, 'warehouse can read the movements log');
select t.fails('select * from public.receipt_counter', 'permission denied%');

select t.become(:sales::uuid);
select t.fails('select public.receive_stock(gen_random_uuid(), ''display'', 1)', 'forbidden:%');
select t.fails(format('select public.stock_take(%L, ''display'', 1)', :p1), 'forbidden:%');
select t.fails(format('insert into public.stock_movements (product_id, type, qty, to_location) values (%L, ''receiving'', 99, ''display'')', :p1), 'permission denied%');
select t.fails('insert into public.sales (receipt_number, currency, price_tier, total, sold_from) values (''X'', ''USD'', ''general'', 1, ''display'')', 'permission denied%');
select t.ok((select count(*) from public.stock_movements) = 0, 'sales staff cannot read the movements log');
select t.ok((select count(*) from public.sales where user_id <> :sales::uuid) = 0
        and (select count(*) from public.sales) > 0, 'sales staff see only their own sales');
select t.ok(t.stock(:p1::uuid,'display') = 3, 'sales staff can read stock levels');
do $$ declare n int; begin
  update public.products set for_sale = true where id = 'b0000000-0000-0000-0000-000000000003';
  get diagnostics n = row_count;
  perform t.ok(n = 0, 'sales staff cannot toggle For Sale (0 rows updated)');
end $$;
select t.fails('delete from public.products', 'permission denied%');

select t.become(:admin::uuid);
select t.ok((select for_sale from public.products where id = :p3::uuid) = false, 'For Sale flag unchanged by the blocked update');
update public.products set for_sale = true where id = :p3::uuid;
select t.ok((select for_sale from public.products where id = :p3::uuid), 'admin can toggle For Sale');
select t.ok((select count(*) from public.sales) = 5, 'admin sees every sale');

select t.become(:nobody::uuid);
select t.ok((select count(*) from public.products) = 0 and (select count(*) from public.stock_view) = 0,
            'authenticated user without a staff role sees nothing');
select t.fails(format('select public.receive_stock(%L, ''display'', 1)', :p1), 'forbidden:%');

select t.become(null, 'anon');
select t.fails('select * from public.stock_view', 'permission denied%');
select t.fails('select * from public.products', 'permission denied%');
select t.fails('select public.app_role()', 'permission denied%');

-- 11. Immutability, last-admin guard ------------------------------------
select t.become(null, 'superuser');
select t.fails('update public.stock_movements set qty = 1', 'append_only:%');
select t.fails('delete from public.stock_movements', 'append_only:%');
select t.fails('truncate public.stock_movements', 'append_only:%');
select t.fails('delete from public.sales', 'append_only:%');
select t.fails('update public.sale_items set qty = 1', 'append_only:%');

select t.become(:admin::uuid);
select t.fails(format('update public.staff_roles set active = false where user_id = %L', :admin), 'last_admin:%');

-- 11b. Catalog import: merge semantics, atomic, admin only --------------
select t.become(:admin::uuid);
select t.ok((select public.import_products(jsonb_build_array(
              jsonb_build_object('item_code', 'T-001', 'price_usd', 12, 'wireless_price_usd', null),
              jsonb_build_object('item_code', 'N-100', 'name', 'Imported', 'category', 'Routers', 'price_usd', 7, 'price_syp', 105000)
            ))::text) = '{"updated": 1, "inserted": 1}',
            'import: one product updated, one inserted');
select t.ok((select price_usd = 12 and wireless_price_usd is null and for_sale and price_syp = 150000 and name = 'Router'
               from public.products where item_code = 'T-001'),
            'import updates only the keys present (for_sale, SYP price and name untouched)');
select t.ok((select for_sale = false and unit = 'قطعة' and wireless_price_syp is null from public.products where item_code = 'N-100'),
            'import: new product gets column defaults for absent keys');
select t.fails('select public.import_products(jsonb_build_array(jsonb_build_object(''item_code'', ''N-200'', ''name'', ''Ok''), jsonb_build_object(''item_code'', ''N-200'', ''name'', ''Dup'')))', 'duplicate_code:%');
select t.fails('select public.import_products(jsonb_build_array(jsonb_build_object(''item_code'', ''N-300'', ''name'', ''Fine''), jsonb_build_object(''item_code'', ''N-301'')))', 'invalid_row:%');
select t.ok((select count(*) from public.products where item_code in ('N-200', 'N-300')) = 0, 'a failed import saves nothing (atomic)');
select t.become(:sales::uuid);
select t.fails('select public.import_products(''[]''::jsonb)', 'forbidden:%');
select t.become(:wh::uuid);
select t.fails('select public.import_products(''[]''::jsonb)', 'forbidden:%');
select t.become(null, 'anon');
select t.fails('select public.import_products(''[]''::jsonb)', 'permission denied%');

-- 12. Books balance: received + adjustments - sold + returned = in stock --
select t.become(:admin::uuid);
select t.ok(
  (select coalesce(sum(case when type in ('receiving','return') then qty
                            when type = 'sale' then -qty
                            when type = 'adjustment' and to_location is not null then qty
                            when type = 'adjustment' then -qty end), 0)
   from public.stock_movements where product_id = :p1::uuid)
  = (select sum(qty) from public.stock_view where product_id = :p1::uuid),
  'stock_view agrees with the raw movement history');

\o
rollback;
\echo ALL ACCEPTANCE TESTS PASSED
