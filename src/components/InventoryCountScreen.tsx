'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Button, Card, Field, Input, Select, Spinner } from './ui';

type StockRow = { product_id: string; location: string; qty: number };

export default function InventoryCountScreen() {
  const t = useTranslations('inventory');
  const app = useTranslations('app');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [location, setLocation] = useState<'display' | 'storage'>('display');
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const [productRows, stockResult] = await Promise.all([
      fetchAllProducts(),
      sb.from('stock_view').select('product_id, location, qty'),
    ]);
    if (stockResult.error) throw stockResult.error;
    setProducts(productRows.filter((product) => product.active));
    setStock((stockResult.data ?? []) as StockRow[]);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const quantities = useMemo(() => {
    const map = new Map<string, { display: number; storage: number }>();
    for (const row of stock ?? []) {
      const current = map.get(row.product_id) ?? { display: 0, storage: 0 };
      if (row.location === 'display' || row.location === 'storage') current[row.location] = row.qty;
      map.set(row.product_id, current);
    }
    return map;
  }, [stock]);

  const visibleProducts = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (products ?? []).filter((product) => {
      const current = quantities.get(product.id) ?? { display: 0, storage: 0 };
      return current.display + current.storage > 0 && (!q || `${product.item_code} ${product.name} ${product.name_ar ?? ''}`.toLocaleLowerCase().includes(q));
    });
  }, [products, quantities, query]);

  async function saveCount() {
    const value = Number(counted);
    if (!selected || !Number.isInteger(value) || value < 0) {
      setError(t('invalidCount'));
      return;
    }
    const { error: rpcError } = await getSupabase().rpc('stock_take', {
      p_product: selected,
      p_location: location,
      p_counted: value,
      p_note: 'Inventory count',
    });
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSuccess(t('saved'));
    setCounted('');
    await load();
  }

  if (!products || !stock) return <Spinner label={app('loading')} />;
  const selectedProduct = products.find((product) => product.id === selected);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="me-auto"><h1 className="text-2xl font-bold">{t('title')}</h1><p className="mt-1 text-sm text-slate-500">{t('intro')}</p></div>
        <Button variant="secondary" onClick={() => window.print()}>{t('print')}</Button>
      </div>
      {error && <Alert>{app('errorGeneric', { message: error })}</Alert>}
      {success && <Alert tone="green">{success}</Alert>}

      <Card className="grid gap-3 p-4 md:grid-cols-[1fr_auto_auto_auto] print:hidden">
        <Field label={t('searchProduct')}><Input value={query} onChange={(e) => { setQuery(e.target.value); setSelected(''); }} placeholder={t('searchHint')} /></Field>
        <Field label={t('location')}><Select value={location} onChange={(e) => setLocation(e.target.value as 'display' | 'storage')}><option value="display">{t('display')}</option><option value="storage">{t('storage')}</option></Select></Field>
        <Field label={t('counted')}><Input type="number" min="0" step="1" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
        <Button className="self-end" onClick={() => void saveCount()}>{t('saveCount')}</Button>
      </Card>
      {!selected && query && <Card className="max-h-48 overflow-y-auto print:hidden">{visibleProducts.slice(0, 20).map((product) => <button key={product.id} type="button" className="block min-h-11 w-full border-b border-slate-100 px-3 text-start text-sm hover:bg-slate-50" onClick={() => { setSelected(product.id); setQuery(`${product.item_code} — ${product.name_ar || product.name}`); }}>{product.item_code} — {product.name_ar || product.name}</button>)}</Card>}
      {selectedProduct && <p className="text-sm print:hidden">{t('selected')}: <strong>{selectedProduct.name_ar || selectedProduct.name}</strong></p>}

      <Card className="overflow-x-auto">
        <h2 className="border-b border-slate-200 px-4 py-3 font-bold">{t('fullCount')}</h2>
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-start text-xs font-semibold"><tr><th className="px-3 py-2 text-start">{t('product')}</th><th className="px-3 py-2 text-end">{t('total')}</th><th className="px-3 py-2 text-end">{t('display')}</th><th className="px-3 py-2 text-end">{t('storage')}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{visibleProducts.map((product) => { const q = quantities.get(product.id) ?? { display: 0, storage: 0 }; return <tr key={product.id}><td className="px-3 py-2"><div>{product.name_ar || product.name}</div><div className="font-mono text-xs text-slate-500">{product.item_code}</div></td><td className="px-3 py-2 text-end font-semibold">{q.display + q.storage}</td><td className="px-3 py-2 text-end">{q.display}</td><td className="px-3 py-2 text-end">{q.storage}</td></tr>; })}</tbody>
        </table>
        {visibleProducts.length === 0 && <p className="p-6 text-center text-sm text-slate-500">{t('empty')}</p>}
      </Card>
    </div>
  );
}
