'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { errorMessage, getSupabase } from '@/lib/supabase';
import { Alert, Button, Card, Input, Spinner } from './ui';

type Sale = { id: string; receipt_number: string; customer_name: string | null; total: number; currency: 'USD' | 'SYP'; status: 'completed' | 'cancelled'; created_at: string };

export default function SalesHistoryScreen() {
  const t = useTranslations('sales');
  const app = useTranslations('app');
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getSupabase().from('sales').select('id, receipt_number, customer_name, total, currency, status, created_at').order('created_at', { ascending: false }).limit(100);
    if (loadError) throw loadError;
    setSales((data ?? []) as Sale[]);
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  async function cancel(sale: Sale) {
    if (!window.confirm(t('confirmCancel', { receipt: sale.receipt_number }))) return;
    setBusy(sale.id);
    const { error: rpcError } = await getSupabase().rpc('cancel_sale', { p_sale_id: sale.id, p_reason: reason[sale.id] || null });
    setBusy(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await load();
  }

  if (!sales) return <Spinner label={app('loading')} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {error && <Alert>{app('errorGeneric', { message: error })}</Alert>}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-start text-xs font-semibold"><tr><th className="px-3 py-2 text-start">{t('receipt')}</th><th className="px-3 py-2 text-start">{t('date')}</th><th className="px-3 py-2 text-start">{t('customer')}</th><th className="px-3 py-2 text-end">{t('total')}</th><th className="px-3 py-2 text-start">{t('status')}</th><th className="px-3 py-2 text-start">{t('action')}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{sales.map((sale) => <tr key={sale.id}><td className="px-3 py-2 font-mono">{sale.receipt_number}</td><td className="px-3 py-2 ltr-field">{new Date(sale.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Damascus' })}</td><td className="px-3 py-2">{sale.customer_name || '—'}</td><td className="px-3 py-2 text-end ltr-field">{sale.total} {sale.currency}</td><td className="px-3 py-2">{sale.status === 'cancelled' ? t('cancelled') : t('completed')}</td><td className="px-3 py-2">{sale.status === 'completed' && <div className="flex gap-2"><Input className="max-w-40" value={reason[sale.id] ?? ''} onChange={(e) => setReason((current) => ({ ...current, [sale.id]: e.target.value }))} placeholder={t('reason')} /><Button variant="danger" disabled={busy === sale.id} onClick={() => void cancel(sale)}>{t('cancel')}</Button></div>}</td></tr>)}</tbody>
        </table>
      </Card>
    </div>
  );
}
