-- =====================================================================
-- SAM Inventory — migration 0007: limit stock takes to visible locations
-- =====================================================================

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

  if p_location not in ('display', 'storage') then
    raise exception 'invalid_location: stock takes are limited to display and storage';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'invalid_qty: counted quantity must be zero or more';
  end if;
  if not exists (select 1 from public.products where id = p_product and active) then
    raise exception 'unknown_product: %', p_product;
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
    'previous', v_current,
    'counted', p_counted,
    'delta', v_delta
  );
end;
$$;

revoke all on function public.stock_take(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.stock_take(uuid, text, integer, text) to authenticated;
