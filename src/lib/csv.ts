import Papa from 'papaparse';
import type { Product } from './types';

/** Columns of the "simple template" (spec 4.7). `specs` is an optional extra on export. */
export const TEMPLATE_COLUMNS = [
  'item_code',
  'name',
  'name_ar',
  'category',
  'unit',
  'price_usd',
  'price_syp',
  'wireless_price_usd',
  'wireless_price_syp',
  'for_sale',
  'barcode',
] as const;

export const EXPORT_COLUMNS = [...TEMPLATE_COLUMNS, 'specs'] as const;

const BOM = '﻿'; // lets Excel open Arabic UTF-8 CSV correctly

export function templateCsv(): string {
  return BOM + Papa.unparse({ fields: [...TEMPLATE_COLUMNS], data: [] });
}

export function catalogCsv(products: Product[]): string {
  const data = products.map((p) =>
    EXPORT_COLUMNS.map((c) => {
      const v = p[c as keyof Product];
      return v == null ? '' : typeof v === 'boolean' ? String(v) : v;
    }),
  );
  return BOM + Papa.unparse({ fields: [...EXPORT_COLUMNS], data });
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Decode an uploaded CSV: UTF-8 if valid, else Windows-1256 (Arabic Excel's default). */
export function decodeCsvBytes(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1256').decode(buf);
  }
}
