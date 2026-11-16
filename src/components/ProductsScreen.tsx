'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRole } from '@/lib/auth';
import { formatSyp, formatUsd } from '@/lib/format';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import { searchKey } from '@/lib/text';
import type { Product } from '@/lib/types';
import ProductForm from './ProductForm';
import { Alert, Badge, Button, Card, Input, Modal, Select, Spinner, Switch } from './ui';

export default function ProductsScreen() {
  const t = useTranslations('products');
  const app = useTranslations('app');
  const isAdmin = useRole() === 'admin';

  const [products, setProducts] = useState<Product[] | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const load = useCallback(async () => {
    try {
      const sb = getSupabase();
      const [productRows, rateResult] = await Promise.all([
        fetchAllProducts(),
        sb.from('app_settings').select('numeric_value').eq('key', 'usd_to_syp_rate').single(),
      ]);
      if (rateResult.error) throw rateResult.error;
      setProducts(productRows);
      setExchangeRate(Number(rateResult.data.numeric_value));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set((products ?? []).map((p) => p.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [products],
  );

  // Pre-computed search text so typing stays instant with ~1,000 products.
  const indexed = useMemo(
    () =>
      (products ?? []).map((p) => ({
        p,
        key: searchKey([p.name, p.name_ar, p.item_code, p.barcode, p.specs].filter(Boolean).join(' ')),
      })),
    [products],
  );

  const visible = useMemo(() => {
    const q = searchKey(deferredQuery);
    return indexed
      .filter(({ p, key }) => (p.active || (isAdmin && showDeleted)) && (!category || p.category === category) && (!q || key.includes(q)))
      .map(({ p }) => p);
  }, [indexed, deferredQuery, category, showDeleted, isAdmin]);

  const totalActive = (products ?? []).filter((p) => p.active).length;

  async function patch(p: Product, change: Partial<Product>, failKey: 'toggleFailed' | 'errorGeneric' = 'errorGeneric') {
    setActionError(null);
    const { error } = await getSupabase().from('products').update(change).eq('id', p.id);
    if (error) {
      setActionError(failKey === 'toggleFailed' ? t('toggleFailed', { message: error.message }) : app('errorGeneric', { message: error.message }));
      return;
    }
    // optimistic local update; the server stays the source of truth on next load
    setProducts((cur) => cur?.map((x) => (x.id === p.id ? { ...x, ...change } : x)) ?? cur);
  }

  if (loadError) return <Alert>{app('errorGeneric', { message: loadError })}</Alert>;
  if (!products || exchangeRate == null) return <Spinner label={app('loading')} />;

  async function changeRate() {
    const raw = window.prompt(t('exchangeRatePrompt'), String(exchangeRate));
    if (raw === null) return;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) {
      setActionError(t('badExchangeRate'));
      return;
    }
    const { error } = await getSupabase().rpc('set_usd_to_syp_rate', { p_rate: rate });
    if (error) {
      setActionError(app('errorGeneric', { message: error.message }));
      return;
    }
    await load();
  }

  async function clearCatalog() {
    if (!window.confirm(t('clearConfirm'))) return;
    setActionError(null);
    const { data, error } = await getSupabase().rpc('clear_catalog_and_history');
    if (error) {
      setActionError(app('errorGeneric', { message: error.message }));
      return;
    }
    setProducts([]);
    setActionError(t('clearDone', { count: data }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">{t('title')}</h1>
        {isAdmin && (
          <>
            <Button variant="secondary" onClick={() => void changeRate()}>{t('exchangeRate', { rate: exchangeRate })}</Button>
            <Button variant="danger" onClick={() => void clearCatalog()}>{t('clearCatalog')}</Button>
            <Button onClick={() => setEditing('new')}>{t('add')}</Button>
          </>
        )}
      </div>

      {!isAdmin && <Alert tone="blue">{t('readOnly')}</Alert>}

      <Card className="grid gap-3 p-3 sm:grid-cols-[1fr_14rem_auto] sm:items-center">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
        />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('cols.category')}>
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        {isAdmin && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-5" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            {t('showDeleted')}
          </label>
        )}
      </Card>

      {actionError && <Alert>{actionError}</Alert>}

      <p className="text-sm text-slate-500">{t('count', { shown: visible.length, total: totalActive })}</p>

      {visible.length === 0 ? (
        <Card className="p-8 text-center text-slate-500">{totalActive === 0 ? t('emptyCatalog') : t('empty')}</Card>
      ) : (
        <>
          {/* Desktop / tablet: table */}
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-start text-xs font-semibold text-slate-600">
                <tr>
                  <Th>{t('cols.code')}</Th>
                  <Th>{t('cols.name')}</Th>
                  <Th>{t('cols.category')}</Th>
                  <Th>{t('cols.unit')}</Th>
                  <Th>{t('cols.usd')}</Th>
                  <Th>{t('cols.syp')}</Th>
                  <Th>{t('cols.wirelessUsd')}</Th>
                  <Th>{t('cols.wirelessSyp')}</Th>
                  <Th>{t('cols.forSale')}</Th>
                  {isAdmin && <Th>{t('cols.actions')}</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'bg-slate-50 text-slate-400'}>
                    <td className="ltr-field whitespace-nowrap px-3 py-2 font-mono text-xs">{p.item_code}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name_ar || p.name}</div>
                      {p.name_ar && <div className="ltr-field text-xs text-slate-500">{p.name}</div>}
                    </td>
                    <td className="px-3 py-2">{p.category ?? '—'}</td>
                    <td className="px-3 py-2">{p.unit}</td>
                    <td className="ltr-field px-3 py-2 text-end tabular-nums">{formatUsd(p.price_usd)}</td>
                    <td className="ltr-field px-3 py-2 text-end tabular-nums">{formatSyp(p.price_syp)}</td>
                    <td className="ltr-field px-3 py-2 text-end tabular-nums">{p.wireless_price_usd == null ? '—' : formatUsd(p.wireless_price_usd)}</td>
                    <td className="ltr-field px-3 py-2 text-end tabular-nums">{p.wireless_price_syp == null ? '—' : formatSyp(p.wireless_price_syp)}</td>
                    <td className="px-3 py-2">
                      <ForSaleCell p={p} isAdmin={isAdmin} onToggle={(v) => patch(p, { for_sale: v }, 'toggleFailed')} />
                    </td>
                    {isAdmin && (
                      <td className="whitespace-nowrap px-3 py-2">
                        <RowActions p={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} onRestore={() => patch(p, { active: true })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Phone: cards */}
          <div className="space-y-2 md:hidden">
            {visible.map((p) => (
              <Card key={p.id} className={p.active ? 'p-3' : 'bg-slate-50 p-3 text-slate-400'}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name_ar || p.name}</div>
                    {p.name_ar && <div className="ltr-field truncate text-xs text-slate-500">{p.name}</div>}
                    <div className="ltr-field mt-0.5 font-mono text-xs text-slate-500">{p.item_code}</div>
                  </div>
                  <ForSaleCell p={p} isAdmin={isAdmin} onToggle={(v) => patch(p, { for_sale: v }, 'toggleFailed')} />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <Price label={t('cols.usd')} value={formatUsd(p.price_usd)} />
                  <Price label={t('cols.syp')} value={formatSyp(p.price_syp)} />
                  {p.wireless_price_usd != null && <Price label={t('cols.wirelessUsd')} value={formatUsd(p.wireless_price_usd)} />}
                  {p.wireless_price_syp != null && <Price label={t('cols.wirelessSyp')} value={formatSyp(p.wireless_price_syp)} />}
                </dl>
                {isAdmin && (
                  <div className="mt-2 flex justify-end gap-1">
                    <RowActions p={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} onRestore={() => patch(p, { active: true })} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          categories={categories}
          exchangeRate={exchangeRate}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t('deleteTitle')}>
        {deleting && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">{t('deleteBody', { name: deleting.name_ar || deleting.name })}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                {app('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const p = deleting;
                  setDeleting(null);
                  await patch(p, { active: false, for_sale: false });
                }}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => <th className="whitespace-nowrap px-3 py-2.5 text-start">{children}</th>;

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="ltr-field font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function ForSaleCell({ p, isAdmin, onToggle }: { p: Product; isAdmin: boolean; onToggle: (next: boolean) => void }) {
  const t = useTranslations('products');
  if (!p.active) return <Badge tone="red">{t('deleted')}</Badge>;
  if (isAdmin) return <Switch checked={p.for_sale} onChange={onToggle} label={`${t('cols.forSale')}: ${p.item_code}`} />;
  return p.for_sale ? <Badge tone="green">{t('forSale')}</Badge> : <Badge>{t('notForSale')}</Badge>;
}

function RowActions({ p, onEdit, onDelete, onRestore }: { p: Product; onEdit: () => void; onDelete: () => void; onRestore: () => void }) {
  const t = useTranslations('products');
  return p.active ? (
    <>
      <Button variant="ghost" className="px-3" onClick={onEdit}>
        {t('edit')}
      </Button>
      <Button variant="ghost" className="px-3 text-red-600" onClick={onDelete}>
        {t('delete')}
      </Button>
    </>
  ) : (
    <Button variant="ghost" className="px-3" onClick={onRestore}>
      {t('restore')}
    </Button>
  );
}
