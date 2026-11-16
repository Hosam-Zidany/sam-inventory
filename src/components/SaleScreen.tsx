'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatSyp, formatUsd } from '@/lib/format';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import { searchKey } from '@/lib/text';
import type { Product } from '@/lib/types';
import { Alert, Button, Card, Field, Input, Select, Spinner } from './ui';

type Location = { id: string; name_en: string; name_ar: string; sort_order: number };
type StockRow = { product_id: string; location: string; qty: number };
type CartLine = { product: Product; qty: number };
type SaleResult = { sale_id: string; receipt_number: string; total: number; currency: 'USD' | 'SYP'; created_at: string };

export default function SaleScreen() {
  const t = useTranslations('sale');
  const app = useTranslations('app');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'SYP'>('SYP');
  const [tier, setTier] = useState<'general' | 'wireless'>('general');
  const [soldFrom, setSoldFrom] = useState('display');
  const [customerName, setCustomerName] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [receipt, setReceipt] = useState<SaleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const [productRows, locationResult, stockResult] = await Promise.all([
      fetchAllProducts(),
      sb.from('locations').select('id, name_en, name_ar, sort_order').order('sort_order'),
      sb.from('stock_view').select('product_id, location, qty'),
    ]);
    if (locationResult.error) throw locationResult.error;
    if (stockResult.error) throw stockResult.error;
    setProducts(productRows.filter((product) => product.active && product.for_sale));
    setLocations((locationResult.data ?? []) as Location[]);
    setStock((stockResult.data ?? []) as StockRow[]);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const available = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of stock ?? []) {
      if (row.location === soldFrom) map.set(row.product_id, row.qty);
    }
    return map;
  }, [soldFrom, stock]);

  const results = useMemo(() => {
    const q = searchKey(query);
    return (products ?? [])
      .filter((product) => !q || searchKey([product.name, product.name_ar, product.item_code, product.barcode].filter(Boolean).join(' ')).includes(q))
      .slice(0, 30);
  }, [products, query]);

  const total = cart.reduce((sum, line) => sum + line.qty * priceFor(line.product, currency, tier), 0);

  function add(product: Product) {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => line.product.id === product.id ? { ...line, qty: line.qty + 1 } : line);
      return [...current, { product, qty: 1 }];
    });
    setQuery('');
  }

  function setQty(productId: string, qty: number) {
    setCart((current) => current.map((line) => line.product.id === productId ? { ...line, qty: Math.max(1, qty || 1) } : line));
  }

  async function completeSale() {
    if (cart.length === 0) {
      setError(t('emptyCart'));
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await getSupabase().rpc('complete_sale', {
      p_currency: currency,
      p_price_tier: tier,
      p_sold_from: soldFrom,
      p_items: cart.map((line) => ({ product_id: line.product.id, qty: line.qty })),
      p_customer_name: customerName.trim() || null,
      p_client_ref: crypto.randomUUID(),
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setReceipt(data as SaleResult);
    await load();
  }

  if (error && !products) return <Alert>{app('errorGeneric', { message: error })}</Alert>;
  if (!products || !locations || !stock) return <Spinner label={app('loading')} />;

  if (receipt) {
    const text = receiptText(receipt, cart, t);
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Card className="space-y-3 p-5 print:border-0 print:shadow-none">
          <h1 className="text-center text-xl font-bold">{t('receipt.title')}</h1>
          <div className="border-y border-dashed border-slate-300 py-3 text-sm">
            <p><strong>{t('receipt.number')}:</strong> <span className="ltr-field">{receipt.receipt_number}</span></p>
            <p><strong>{t('receipt.date')}:</strong> <span className="ltr-field">{new Date(receipt.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Damascus' })}</span></p>
          </div>
          <p className="text-center text-2xl font-bold ltr-field">{formatMoney(receipt.total, receipt.currency)}</p>
          <p className="text-center text-sm text-slate-500">{t('receipt.thanks')}</p>
        </Card>
        <div className="flex gap-2 print:hidden">
          <Button className="flex-1" onClick={() => window.print()}>{t('receipt.print')}</Button>
          <a className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">{t('receipt.whatsapp')}</a>
        </div>
        <Button
          variant="secondary"
          className="w-full print:hidden"
          onClick={() => {
            setReceipt(null);
            setCart([]);
            setCustomerName('');
          }}
        >
          {t('newSale')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {error && <Alert>{app('errorGeneric', { message: error })}</Alert>}
      <Card className="grid gap-3 p-3 sm:grid-cols-3">
        <Field label={t('currency')}><Select value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'SYP')}><option value="SYP">SYP</option><option value="USD">USD</option></Select></Field>
        <Field label={t('tier')}><Select value={tier} onChange={(e) => setTier(e.target.value as 'general' | 'wireless')}><option value="general">{t('general')}</option><option value="wireless">{t('wireless')}</option></Select></Field>
        <Field label={t('soldFrom')}><Select value={soldFrom} onChange={(e) => setSoldFrom(e.target.value)}>{locations.map((location) => <option key={location.id} value={location.id}>{location.name_ar} / {location.name_en}</option>)}</Select></Field>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <Card className="space-y-3 p-4">
          <Field label={t('search')}><Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchHint')} /></Field>
          <div className="space-y-2">
            {results.map((product) => {
              const quantity = available.get(product.id) ?? 0;
              return (
                <button key={product.id} type="button" disabled={quantity <= 0} onClick={() => add(product)} className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-slate-200 p-3 text-start hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                  <span className="min-w-0 flex-1"><span className="block font-medium">{product.name_ar || product.name}</span><span className="block font-mono text-xs text-slate-500">{product.item_code} · {t('available')}: {quantity}</span></span>
                  <span className="ltr-field text-sm font-semibold">{formatMoney(priceFor(product, currency, tier), currency)}</span>
                </button>
              );
            })}
            {results.length === 0 && <p className="p-4 text-center text-sm text-slate-500">{t('noResults')}</p>}
          </div>
        </Card>

        <Card className="h-fit space-y-3 p-4">
          <h2 className="font-bold">{t('cart')}</h2>
          {cart.map((line) => (
            <div key={line.product.id} className="border-b border-slate-100 pb-3">
              <div className="flex items-start gap-2"><span className="min-w-0 flex-1 text-sm font-medium">{line.product.name_ar || line.product.name}</span><button type="button" className="text-xs text-red-600" onClick={() => setCart((current) => current.filter((item) => item.product.id !== line.product.id))}>{t('remove')}</button></div>
              <div className="mt-2 flex items-center gap-2"><Input className="w-24" type="number" min="1" max={available.get(line.product.id) ?? 1} value={line.qty} onChange={(e) => setQty(line.product.id, Number(e.target.value))} /><span className="ms-auto ltr-field text-sm font-semibold">{formatMoney(line.qty * priceFor(line.product, currency, tier), currency)}</span></div>
            </div>
          ))}
          {cart.length === 0 && <p className="text-sm text-slate-500">{t('emptyCart')}</p>}
          <Field label={t('customer')}><Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></Field>
          <div className="flex items-center justify-between border-t border-slate-200 pt-3"><span className="font-bold">{t('total')}</span><span className="ltr-field text-xl font-bold">{formatMoney(total, currency)}</span></div>
          <Button className="w-full" disabled={busy || cart.length === 0} onClick={() => void completeSale()}>{busy ? t('saving') : t('complete')}</Button>
        </Card>
      </div>
    </div>
  );
}

function priceFor(product: Product, currency: 'USD' | 'SYP', tier: 'general' | 'wireless') {
  if (currency === 'USD') return tier === 'wireless' ? (product.wireless_price_usd ?? product.price_usd) : product.price_usd;
  return tier === 'wireless' ? (product.wireless_price_syp ?? product.price_syp) : product.price_syp;
}

function formatMoney(value: number, currency: 'USD' | 'SYP') {
  return currency === 'USD' ? `${formatUsd(value)} USD` : `${formatSyp(value)} SYP`;
}

function receiptText(receipt: SaleResult, cart: CartLine[], t: ReturnType<typeof useTranslations<'sale'>>) {
  return [
    'SAM Company',
    `${t('receipt.number')}: ${receipt.receipt_number}`,
    ...cart.map((line) => `${line.product.name_ar || line.product.name} × ${line.qty}`),
    `${t('total')}: ${formatMoney(receipt.total, receipt.currency)}`,
  ].join('\n');
}
