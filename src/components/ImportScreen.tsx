'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { catalogCsv, decodeCsvBytes, downloadText, templateCsv } from '@/lib/csv';
import { formatSyp, formatUsd } from '@/lib/format';
import { planImport, type ImportPlan, type Issue, type PlannedRow } from '@/lib/import';
import { errorMessage, fetchAllProducts, getSupabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { Alert, Badge, Button, Card, Spinner, cx } from './ui';

type Filter = 'all' | 'issues' | 'skipped';
const STATUS_TONE = { new: 'green', update: 'blue', unchanged: 'slate', skipped: 'red' } as const;

export default function ImportScreen() {
  const t = useTranslations('import');
  const app = useTranslations('app');
  const fileRef = useRef<HTMLInputElement>(null);

  const [existing, setExisting] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ inserted: number; updated: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setExisting(await fetchAllProducts());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function onFile(file: File) {
    if (!existing) return;
    setDone(null);
    setFailure(null);
    setFileError(null);
    setPlan(null);
    setFilter('all');
    setFileName(file.name);
    const text = decodeCsvBytes(await file.arrayBuffer());
    const result = planImport(text, existing);
    if (!result.ok) setFileError(t(`errors.${result.error}`));
    else setPlan(result.plan);
  }

  async function commit() {
    if (!plan || plan.payload.length === 0) return;
    setBusy(true);
    setFailure(null);
    const { data, error } = await getSupabase().rpc('import_products', { p_rows: plan.payload });
    setBusy(false);
    if (error) {
      setFailure(error.message);
      return;
    }
    setDone(data as { inserted: number; updated: number });
    setPlan(null);
    setFileName(null);
    if (fileRef.current) fileRef.current.value = '';
    void reload();
  }

  const shown = useMemo(() => {
    if (!plan) return [];
    if (filter === 'skipped') return plan.rows.filter((r) => r.status === 'skipped');
    if (filter === 'issues') return plan.rows.filter((r) => r.issues.some((i) => i.severity !== 'note'));
    return plan.rows;
  }, [plan, filter]);

  if (loadError) return <Alert>{app('errorGeneric', { message: loadError })}</Alert>;
  if (!existing) return <Spinner label={app('loading')} />;

  const importable = plan ? plan.counts.new + plan.counts.update : 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <Card className="space-y-4 p-4">
        <p className="text-sm text-slate-600">{t('chooseHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            id="csv-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <label
            htmlFor="csv-file"
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-within:outline-2"
          >
            {t('chooseFile')}
          </label>
          {fileName && <span className="ltr-field text-sm text-slate-600">{fileName}</span>}
          <span className="ms-auto flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => downloadText('sam-products-template.csv', templateCsv())}>
              {t('template')}
            </Button>
            <Button variant="secondary" onClick={() => downloadText('sam-catalog.csv', catalogCsv(existing))}>
              {t('export')}
            </Button>
          </span>
        </div>
      </Card>

      {fileError && <Alert>{fileError}</Alert>}
      {failure && <Alert>{t('failed', { message: failure })}</Alert>}
      {done && (
        <Alert tone="green">
          {t('done', { inserted: done.inserted, updated: done.updated })}
        </Alert>
      )}

      {plan && (
        <>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Badge tone="blue">{t(`format.${plan.format}`)}</Badge>
              <span className="text-sm font-semibold">
                {t('summary', { new: plan.counts.new, update: plan.counts.update, unchanged: plan.counts.unchanged, skipped: plan.counts.skipped })}
              </span>
            </div>
            {plan.medianRatio && <p className="text-xs text-slate-500">{t('medianRatio', { ratio: Math.round(plan.medianRatio) })}</p>}
            {plan.warningRows > 0 && <Alert tone="amber">{t('warningsCount', { count: plan.warningRows })}</Alert>}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={commit} disabled={busy || importable === 0}>
                {busy ? t('importing') : importable === 0 ? t('nothing') : t('button', { count: importable })}
              </Button>
              <span className="ms-auto flex gap-1" role="group">
                {(['all', 'issues', 'skipped'] as const).map((f) => (
                  <Button key={f} variant={filter === f ? 'primary' : 'secondary'} className="px-3" onClick={() => setFilter(f)}>
                    {t(`filter.${f}`)}
                  </Button>
                ))}
              </span>
            </div>
          </Card>

          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  {(['line', 'status', 'code', 'name', 'usd', 'syp', 'wireless', 'notes'] as const).map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2.5 text-start">
                      {t(`cols.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <Row key={r.line} r={r} />
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ r }: { r: PlannedRow }) {
  const t = useTranslations('import');
  const p = r.patch;
  return (
    <tr className={cx(r.status === 'skipped' && 'bg-red-50/60', r.status === 'unchanged' && 'text-slate-400')}>
      <td className="px-3 py-2 tabular-nums text-slate-500">{r.line}</td>
      <td className="px-3 py-2">
        <Badge tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
      </td>
      <td className="ltr-field whitespace-nowrap px-3 py-2 font-mono text-xs">{r.item_code || '—'}</td>
      <td className="max-w-56 truncate px-3 py-2">{r.name || '—'}</td>
      <td className="ltr-field px-3 py-2 text-end tabular-nums">{p.price_usd == null ? '' : formatUsd(p.price_usd)}</td>
      <td className="ltr-field px-3 py-2 text-end tabular-nums">{p.price_syp == null ? '' : formatSyp(p.price_syp)}</td>
      <td className="ltr-field whitespace-nowrap px-3 py-2 text-xs tabular-nums">
        {[p.wireless_price_usd != null && formatUsd(p.wireless_price_usd), p.wireless_price_syp != null && formatSyp(p.wireless_price_syp)]
          .filter(Boolean)
          .join(' / ')}
      </td>
      <td className="px-3 py-2">
        <ul className="space-y-0.5 text-xs">
          {r.issues.map((i, k) => (
            <li key={k} className={i.severity === 'error' ? 'font-semibold text-red-700' : i.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}>
              {issueText(t, i)}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

type T = ReturnType<typeof useTranslations<'import'>>;

function issueText(t: T, i: Issue): string {
  const params: Record<string, string | number> = { ...(i.params ?? {}) };
  if (i.kind === 'ratio' && typeof params.tier === 'string') params.tier = t(`tier.${params.tier as 'general' | 'wireless'}`);
  return t(`issue.${i.kind}`, params);
}
