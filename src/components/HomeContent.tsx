'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth, useRole } from '@/lib/auth';
import { formatSyp, formatUsd } from '@/lib/format';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Badge, Button, Card, Spinner } from './ui';

type StockRow = { product_id: string; location: string; qty: number };
type SaleRow = { receipt_number: string; total: number; currency: 'USD' | 'SYP'; created_at: string; status: string };
type MovementRow = { product_id: string; type: string; qty: number; from_location: string | null; to_location: string | null; created_at: string };

export default function HomeContent() {
  const t = useTranslations('home');
  const app = useTranslations('app');
  const role = useRole();
  const { state } = useAuth();
  const name = state.status === 'ready' ? (state.fullName ?? state.user.email) : '';
  const [products, setProducts] = useState<Product[] | null>(null);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [productRows, stockResult, salesResult] = await Promise.all([
      fetchAllProducts(),
      sb.from('stock_view').select('product_id, location, qty'),
      sb.from('sales').select('receipt_number, total, currency, created_at, status').gte('created_at', since).order('created_at', { ascending: false }).limit(50),
    ]);
    if (stockResult.error) throw stockResult.error;
    if (salesResult.error) throw salesResult.error;
    setProducts(productRows);
    setStock((stockResult.data ?? []) as StockRow[]);
    setSales((salesResult.data ?? []) as SaleRow[]);

    if (role === 'admin' || role === 'warehouse') {
      const movementResult = await sb
        .from('stock_movements')
        .select('product_id, type, qty, from_location, to_location, created_at')
        .order('created_at', { ascending: false })
        .limit(8);
      if (movementResult.error) throw movementResult.error;
      setMovements((movementResult.data ?? []) as MovementRow[]);
    }
  }, [role]);

  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const stockTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of stock ?? []) totals.set(row.product_id, (totals.get(row.product_id) ?? 0) + row.qty);
    return totals;
  }, [stock]);
  const active = (products ?? []).filter((product) => product.active);
  const forSale = active.filter((product) => product.for_sale);
  const lowStock = forSale.filter((product) => (stockTotals.get(product.id) ?? 0) <= product.reorder_level);
  const salesUsd = sales.filter((sale) => sale.currency === 'USD').reduce((sum, sale) => sum + sale.total, 0);
  const salesSyp = sales.filter((sale) => sale.currency === 'SYP').reduce((sum, sale) => sum + sale.total, 0);
  const totalUnits = [...stockTotals.values()].reduce((sum, quantity) => sum + quantity, 0);
  const productName = (id: string) => {
    const product = products?.find((item) => item.id === id);
    return product?.name_ar || product?.name || id;
  };

  if (error) return <Alert>{app('errorGeneric', { message: error })}</Alert>;
  if (!products || !stock) return <Spinner label={app('loading')} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="me-auto">
          <h1 className="text-2xl font-bold">{t('welcome')} {name}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
        </div>
        {(role === 'admin' || role === 'sales') && <Link href="/sale"><Button>{t('newSale')}</Button></Link>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('stats.products')} value={active.length} />
        <Stat label={t('stats.forSale')} value={forSale.length} />
        <Stat label={t('stats.units')} value={totalUnits} />
        <Stat label={t('stats.sales')} value={sales.length} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">{t('lowStock')}</h2><Badge tone={lowStock.length ? 'amber' : 'green'}>{lowStock.length}</Badge></div>
          {lowStock.length === 0 ? <p className="text-sm text-slate-500">{t('noLowStock')}</p> : <div className="space-y-2">{lowStock.slice(0, 10).map((product) => <div key={product.id} className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-sm"><span>{product.name_ar || product.name}</span><strong className="ltr-field text-amber-800">{stockTotals.get(product.id) ?? 0}</strong></div>)}</div>}
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 font-bold">{t('todaySales')}</h2>
          <div className="grid grid-cols-2 gap-3"><Stat label="USD" value={formatUsd(salesUsd)} /><Stat label="SYP" value={formatSyp(salesSyp)} /></div>
          {sales.length > 0 && <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">{sales.slice(0, 5).map((sale) => <div key={sale.receipt_number} className="flex justify-between text-sm"><span className="ltr-field">{sale.receipt_number}</span><span className="ltr-field">{sale.currency === 'USD' ? formatUsd(sale.total) : formatSyp(sale.total)} {sale.currency}</span></div>)}</div>}
        </Card>
      </div>

      {(role === 'admin' || role === 'warehouse') && (
        <Card className="p-4">
          <h2 className="mb-3 font-bold">{t('recentMovements')}</h2>
          {movements.length === 0 ? <p className="text-sm text-slate-500">{t('noMovements')}</p> : <div className="space-y-2">{movements.map((movement, index) => <div key={`${movement.product_id}-${movement.created_at}-${index}`} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 pb-2 text-sm"><span>{productName(movement.product_id)}</span><span className="text-slate-500">{movement.type} · {movement.qty}</span></div>)}</div>}
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-xl font-bold ltr-field">{value}</div></div>;
}
