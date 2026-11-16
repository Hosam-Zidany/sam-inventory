import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import MaintenanceScreen from '@/components/MaintenanceScreen';

export default async function MaintenancePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole roles={['admin']}>
      <MaintenanceScreen />
    </RequireRole>
  );
}
