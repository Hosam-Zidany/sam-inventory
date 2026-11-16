'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import type { Role } from '@/lib/types';
import { Alert, Button, Card, Input, Spinner, cx } from './ui';
import LoginForm from './LoginForm';
import SetupScreen from './SetupScreen';

/** Menu entries per role. This only decides what is SHOWN; Postgres decides what is ALLOWED. */
const NAV: Array<{ href: string; key: string; roles: Role[] }> = [
  { href: '/', key: 'dashboard', roles: ['admin', 'sales', 'warehouse'] },
  { href: '/products', key: 'products', roles: ['admin', 'sales', 'warehouse'] },
  { href: '/import', key: 'import', roles: ['admin'] },
];

export function RequireRole({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const t = useTranslations();
  const { state } = useAuth();

  if (state.status === 'loading') return <Spinner label={t('app.loading')} />;
  if (state.status === 'unconfigured') return <SetupScreen />;
  if (state.status === 'signed_out') return <LoginForm />;
  if (state.role === null) {
    return <NoRole email={state.user.email ?? ''} />;
  }
  if (roles && !roles.includes(state.role)) {
    return (
      <Shell>
        <Alert tone="amber">
          <strong>{t('forbidden.title')}</strong> — {t('forbidden.body', { role: t(`roles.${state.role}`) })}
        </Alert>
      </Shell>
    );
  }
  return <Shell>{children}</Shell>;
}

function NoRole({ email }: { email: string }) {
  const t = useTranslations();
  const { signOut } = useAuth();
  const [canClaim, setCanClaim] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only a project with no admin at all offers the claim button.
  useEffect(() => {
    let alive = true;
    getSupabase()
      .rpc('needs_first_admin')
      .then(({ data }) => alive && setCanClaim(data === true));
    return () => {
      alive = false;
    };
  }, []);

  async function claim() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await getSupabase().rpc('claim_first_admin', { p_full_name: name.trim() || null });
    setBusy(false);
    if (err) setError(err.message);
    else if (data === true) window.location.reload();
    else setCanClaim(false); // someone else got there first
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-4">
      <Card className="space-y-4 p-6">
        <h1 className="text-xl font-bold">{t('noRole.title')}</h1>
        <p className="text-sm text-slate-600">{t('noRole.body', { email })}</p>
        {canClaim && (
          <div className="space-y-3 rounded-lg border border-brand-100 bg-brand-50 p-4">
            <p className="text-sm font-semibold text-brand-900">{t('noRole.claimTitle')}</p>
            <p className="text-xs text-slate-600">{t('noRole.claimBody')}</p>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('noRole.claimName')} aria-label={t('noRole.claimName')} />
            {error && <Alert>{t('app.errorGeneric', { message: error })}</Alert>}
            <Button onClick={claim} disabled={busy} className="w-full">
              {t('noRole.claimButton')}
            </Button>
          </div>
        )}
        <Button variant="secondary" onClick={signOut}>
          {t('nav.signOut')}
        </Button>
      </Card>
    </div>
  );
}

function LanguageSwitch() {
  const t = useTranslations('app');
  const locale = useLocale();
  const pathname = usePathname();
  const next = locale === 'ar' ? 'en' : 'ar';
  // Plain <a>: a full navigation re-renders <html lang dir> for the new language.
  const base = process.env.NEXT_PUBLIC_BASE_PATH || '';
  const href = `${base}/${next}${pathname === '/' ? '' : pathname}/`;
  return (
    <a
      href={href}
      onClick={() => {
        try {
          localStorage.setItem('sam-locale', next);
        } catch {
          /* private mode: ignore */
        }
      }}
      className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
      lang={next}
    >
      {t('language')}
    </a>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const { state, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  if (state.status !== 'ready' || !state.role) return null;
  const role = state.role;
  const items = NAV.filter((n) => n.roles.includes(role));

  const links = items.map((n) => {
    const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
    return (
      <Link
        key={n.href}
        href={n.href}
        onClick={() => setOpen(false)}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold',
          active ? 'bg-brand-100 text-brand-900' : 'text-slate-700 hover:bg-slate-100',
        )}
      >
        {t(`nav.${n.key}`)}
      </Link>
    );
  });

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-2">
          <button
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-slate-100 md:hidden"
            aria-label={t('nav.menu')}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <span className="text-base font-extrabold text-brand-700">{t('app.name')}</span>
          <nav className="ms-4 hidden items-center gap-1 md:flex" aria-label={t('nav.menu')}>
            {links}
          </nav>
          <div className="ms-auto flex items-center gap-1">
            <span className="hidden text-xs text-slate-500 sm:inline">
              {state.fullName ?? state.user.email} · {t(`roles.${role}`)}
            </span>
            <LanguageSwitch />
            <Button variant="ghost" onClick={signOut} className="px-3">
              {t('nav.signOut')}
            </Button>
          </div>
        </div>
        {open && (
          <nav className="flex flex-col gap-1 border-t border-slate-100 px-3 py-2 md:hidden" aria-label={t('nav.menu')}>
            {links}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-3 py-5">{children}</main>
    </div>
  );
}
