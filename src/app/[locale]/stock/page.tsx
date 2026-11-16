import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import StockScreen from '@/components/StockScreen';

export default async function StockPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin', 'sales', 'warehouse']}>
      <StockScreen />
    </RequireRole>
  );
}
