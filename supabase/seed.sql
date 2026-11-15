-- =====================================================================
-- LOCAL DEVELOPMENT SEED — runs on `supabase db reset`, never on `db push`.
--
-- The real catalog (~90 products from the PDF price lists) was not attached
-- to the build request, so it is NOT seeded here: load it through the
-- Import screen (build step 2). The rows below are obvious placeholders
-- (DEMO- codes, round fake prices) so the UI has something to show.
-- Locations and the receipt counter are created by the migrations.
-- =====================================================================

insert into public.products
  (item_code, name, name_ar, category, unit, price_usd, price_syp, wireless_price_usd, wireless_price_syp, for_sale)
values
  ('DEMO-RTR-01', 'Demo Router',        'راوتر تجريبي',   'Routers',  'قطعة', 40, 600000, 36, 540000, true),
  ('DEMO-SFP-01', 'Demo SFP Module',    'وحدة SFP تجريبية', 'SFP',      'قطعة', 10, 150000, null, null,  true),
  ('DEMO-CBL-01', 'Demo Cable (Meter)', 'كبل تجريبي',     'Cables',   'متر',  1,  15000,  null, null,  false),
  ('DEMO-KIT-01', 'Demo Kit',           'طقم تجريبي',     'Kits',     'طقم',  55, 825000, 50, 750000, true),
  ('DEMO-KIT-01-A', 'Demo Kit Dish',    'صحن الطقم',      'Kits',     'قطعة', 0,  0,      null, null,  false);

insert into public.kit_components (kit_id, component_id, qty)
select k.id, c.id, 1
from public.products k, public.products c
where k.item_code = 'DEMO-KIT-01' and c.item_code = 'DEMO-KIT-01-A';
