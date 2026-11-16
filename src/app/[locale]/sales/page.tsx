import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import SalesHistoryScreen from '@/components/SalesHistoryScreen';

export default async function SalesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin', 'sales']}>
      <SalesHistoryScreen />
    </RequireRole>
  );
}
