export type Role = 'admin' | 'sales' | 'warehouse';

export interface Product {
  id: string;
  item_code: string;
  name: string;
  name_ar: string | null;
  category: string | null;
  unit: string;
  specs: string | null;
  price_usd: number;
  price_syp: number;
  wireless_price_usd: number | null;
  wireless_price_syp: number | null;
  cost_usd: number | null;
  for_sale: boolean;
  barcode: string | null;
  reorder_level: number;
  active: boolean;
  created_at: string;
}
