'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth';
import { Card } from './ui';

export default function HomeContent() {
  const t = useTranslations('home');
  const { state } = useAuth();
  const name = state.status === 'ready' ? (state.fullName ?? state.user.email) : '';
  return (
    <Card className="space-y-3 p-6">
      <h1 className="text-2xl font-bold">
        {t('welcome')} {name}
      </h1>
      <p className="text-slate-600">{t('soon')}</p>
      <Link
        href="/products"
        className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {t('openProducts')}
      </Link>
    </Card>
  );
}
