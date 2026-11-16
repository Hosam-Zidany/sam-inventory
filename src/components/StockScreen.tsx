'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRole } from '@/lib/auth';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Button, Card, Field, Input, Select, Spinner } from './ui';

type Location = { id: string; name_en: string; name_ar: string; sort_order: number };
type StockRow = { product_id: string; location: string; qty: number };

const EMPTY_FORM = {
  product: '',
  location: 'warehouse',
  from: 'warehouse',
  to: 'storage',
  qty: '',
  counted: '',
  receiveTotal: '',
  receiveDisplay: '',
  receiveWarehouse: '',
  note: '',
};

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
  const visibleLocations = useMemo(() => locations?.filter((location) => location.id !== 'warehouse') ?? [], [locations]);

  function update(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateReceiveTotal(value: string) {
    const total = Number(value);
    const display = Number.isFinite(total) && total > 0 ? Math.min(1, Math.floor(total)) : 0;
    setForm((current) => ({
      ...current,
      receiveTotal: value,
      receiveDisplay: display ? String(display) : '',
      receiveWarehouse: display ? String(Math.max(0, Math.floor(total) - display)) : '',
    }));
  }

  async function runAction(action: 'receive_stock' | 'transfer_stock' | 'return_stock' | 'stock_take') {
    setBusy(true);
    setError(null);
    setSuccess(null);
    const sb = getSupabase();
    let rpcError: { message: string } | null = null;
    if (action === 'receive_stock') {
      const total = Number(form.receiveTotal);
      const display = Number(form.receiveDisplay);
      const warehouse = Number(form.receiveWarehouse);
      if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(display) || !Number.isInteger(warehouse) || display < 0 || warehouse < 0 || display + warehouse !== total) {
        setBusy(false);
        setError(t('receiveAllocationError'));
        return;
      }
      for (const [location, qty] of [['display', display], ['warehouse', warehouse]] as const) {
        if (qty === 0) continue;
        const result = await sb.rpc('receive_stock', {
          p_product: form.product,
          p_location: location,
          p_qty: qty,
          p_note: form.note || null,
        });
        if (result.error) {
          rpcError = result.error;
          break;
        }
      }
    } else {
      const qty = Number(action === 'stock_take' ? form.counted : form.qty);
      const args =
        action === 'transfer_stock' || action === 'return_stock'
          ? { p_product: form.product, p_from: form.from, p_to: action === 'return_stock' ? 'warehouse' : form.to, p_qty: qty, p_note: form.note || null }
          : { p_product: form.product, p_location: form.location, p_counted: qty, p_note: form.note || null };
      rpcError = (await sb.rpc(action, args)).error;
    }
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSuccess(t(`actions.${action}.success`));
    setForm((current) => ({ ...current, qty: '', counted: '', receiveTotal: '', receiveDisplay: '', receiveWarehouse: '', note: '' }));
    await load();
  }

  if (error && !products) return <Alert>{app('errorGeneric', { message: error })}</Alert>;
  if (!products || !locations || !stock) return <Spinner label={app('loading')} />;

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
            <SearchableProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <Field label={t('quantity')}><Input type="number" min="1" step="1" value={form.receiveTotal} onChange={(e) => updateReceiveTotal(e.target.value)} required /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('displayQuantity')}><Input type="number" min="0" step="1" value={form.receiveDisplay} onChange={(e) => update('receiveDisplay', e.target.value)} /></Field>
              <Field label={t('warehouseQuantity')}><Input type="number" min="0" step="1" value={form.receiveWarehouse} onChange={(e) => update('receiveWarehouse', e.target.value)} /></Field>
            </div>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>

          <ActionCard
            title={t('actions.transfer_stock.title')}
            button={t('actions.transfer_stock.button')}
            disabled={busy}
            onSubmit={() => void runAction('return_stock')}
          >
            <SearchableProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <div className="grid grid-cols-2 gap-2">
              <LocationSelect locations={locations} value={form.from} onChange={(v) => update('from', v)} label={t('from')} />
              <LocationSelect locations={locations} value={form.to} onChange={(v) => update('to', v)} label={t('to')} />
            </div>
            <Field label={t('quantity')}><Input type="number" min="1" step="1" value={form.qty} onChange={(e) => update('qty', e.target.value)} required /></Field>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>

          <ActionCard
            title={t('actions.return_stock.title')}
            button={t('actions.return_stock.button')}
            disabled={busy}
            onSubmit={() => void runAction('transfer_stock')}
          >
            <SearchableProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <LocationSelect locations={visibleLocations} value={form.from === 'warehouse' ? 'display' : form.from} onChange={(v) => update('from', v)} label={t('from')} />
            <Field label={t('quantity')}><Input type="number" min="1" step="1" value={form.qty} onChange={(e) => update('qty', e.target.value)} required /></Field>
            <p className="text-xs text-slate-500">{t('returnDestination')}</p>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>

          <ActionCard
            title={t('actions.stock_take.title')}
            button={t('actions.stock_take.button')}
            disabled={busy}
            onSubmit={() => void runAction('stock_take')}
          >
            <SearchableProductSelect products={activeProducts} value={form.product} onChange={(v) => update('product', v)} label={t('product')} />
            <LocationSelect locations={visibleLocations} value={form.location === 'warehouse' ? 'display' : form.location} onChange={(v) => update('location', v)} label={t('location')} />
            <Field label={t('counted')}><Input type="number" min="0" step="1" value={form.counted} onChange={(e) => update('counted', e.target.value)} required /></Field>
            <Field label={t('note')}><Input value={form.note} onChange={(e) => update('note', e.target.value)} /></Field>
          </ActionCard>
        </div>
      )}

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

function SearchableProductSelect({ products, value, onChange, label }: { products: Product[]; value: string; onChange: (value: string) => void; label: string }) {
  const [query, setQuery] = useState('');
  const selected = products.find((product) => product.id === value);
  const filtered = products
    .filter((product) => `${product.item_code} ${product.name} ${product.name_ar ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, 12);
  return (
    <Field label={label}>
      <Input value={selected ? `${selected.item_code} — ${selected.name_ar || selected.name}` : query} onChange={(e) => { onChange(''); setQuery(e.target.value); }} placeholder={label} required={!value} />
      {!value && query && (
        <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          {filtered.map((product) => (
            <button type="button" key={product.id} className="block min-h-11 w-full px-3 text-start text-sm hover:bg-slate-50" onClick={() => { onChange(product.id); setQuery(''); }}>
              {product.item_code} — {product.name_ar || product.name}
            </button>
          ))}
          {filtered.length === 0 && <p className="p-3 text-xs text-slate-500">—</p>}
        </div>
      )}
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
