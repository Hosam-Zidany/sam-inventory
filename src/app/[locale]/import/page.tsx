import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import ImportScreen from '@/components/ImportScreen';

export default async function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin']}>
      <ImportScreen />
    </RequireRole>
  );
}
