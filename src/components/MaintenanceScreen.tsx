'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getSupabase } from '@/lib/supabase';
import { Alert, Button, Card } from './ui';

export default function MaintenanceScreen() {
  const t = useTranslations('maintenance');
  const app = useTranslations('app');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function clear() {
    if (!window.confirm(t('confirm'))) return;
    setBusy(true);
    const { data, error } = await getSupabase().rpc('clear_catalog_and_history');
    setBusy(false);
    setMessage(error ? app('errorGeneric', { message: error.message }) : t('done', { count: data }));
  }

  return <div className="mx-auto max-w-xl space-y-4"><h1 className="text-2xl font-bold">{t('title')}</h1><Card className="space-y-4 border-red-200 p-5"><p className="text-sm text-slate-700">{t('body')}</p><Button variant="danger" disabled={busy} onClick={() => void clear()}>{t('clear')}</Button>{message && <Alert tone="amber">{message}</Alert>}</Card></div>;
}
