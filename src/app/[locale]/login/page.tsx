import { setRequestLocale } from 'next-intl/server';
import { RequireRole } from '@/components/AppShell';
import HomeContent from '@/components/HomeContent';

// Signed-out visitors see the login form from RequireRole on any page; this
// route exists so /login is a valid, shareable address.
export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <RequireRole>
      <HomeContent />
    </RequireRole>
  );
}
