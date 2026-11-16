-- =====================================================================
-- SAM Inventory — migration 0010: sale counter and return compatibility
-- =====================================================================

-- Older deployed clients called return_stock. Keep that API available while
-- using the same validated transfer implementation as the current client.
create or replace function public.return_stock(
  p_product uuid,
  p_from text,
  p_to text,
  p_qty integer,
  p_note text default null
) returns bigint
language plpgsql security definer
set search_path = public
as $$
begin
  return public.transfer_stock(p_product, p_from, p_to, p_qty, p_note);
end;
$$;

revoke all on function public.return_stock(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.return_stock(uuid, text, text, integer, text) to authenticated;

-- Recreate complete_sale with an explicit singleton predicate. Some hosted
-- Postgres configurations reject UPDATE statements without WHERE clauses.
create or replace function public.complete_sale(
  p_currency text,
  p_price_tier text,
  p_sold_from text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_customer_name text default null,
  p_client_ref uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_number bigint;
  v_receipt text;
  v_total numeric(14, 2);
  v_created timestamptz;
  v_cname text;
  v_line record;
  v_req record;
  v_prod public.products%rowtype;
  v_price numeric;
  v_short jsonb;
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

  update public.receipt_counter
  set last_number = last_number + 1
  where singleton = true
  returning last_number into v_number;
  if v_number is null then
    raise exception 'receipt_counter_missing: receipt counter is not initialized';
  end if;
  v_receipt := 'R-' || v_number;

  insert into public.sales
    (id, receipt_number, client_ref, customer_id, customer_name,
     currency, price_tier, total, sold_from, user_id)
  values
    (v_sale_id, v_receipt, p_client_ref, p_customer_id, v_cname,
     p_currency, p_price_tier, 0, p_sold_from, auth.uid())
  returning created_at into v_created;

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
      when p_currency = 'USD' then v_prod.price_usd
      when p_price_tier = 'wireless' then coalesce(v_prod.wireless_price_syp, v_prod.price_syp)
      else v_prod.price_syp
    end;
    if v_price is null or v_price <= 0 then
      raise exception 'no_price: % has no % price in %', v_prod.item_code, p_price_tier, p_currency;
    end if;

    insert into public.sale_items (sale_id, product_id, qty, unit_price, price_currency)
    values (v_sale_id, v_line.product_id, v_line.qty, v_price, p_currency);
  end loop;

  for v_req in
    select r.product_id from public.sale_requirements(v_sale_id) r order by r.product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_req.product_id::text || ':' || p_sold_from, 0));
  end loop;

  select jsonb_agg(
           jsonb_build_object(
             'product_id', r.product_id,
             'item_code', p.item_code,
             'needed', r.qty,
             'available', public.stock_of(r.product_id, p_sold_from))
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

revoke all on function public.complete_sale(text, text, text, jsonb, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.complete_sale(text, text, text, jsonb, uuid, text, uuid) to authenticated;
