-- =====================================================================
-- SAM Inventory — migration 0006: exchange rate and clean reset
-- =====================================================================

create table public.app_settings (
  key text primary key,
  numeric_value numeric(18, 4) not null check (numeric_value > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

insert into public.app_settings (key, numeric_value)
values ('usd_to_syp_rate', 1)
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
grant select on public.app_settings to authenticated;

create policy app_settings_read on public.app_settings
  for select to authenticated
  using ((select public.app_role()) is not null);

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
      end;

  return p_rate;
end;
$$;

create or replace function public.clear_catalog_and_history()
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  perform public.require_role('admin');
  select count(*) into v_count from public.products;

  truncate table
    public.stock_movements,
    public.sale_items,
    public.sales,
    public.customers,
    public.kit_components,
    public.products
    restart identity cascade;

  update public.receipt_counter
  set last_number = 1000
  where singleton = true;
  return v_count;
end;
$$;

revoke all on function public.set_usd_to_syp_rate(numeric) from public, anon, authenticated;
grant execute on function public.set_usd_to_syp_rate(numeric) to authenticated;
revoke all on function public.clear_catalog_and_history() from public, anon, authenticated;
grant execute on function public.clear_catalog_and_history() to authenticated;
