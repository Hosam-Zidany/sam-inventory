'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { saveConfig, validateConfig } from '@/lib/supabase';
import { Alert, Button, Card, Field, Input } from './ui';

/** Shown when the site has no Supabase settings yet: paste URL + anon key, stored in this browser. */
export default function SetupScreen() {
  const t = useTranslations('setup');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const p = validateConfig(url, key);
    if (p) {
      setProblem(t(`problem.${p}`));
      return;
    }
    saveConfig(url, key);
    window.location.reload();
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md px-4">
      <Card className="p-6">
        <h1 className="mb-1 text-xl font-extrabold text-brand-700">{t('title')}</h1>
        <p className="mb-4 text-sm text-slate-600">{t('intro')}</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label={t('url')} hint={t('urlHint')}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="ltr-field" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://xxxx.supabase.co" />
          </Field>
          <Field label={t('key')} hint={t('keyHint')}>
            <Input value={key} onChange={(e) => setKey(e.target.value)} className="ltr-field" autoCapitalize="none" autoCorrect="off" />
          </Field>
          {problem && <Alert>{problem}</Alert>}
          <Button type="submit" className="w-full">
            {t('save')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
