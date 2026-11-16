-- =====================================================================
-- SAM Inventory — migration 0002: business-logic RPCs
--
-- Every stock change goes through one of these functions. They run with
-- owner rights (security definer), check the caller's role themselves, take
-- a per-(product, location) lock so two phones cannot both sell the last
-- unit, and write the movement rows. Clients have NO direct INSERT on
-- stock_movements / sales / sale_items (see 0003).
--
-- Errors carry a machine-readable prefix before the colon, e.g.
-- 'insufficient_stock: ...', so the UI can map them to translated messages.
-- =====================================================================

-- Rows a sale needs from stock: each line itself, plus (for kits) every
-- component × its BOM quantity. Internal helper.
create or replace function public.sale_requirements(p_sale_id uuid)
returns table (product_id uuid, qty integer)
language sql stable
set search_path = public
as $$
  select t.product_id, sum(t.qty)::integer
  from (
    select si.product_id, si.qty
    from public.sale_items si
    where si.sale_id = p_sale_id
    union all
    select kc.component_id, si.qty * kc.qty
    from public.sale_items si
    join public.kit_components kc on kc.kit_id = si.product_id
    where si.sale_id = p_sale_id
  ) t
  group by t.product_id
$$;

-- ---------------------------------------------------------------------
-- receive_stock: a delivery arrives
-- ---------------------------------------------------------------------
create or replace function public.receive_stock(
  p_product  uuid,
  p_location text,
  p_qty      integer,
  p_note     text default null
) returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform public.require_role('admin', 'warehouse');

  if p_qty is null or p_qty <= 0 then
    raise exception 'invalid_qty: qty must be a positive integer';
  end if;
  if not exists (select 1 from public.products where id = p_product and active) then
    raise exception 'unknown_product: %', p_product;
  end if;
  if not exists (select 1 from public.locations where id = p_location) then
    raise exception 'unknown_location: %', p_location;
  end if;

  insert into public.stock_movements (product_id, type, qty, to_location, user_id, note)
  values (p_product, 'receiving', p_qty, p_location, auth.uid(), p_note)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- transfer_stock: move units between locations (validates availability)
-- ---------------------------------------------------------------------
create or replace function public.transfer_stock(
  p_product uuid,
  p_from    text,
  p_to      text,
  p_qty     integer,
  p_note    text default null
) returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_id        bigint;
  v_available integer;
begin
  perform public.require_role('admin', 'warehouse');

  if p_qty is null or p_qty <= 0 then
    raise exception 'invalid_qty: qty must be a positive integer';
  end if;
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'invalid_transfer: source and destination must be two different locations';
  end if;
  if not exists (select 1 from public.products where id = p_product and active) then
    raise exception 'unknown_product: %', p_product;
  end if;
  if not exists (select 1 from public.locations where id = p_from)
     or not exists (select 1 from public.locations where id = p_to) then
    raise exception 'unknown_location';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_product::text || ':' || p_from, 0));

  v_available := public.stock_of(p_product, p_from);
  if v_available < p_qty then
    raise exception 'insufficient_stock: only % in % but % requested', v_available, p_from, p_qty;
  end if;

  insert into public.stock_movements (product_id, type, qty, from_location, to_location, user_id, note)
  values (p_product, 'transfer', p_qty, p_from, p_to, auth.uid(), p_note)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- stock_take: staff enter the COUNTED quantity; the function writes the
-- adjustment (up or down) that makes the books match. No change → no row.
-- ---------------------------------------------------------------------
create or replace function public.stock_take(
  p_product uuid,
  p_location text,
  p_counted  integer,
  p_note     text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_current integer;
  v_delta   integer;
  v_id      bigint;
begin
  perform public.require_role('admin', 'warehouse');

  if p_counted is null or p_counted < 0 then
    raise exception 'invalid_qty: counted quantity must be zero or more';
  end if;
  if not exists (select 1 from public.products where id = p_product and active) then
    raise exception 'unknown_product: %', p_product;
  end if;
  if not exists (select 1 from public.locations where id = p_location) then
    raise exception 'unknown_location: %', p_location;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_product::text || ':' || p_location, 0));

  v_current := public.stock_of(p_product, p_location);
  v_delta   := p_counted - v_current;

  if v_delta > 0 then
    insert into public.stock_movements (product_id, type, qty, to_location, user_id, note)
    values (p_product, 'adjustment', v_delta, p_location, auth.uid(),
            coalesce(p_note, 'stock take: counted ' || p_counted || ', books ' || v_current))
    returning id into v_id;
  elsif v_delta < 0 then
    insert into public.stock_movements (product_id, type, qty, from_location, user_id, note)
    values (p_product, 'adjustment', -v_delta, p_location, auth.uid(),
            coalesce(p_note, 'stock take: counted ' || p_counted || ', books ' || v_current))
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'movement_id', v_id,
    'previous',    v_current,
    'counted',     p_counted,
    'delta',       v_delta
  );
end;
$$;

-- ---------------------------------------------------------------------
-- complete_sale
--   p_items: [{"product_id": "<uuid>", "qty": 2}, ...]
-- Prices are read from the catalog on the server (the client cannot set a
-- price) and frozen into sale_items (rule 4). Wireless tier uses the wireless
-- price and falls back to the general price when a product has none.
-- p_client_ref makes retries from the offline queue idempotent.
-- Returns {sale_id, receipt_number, total, currency, created_at, duplicate}.
-- ---------------------------------------------------------------------
create or replace function public.complete_sale(
  p_currency      text,
  p_price_tier    text,
  p_sold_from     text,
  p_items         jsonb,
  p_customer_id   uuid default null,
  p_customer_name text default null,
  p_client_ref    uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_sale_id  uuid := gen_random_uuid();
  v_number   bigint;
  v_receipt  text;
  v_total    numeric(14, 2);
  v_created  timestamptz;
  v_cname    text;
  v_line     record;
  v_req      record;
  v_prod     public.products%rowtype;
  v_price    numeric;
  v_short    jsonb;
  v_existing public.sales%rowtype;
begin
  perform public.require_role('admin', 'sales');

  if p_currency is null or p_currency not in ('USD', 'SYP') then
    raise exception 'invalid_currency: %', p_currency;
  end if;
  if p_price_tier is null or p_price_tier not in ('general', 'wireless') then
    raise exception 'invalid_tier: %', p_price_tier;
  end if;
  if not exists (select 1 from public.locations where id = p_sold_from) then
    raise exception 'unknown_location: %', p_sold_from;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_cart: at least one item is required';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(product_id uuid, qty integer)
    where x.product_id is null or x.qty is null or x.qty <= 0
  ) then
    raise exception 'invalid_item: every item needs a product_id and a positive integer qty';
  end if;

  -- Retry of a sale that already went through: return it, change nothing.
  if p_client_ref is not null then
    perform pg_advisory_xact_lock(hashtextextended('sale:' || p_client_ref::text, 0));
    select * into v_existing from public.sales where client_ref = p_client_ref;
    if found then
      return jsonb_build_object(
        'sale_id', v_existing.id, 'receipt_number', v_existing.receipt_number,
        'total', v_existing.total, 'currency', v_existing.currency,
        'created_at', v_existing.created_at, 'duplicate', true);
    end if;
  end if;

  if p_customer_id is not null then
    select name into v_cname from public.customers where id = p_customer_id;
    if not found then
      raise exception 'unknown_customer: %', p_customer_id;
    end if;
  else
    v_cname := nullif(btrim(p_customer_name), '');
  end if;

  -- Gap-free receipt number (rolls back with the sale if anything below fails).
  update public.receipt_counter
  set last_number = last_number + 1
  where singleton = true
  returning last_number into v_number;
  v_receipt := 'R-' || v_number;

  insert into public.sales
    (id, receipt_number, client_ref, customer_id, customer_name,
     currency, price_tier, total, sold_from, user_id)
  values
    (v_sale_id, v_receipt, p_client_ref, p_customer_id, v_cname,
     p_currency, p_price_tier, 0, p_sold_from, auth.uid())
  returning created_at into v_created;

  -- Lines (duplicate product lines are merged), priced from the catalog.
  for v_line in
    select x.product_id, sum(x.qty)::integer as qty
    from jsonb_to_recordset(p_items) as x(product_id uuid, qty integer)
    group by x.product_id
    order by x.product_id
  loop
    select * into v_prod from public.products where id = v_line.product_id;
    if not found or not v_prod.active or not v_prod.for_sale then
      raise exception 'not_for_sale: product % is not available for sale', v_line.product_id;
    end if;

    v_price := case
      when p_currency = 'USD' and p_price_tier = 'wireless' then coalesce(v_prod.wireless_price_usd, v_prod.price_usd)
      when p_currency = 'USD'                                then v_prod.price_usd
      when p_price_tier = 'wireless'                         then coalesce(v_prod.wireless_price_syp, v_prod.price_syp)
      else v_prod.price_syp
    end;
    if v_price is null or v_price <= 0 then
      raise exception 'no_price: % has no % price in %', v_prod.item_code, p_price_tier, p_currency;
    end if;

    insert into public.sale_items (sale_id, product_id, qty, unit_price, price_currency)
    values (v_sale_id, v_line.product_id, v_line.qty, v_price, p_currency);
  end loop;

  -- Lock every (product, location) pair in a fixed order, then check ALL of
  -- them so the cashier sees every shortage at once.
  for v_req in
    select r.product_id from public.sale_requirements(v_sale_id) r order by r.product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_req.product_id::text || ':' || p_sold_from, 0));
  end loop;

  select jsonb_agg(
           jsonb_build_object(
             'product_id', r.product_id,
             'item_code',  p.item_code,
             'needed',     r.qty,
             'available',  public.stock_of(r.product_id, p_sold_from))
           order by p.item_code)
  into v_short
  from public.sale_requirements(v_sale_id) r
  join public.products p on p.id = r.product_id
  where public.stock_of(r.product_id, p_sold_from) < r.qty;

  if v_short is not null then
    raise exception 'insufficient_stock: not enough stock in %', p_sold_from
      using detail = v_short::text;
  end if;

  insert into public.stock_movements (product_id, type, qty, from_location, sale_id, user_id, note)
  select r.product_id, 'sale', r.qty, p_sold_from, v_sale_id, auth.uid(), v_receipt
  from public.sale_requirements(v_sale_id) r;

  select sum(line_total) into v_total from public.sale_items where sale_id = v_sale_id;
  update public.sales set total = v_total where id = v_sale_id;

  return jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total,
    'currency', p_currency, 'created_at', v_created, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------
-- cancel_sale: soft-cancel (admin). Receipt number stays used; the units go
-- back to the location they left via 'return' movements.
-- ---------------------------------------------------------------------
create or replace function public.cancel_sale(
  p_sale_id uuid,
  p_reason  text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
begin
  perform public.require_role('admin');

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'unknown_sale: %', p_sale_id;
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'already_cancelled: receipt % is already cancelled', v_sale.receipt_number;
  end if;

  insert into public.stock_movements (product_id, type, qty, to_location, sale_id, user_id, note)
  select m.product_id, 'return', m.qty, m.from_location, m.sale_id, auth.uid(),
         'cancelled ' || v_sale.receipt_number
  from public.stock_movements m
  where m.sale_id = p_sale_id and m.type = 'sale';

  update public.sales
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason
   where id = p_sale_id;

  return jsonb_build_object('sale_id', p_sale_id, 'receipt_number', v_sale.receipt_number, 'status', 'cancelled');
end;
$$;
