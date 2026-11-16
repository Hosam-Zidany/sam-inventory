import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import HomeContent from '@/components/HomeContent';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole>
      <HomeContent />
    </RequireRole>
  );
}
