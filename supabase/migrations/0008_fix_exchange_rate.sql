-- =====================================================================
-- SAM Inventory — migration 0008: exchange-rate update compatibility
-- =====================================================================

create or replace function public.set_usd_to_syp_rate(p_rate numeric)
returns numeric
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.require_role('admin');
  if p_rate is null or p_rate <= 0 then
    raise exception 'invalid_rate: exchange rate must be greater than zero';
  end if;

  update public.app_settings
  set numeric_value = p_rate, updated_at = now(), updated_by = auth.uid()
  where key = 'usd_to_syp_rate';

  update public.products
  set price_syp = round(price_usd * p_rate),
      wireless_price_syp = case
        when wireless_price_usd is null then null
        else round(wireless_price_usd * p_rate)
      end
  where true;

  return p_rate;
end;
$$;

revoke all on function public.set_usd_to_syp_rate(numeric) from public, anon, authenticated;
grant execute on function public.set_usd_to_syp_rate(numeric) to authenticated;
