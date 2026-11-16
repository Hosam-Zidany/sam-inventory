'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { errorMessage, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Button, Field, Input, Modal, Switch } from './ui';

interface Props {
  /** null = add a new product */
  product: Product | null;
  categories: string[];
  exchangeRate: number;
  onClose: () => void;
  onSaved: () => void;
}

type FormState = {
  item_code: string;
  name: string;
  name_ar: string;
  category: string;
  unit: string;
  specs: string;
  price_usd: string;
  price_syp: string;
  wireless_price_usd: string;
  wireless_price_syp: string;
  barcode: string;
  for_sale: boolean;
};

const initial = (p: Product | null): FormState => ({
  item_code: p?.item_code ?? '',
  name: p?.name ?? '',
  name_ar: p?.name_ar ?? '',
  category: p?.category ?? '',
  unit: p?.unit ?? 'قطعة',
  specs: p?.specs ?? '',
  price_usd: p ? String(p.price_usd) : '0',
  price_syp: p ? String(p.price_syp) : '0',
  wireless_price_usd: p?.wireless_price_usd != null ? String(p.wireless_price_usd) : '',
  wireless_price_syp: p?.wireless_price_syp != null ? String(p.wireless_price_syp) : '',
  barcode: p?.barcode ?? '',
  for_sale: p?.for_sale ?? false,
});

const isNumber = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

export default function ProductForm({ product, categories, exchangeRate, onClose, onSaved }: Props) {
  const t = useTranslations('products.form');
  const app = useTranslations('app');
  const [f, setF] = useState<FormState>(() => initial(product));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof FormState, v: string | boolean) =>
    setF((s) => {
      if (k === 'for_sale') return { ...s, for_sale: Boolean(v) };
      const text = typeof v === 'string' ? v : String(v);
      if (k === 'price_usd') {
        const usd = Number(text);
        return { ...s, price_usd: text, price_syp: Number.isFinite(usd) ? String(Math.round(usd * exchangeRate)) : s.price_syp };
      }
      if (k === 'wireless_price_usd') {
        const usd = Number(text);
        return {
          ...s,
          wireless_price_usd: text,
          wireless_price_syp: text === '' ? '' : Number.isFinite(usd) ? String(Math.round(usd * exchangeRate)) : s.wireless_price_syp,
        };
      }
      return { ...s, [k]: text };
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!f.item_code.trim()) errs.item_code = t('required');
    if (!f.name.trim()) errs.name = t('required');
    if (!isNumber(f.price_usd)) errs.price_usd = t('badNumber');
    if (!isNumber(f.price_syp)) errs.price_syp = t('badNumber');
    if (f.wireless_price_usd.trim() && !isNumber(f.wireless_price_usd)) errs.wireless_price_usd = t('badNumber');
    if (f.wireless_price_syp.trim() && !isNumber(f.wireless_price_syp)) errs.wireless_price_syp = t('badNumber');
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const row = {
      item_code: f.item_code.trim(),
      name: f.name.trim(),
      name_ar: f.name_ar.trim() || null,
      category: f.category.trim() || null,
      unit: f.unit.trim() || 'قطعة',
      specs: f.specs.trim() || null,
      price_usd: Number(f.price_usd),
      price_syp: Math.round(Number(f.price_syp)),
      wireless_price_usd: f.wireless_price_usd.trim() ? Number(f.wireless_price_usd) : null,
      wireless_price_syp: f.wireless_price_syp.trim() ? Math.round(Number(f.wireless_price_syp)) : null,
      barcode: f.barcode.trim() || null,
      for_sale: f.for_sale,
    };

    setBusy(true);
    setServerError(null);
    const sb = getSupabase();
    const { error } = product
      ? await sb.from('products').update(row).eq('id', product.id)
      : await sb.from('products').insert(row);
    setBusy(false);

    if (error) {
      if (error.code === '23505') {
        const m = error.message;
        if (m.includes('barcode')) setErrors({ barcode: t('barcodeTaken') });
        else setErrors({ item_code: t('codeTaken') });
        return;
      }
      setServerError(errorMessage(error));
      return;
    }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={product ? t('editTitle') : t('addTitle')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('itemCode')} error={errors.item_code}>
            <Input value={f.item_code} onChange={(e) => set('item_code', e.target.value)} className="ltr-field" required />
          </Field>
          <Field label={t('category')}>
            <Input value={f.category} onChange={(e) => set('category', e.target.value)} list="sam-categories" />
            <datalist id="sam-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label={t('name')} error={errors.name}>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} className="ltr-field" required />
          </Field>
          <Field label={t('nameAr')}>
            <Input value={f.name_ar} onChange={(e) => set('name_ar', e.target.value)} dir="rtl" />
          </Field>
          <Field label={t('unit')}>
            <Input value={f.unit} onChange={(e) => set('unit', e.target.value)} />
          </Field>
          <Field label={t('barcode')} error={errors.barcode}>
            <Input value={f.barcode} onChange={(e) => set('barcode', e.target.value)} className="ltr-field" inputMode="numeric" />
          </Field>
          <Field label={t('priceUsd')} error={errors.price_usd}>
            <Input value={f.price_usd} onChange={(e) => set('price_usd', e.target.value)} className="ltr-field" inputMode="decimal" />
          </Field>
          <Field label={t('priceSyp')} error={errors.price_syp} hint={t('derivedFromRate', { rate: exchangeRate })}>
            <Input value={f.price_syp} readOnly className="ltr-field bg-slate-100" inputMode="numeric" />
          </Field>
          <Field label={t('wirelessUsd')} error={errors.wireless_price_usd} hint={t('wirelessHint')}>
            <Input value={f.wireless_price_usd} onChange={(e) => set('wireless_price_usd', e.target.value)} className="ltr-field" inputMode="decimal" />
          </Field>
          <Field label={t('wirelessSyp')} error={errors.wireless_price_syp}>
            <Input value={f.wireless_price_syp} readOnly className="ltr-field bg-slate-100" inputMode="numeric" />
          </Field>
          <Field label={t('specs')} className="sm:col-span-2">
            <Input value={f.specs} onChange={(e) => set('specs', e.target.value)} />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={f.for_sale} onChange={(v) => set('for_sale', v)} label={t('forSale')} />
          <span className="text-sm font-medium">{t('forSale')}</span>
        </div>

        {serverError && <Alert>{app('errorGeneric', { message: serverError })}</Alert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {app('cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {app('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
