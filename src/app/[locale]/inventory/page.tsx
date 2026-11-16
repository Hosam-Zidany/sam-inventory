import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import InventoryCountScreen from '@/components/InventoryCountScreen';

export default async function InventoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin', 'sales', 'warehouse']}>
      <InventoryCountScreen />
    </RequireRole>
  );
}
