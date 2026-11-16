-- =====================================================================
-- SAM Inventory — migration 0004: catalog import
--
-- import_products(rows) merges a parsed CSV into the catalog in ONE
-- transaction (any bad row rolls the whole import back — nothing is half
-- saved). Match key: item_code.
--
-- Merge rule: a key that is ABSENT from a row's JSON is left untouched on
-- an existing product; a key that is PRESENT (even null) is written. So a
-- price-list import can refresh prices without wiping for_sale, barcode,
-- name_ar, etc. New products get column defaults for absent keys.
--
-- Row keys: item_code (required), name (required for new products),
--   name_ar, category, unit, specs, price_usd, price_syp,
--   wireless_price_usd, wireless_price_syp, for_sale, barcode
-- Returns {inserted, updated}.
-- =====================================================================

create or replace function public.import_products(p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r       jsonb;
  v_code  text;
  v_id    uuid;
  v_ins   integer := 0;
  v_upd   integer := 0;
  v_seen  text[]  := '{}';
begin
  perform public.require_role('admin');

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_rows: expected a JSON array';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_code := btrim(r ->> 'item_code');
    if v_code is null or v_code = '' then
      raise exception 'invalid_row: a row has no item_code';
    end if;
    if v_code = any (v_seen) then
      raise exception 'duplicate_code: % appears twice in the import', v_code;
    end if;
    v_seen := v_seen || v_code;

    select id into v_id from public.products where item_code = v_code;

    if v_id is null then
      if nullif(btrim(r ->> 'name'), '') is null then
        raise exception 'invalid_row: new product % has no name', v_code;
      end if;
      insert into public.products
        (item_code, name, name_ar, category, unit, specs,
         price_usd, price_syp, wireless_price_usd, wireless_price_syp, for_sale, barcode)
      values (
        v_code,
        btrim(r ->> 'name'),
        nullif(btrim(r ->> 'name_ar'), ''),
        nullif(btrim(r ->> 'category'), ''),
        coalesce(nullif(btrim(r ->> 'unit'), ''), 'قطعة'),
        nullif(btrim(r ->> 'specs'), ''),
        coalesce((r ->> 'price_usd')::numeric, 0),
        coalesce((r ->> 'price_syp')::numeric, 0),
        (r ->> 'wireless_price_usd')::numeric,
        (r ->> 'wireless_price_syp')::numeric,
        coalesce((r ->> 'for_sale')::boolean, false),
        nullif(btrim(r ->> 'barcode'), '')
      );
      v_ins := v_ins + 1;
    else
      update public.products set
        name      = case when r ? 'name'     and nullif(btrim(r ->> 'name'), '') is not null then btrim(r ->> 'name') else name end,
        name_ar   = case when r ? 'name_ar'  then nullif(btrim(r ->> 'name_ar'), '')  else name_ar  end,
        category  = case when r ? 'category' then nullif(btrim(r ->> 'category'), '') else category end,
        unit      = case when r ? 'unit'     and nullif(btrim(r ->> 'unit'), '') is not null then btrim(r ->> 'unit') else unit end,
        specs     = case when r ? 'specs'    then nullif(btrim(r ->> 'specs'), '')    else specs    end,
        price_usd = case when r ? 'price_usd' then coalesce((r ->> 'price_usd')::numeric, price_usd) else price_usd end,
        price_syp = case when r ? 'price_syp' then coalesce((r ->> 'price_syp')::numeric, price_syp) else price_syp end,
        wireless_price_usd = case when r ? 'wireless_price_usd' then (r ->> 'wireless_price_usd')::numeric else wireless_price_usd end,
        wireless_price_syp = case when r ? 'wireless_price_syp' then (r ->> 'wireless_price_syp')::numeric else wireless_price_syp end,
        for_sale  = case when r ? 'for_sale' then coalesce((r ->> 'for_sale')::boolean, for_sale) else for_sale end,
        barcode   = case when r ? 'barcode'  then nullif(btrim(r ->> 'barcode'), '')  else barcode  end
      where id = v_id;
      v_upd := v_upd + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_ins, 'updated', v_upd);
end;
$$;

-- New functions are executable by PUBLIC/anon by default: lock down, then grant.
revoke all on function public.import_products(jsonb) from public, anon, authenticated;
grant execute on function public.import_products(jsonb) to authenticated;
