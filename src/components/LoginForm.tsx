'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, Field, Input } from './ui';

export default function LoginForm() {
  const t = useTranslations('login');
  const app = useTranslations('app');
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(email.trim(), password);
    if (err) setError(err);
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-12 w-full max-w-sm px-4">
      <Card className="p-6">
        <h1 className="mb-1 text-center text-2xl font-extrabold text-brand-700">{app('name')}</h1>
        <p className="mb-5 text-center text-sm text-slate-500">{t('title')}</p>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('email')}>
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ltr-field"
            />
          </Field>
          <Field label={t('password')}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ltr-field"
            />
          </Field>
          {error && <Alert>{t('failed', { message: error })}</Alert>}
          <Button type="submit" disabled={busy} className="w-full">
            {t('submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
