import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import ProductsScreen from '@/components/ProductsScreen';

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin', 'sales', 'warehouse']}>
      <ProductsScreen />
    </RequireRole>
  );
}
