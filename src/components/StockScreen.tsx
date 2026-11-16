'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRole } from '@/lib/auth';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Button, Card, Field, Input, Select, Spinner } from './ui';

type Location = { id: string; name_en: string; name_ar: string; sort_order: number };
type StockRow = { product_id: string; location: string; qty: number };

const EMPTY_FORM = { product: '', location: 'warehouse', from: 'warehouse', to: 'storage', qty: '', counted: '', note: '' };

export default function StockScreen() {
  const t = useTranslations('stock');
  const app = useTranslations('app');
  const role = useRole();
  const canWrite = role === 'admin' || role === 'warehouse';
  const [products, setProducts] = useState<Product[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const [productResult, locationResult, stockResult] = await Promise.all([
      fetchAllProducts(),
      sb.from('locations').select('id, name_en, name_ar, sort_order').order('sort_order'),
      sb.from('stock_view').select('product_id, location, qty'),
    ]);
    if (locationResult.error) throw locationResult.error;
    if (stockResult.error) throw stockResult.error;
    setProducts(productResult);
    setLocations((locationResult.data ?? []) as Location[]);
    setStock((stockResult.data ?? []) as StockRow[]);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const activeProducts = useMemo(() => (products ?? []).filter((p) => p.active), [products]);
  const saleProducts = useMemo(() => activeProducts.filter((p) => p.for_sale), [activeProducts]);
  const stockByProduct = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const row of stock ?? []) {
      if (!map.has(row.product_id)) map.set(row.product_id, new Map());
      map.get(row.product_id)!.set(row.location, row.qty);
    }
    return map;
  }, [stock]);

  function update(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function runAction(action: 'receive_stock' | 'transfer_stock' | 'stock_take') {
    setBusy(true);
    setError(null);
    setSuccess(null);
    const sb = getSupabase();
    const qty = Number(action === 'stock_take' ? form.counted : form.qty);
    const args =
      action === 'receive_stock'
        ? { p_product: form.product, p_location: form.location, p_qty: qty, p_note: form.note || null }
        : action === 'transfer_stock'
          ? { p_product: form.product, p_from: form.from, p_to: form.to, p_qty: qty, p_note: form.note || null }
          : { p_product: form.product, p_location: form.location, p_counted: qty, p_note: form.note || null };
    const { error: rpcError } = await sb.rpc(action, args);
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSuccess(t(`actions.${action}.success`));
    setForm((current) => ({ ...current, qty: '', counted: '', note: '' }));
    await load();
  }

  if (error && !products) return <Alert>{app('errorGeneric', { message: error })}</Alert>;
  if (!products || !locations || !stock) return <Spinner label={app('loading')} />;

  const locationName = (id: string) => {
    const location = locations.find((item) => item.id === id);
    return location ? (t('locationNames') === 'ar' ? location.name_ar : location.name_en) : id;
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('intro')}</p>
      </div>

      {role === 'sales' && <Alert tone="blue">{t('readOnly')}</Alert>}
      {error && <Alert>{app('errorGeneric', { message: error })}</Alert>}
      {success && <Alert tone="green">{success}</Alert>}

      {canWrite && (
        <div className="grid gap-4 lg:grid-cols-3">
          <ActionCard
            title={t('actions.receive_stock.title')}
            button={t('actions.receive_stock.button')}
            disabled={busy}
            onSubmit={() => void runAction('receive_stock')}
          >
            <ProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <LocationSelect locations={locations} value={form.location} onChange={(v) => update('location', v)} label={t('location')} />
            <Field label={t('quantity')}><Input type="number" min="1" step="1" value={form.qty} onChange={(e) => update('qty', e.target.value)} required /></Field>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>

          <ActionCard
            title={t('actions.transfer_stock.title')}
            button={t('actions.transfer_stock.button')}
            disabled={busy}
            onSubmit={() => void runAction('transfer_stock')}
          >
            <ProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <div className="grid grid-cols-2 gap-2">
              <LocationSelect locations={locations} value={form.from} onChange={(v) => update('from', v)} label={t('from')} />
              <LocationSelect locations={locations} value={form.to} onChange={(v) => update('to', v)} label={t('to')} />
            </div>
            <Field label={t('quantity')}><Input type="number" min="1" step="1" value={form.qty} onChange={(e) => update('qty', e.target.value)} required /></Field>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>

          <ActionCard
            title={t('actions.stock_take.title')}
            button={t('actions.stock_take.button')}
            disabled={busy}
            onSubmit={() => void runAction('stock_take')}
          >
            <ProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <LocationSelect locations={locations} value={form.location} onChange={(v) => update('location', v)} label={t('location')} />
            <Field label={t('counted')}><Input type="number" min="0" step="1" value={form.counted} onChange={(e) => update('counted', e.target.value)} required /></Field>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>
        </div>
      )}

      <Card className="overflow-x-auto">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="font-bold">{t('matrixTitle')}</h2>
        </div>
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-start text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5 text-start">{t('product')}</th>
              {locations.map((location) => <th key={location.id} className="px-3 py-2.5 text-end">{locationName(location.id)}</th>)}
              <th className="px-3 py-2.5 text-end">{t('total')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {saleProducts.map((product) => {
              const rows = stockByProduct.get(product.id);
              const quantities = locations.map((location) => rows?.get(location.id) ?? 0);
              const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
              return (
                <tr key={product.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{product.name_ar || product.name}</div>
                    <div className="font-mono text-xs text-slate-500">{product.item_code}</div>
                  </td>
                  {quantities.map((quantity, index) => (
                    <td key={locations[index].id} className={`px-3 py-2 text-end tabular-nums ${quantity === 0 ? 'bg-red-50 font-semibold text-red-700' : ''}`}>{quantity}</td>
                  ))}
                  <td className="px-3 py-2 text-end font-semibold tabular-nums">{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {saleProducts.length === 0 && <p className="p-6 text-center text-sm text-slate-500">{t('empty')}</p>}
      </Card>
    </div>
  );
}

function ActionCard({ title, button, disabled, onSubmit, children }: { title: string; button: string; disabled: boolean; onSubmit: () => void; children: React.ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-bold">{title}</h2>
      {children}
      <Button className="w-full" disabled={disabled} onClick={onSubmit}>{button}</Button>
    </Card>
  );
}

function ProductSelect({ products, value, onChange, label }: { products: Product[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">—</option>
        {products.map((product) => <option key={product.id} value={product.id}>{product.item_code} — {product.name_ar || product.name}</option>)}
      </Select>
    </Field>
  );
}

function LocationSelect({ locations, value, onChange, label }: { locations: Location[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name_ar} / {location.name_en}</option>)}
      </Select>
    </Field>
  );
}
