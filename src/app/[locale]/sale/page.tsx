import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import SaleScreen from '@/components/SaleScreen';

export default async function SalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin', 'sales']}>
      <SaleScreen />
    </RequireRole>
  );
}
