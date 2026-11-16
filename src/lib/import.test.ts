import { describe, expect, it } from 'vitest';
import { parseNumber } from './number';
import { searchKey } from './text';
import { catalogCsv, templateCsv } from './csv';
import { detectFormat, median, normalizeHeader, parseBool, planImport, type ExistingProduct } from './import';
import type { Product } from './types';
import { validateConfig } from './supabase';

const PDF_HEADER =
  'Source_Group,Category,Item_Code_or_Name,Unit_or_Length,Specs_or_Resolution,Price_USD,Price_SYP,Wireless_Customer_Price_USD,Wireless_Customer_Price_SYP,Duplicate_Status,Sources';

const existing = (over: Partial<ExistingProduct> = {}): ExistingProduct => ({
  item_code: 'X',
  name: 'X',
  name_ar: null,
  category: null,
  unit: 'قطعة',
  specs: null,
  price_usd: 0,
  price_syp: 0,
  wireless_price_usd: null,
  wireless_price_syp: null,
  for_sale: false,
  barcode: null,
  active: true,
  ...over,
});

function plan(csv: string, ex: ExistingProduct[] = []) {
  const r = planImport(csv, ex);
  if (!r.ok) throw new Error('plan failed: ' + r.error);
  return r.plan;
}

describe('parseNumber', () => {
  it('strips commas, quotes, spaces and $', () => {
    expect(parseNumber('1,234,567')).toEqual({ state: 'ok', value: 1234567 });
    expect(parseNumber('"2,500"')).toEqual({ state: 'ok', value: 2500 });
    expect(parseNumber(' $12.50 ')).toEqual({ state: 'ok', value: 12.5 });
  });
  it('reads Arabic digits and separators', () => {
    expect(parseNumber('٣٥٫٥')).toEqual({ state: 'ok', value: 35.5 });
    expect(parseNumber('١٬٢٠٠')).toEqual({ state: 'ok', value: 1200 });
  });
  it('treats text as invalid, blank as empty', () => {
    expect(parseNumber('ضمن الطقم').state).toBe('invalid');
    expect(parseNumber('طقم مع الصحن (65700)').state).toBe('invalid');
    expect(parseNumber('-').state).toBe('invalid');
    expect(parseNumber('  ').state).toBe('empty');
    expect(parseNumber(undefined).state).toBe('empty');
  });
});

describe('helpers', () => {
  it('detects the format from headers (BOM and case tolerant)', () => {
    expect(detectFormat(PDF_HEADER.split(',').map(normalizeHeader))).toBe('pdf');
    expect(detectFormat(['﻿Item_Code', 'name'].map(normalizeHeader))).toBe('template');
    expect(detectFormat(['foo', 'bar'])).toBeNull();
  });
  it('parses booleans in English and Arabic', () => {
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('نعم')).toBe(true);
    expect(parseBool('لا')).toBe(false);
    expect(parseBool('maybe')).toBeNull();
  });
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it('folds Arabic letter variants for search', () => {
    expect(searchKey('أجهزة الإرسال')).toBe(searchKey('اجهزه الارسال'));
    expect(searchKey('RB941 ٢nD')).toBe('rb941 2nd');
  });
});

describe('planImport — PDF format', () => {
  const csv = [
    PDF_HEADER,
    'MikroTik,Routers,hAP ac2,قطعة,5 GbE,"65.00","975,000","60.00","900,000",,p1',
    'MikroTik,Routers,RB941-2nD,قطعة,,25,375000,,,,p1',
    'Ubiquiti,Wireless,LiteBeam 5AC,,23 dBi,80,1200000,72,1080000,,p2',
    'Mimosa,Wireless,Mimosa C5c,قطعة,,150,2250000,,,,p2',
    'Cudy,Kits,Kit with Dish,طقم,,55,ضمن الطقم,50,طقم مع الصحن (65700),,p3',
    'Cables,Cables,Cat6 Cable,305m,UTP,40,600000,,,,p3',
  ].join('\n');

  it('detects the format and maps one column to code AND name', () => {
    const p = plan(csv);
    expect(p.format).toBe('pdf');
    const r = p.rows[0];
    expect(r.item_code).toBe('hAP ac2');
    expect(r.name).toBe('hAP ac2');
    expect(r.patch).toMatchObject({ category: 'Routers', unit: 'قطعة', specs: '5 GbE', price_usd: 65, price_syp: 975000, wireless_price_usd: 60, wireless_price_syp: 900000 });
  });

  it('never touches for_sale or the Duplicate_Status / Sources columns', () => {
    const p = plan(csv);
    for (const r of p.rows) expect(Object.keys(r.patch)).not.toContain('for_sale');
  });

  it('turns text prices into "no standalone price" (0 general, null wireless)', () => {
    const kit = plan(csv).rows[4];
    expect(kit.patch.price_syp).toBe(0);
    expect(kit.patch.wireless_price_syp).toBeNull();
    expect(kit.issues.filter((i) => i.kind === 'no_standalone_price')).toHaveLength(2);
    expect(kit.status).toBe('new');
  });

  it('puts a length like "305m" into specs and keeps the default unit', () => {
    const cable = plan(csv).rows[5];
    expect(cable.patch.unit).toBeUndefined();
    expect(cable.patch.specs).toBe('305m — UTP');
  });

  it('empty cells are left alone, not cleared', () => {
    const r = plan(csv).rows[1];
    expect(r.patch.specs).toBeUndefined();
    expect(r.patch.wireless_price_usd).toBeUndefined();
  });

  it('flags SYP/USD ratios more than 15% from the median', () => {
    // 15000 SYP per USD everywhere except one row at 1500 (a dropped zero)
    const rows = [
      PDF_HEADER,
      'a,c,A1,,,10,150000,,,,',
      'a,c,A2,,,20,300000,,,,',
      'a,c,A3,,,30,450000,,,,',
      'a,c,A4,,,40,600000,,,,',
      'a,c,TYPO,,,50,75000,,,,',
      'a,c,NEAR,,,10,160000,,,,', // +6.7%: fine
    ].join('\n');
    const p = plan(rows);
    expect(p.medianRatio).toBe(15000);
    const flagged = p.rows.filter((r) => r.issues.some((i) => i.kind === 'ratio'));
    expect(flagged.map((r) => r.item_code)).toEqual(['TYPO']);
    expect(flagged[0].issues.find((i) => i.kind === 'ratio')?.params).toMatchObject({ tier: 'general', ratio: 1500, median: 15000, pct: -90 });
    expect(p.warningRows).toBe(1);
  });

  it('does not judge ratios from fewer than 3 priced rows', () => {
    const p = plan([PDF_HEADER, 'a,c,A1,,,10,150000,,,,', 'a,c,A2,,,10,1,,,,'].join('\n'));
    expect(p.medianRatio).toBeNull();
    expect(p.warningRows).toBe(0);
  });

  it('flags wireless prices above the general price', () => {
    const p = plan([PDF_HEADER, 'a,c,A1,,,10,150000,12,150000,,'].join('\n'));
    const issue = p.rows[0].issues.find((i) => i.kind === 'wireless_higher');
    expect(issue?.params).toMatchObject({ currency: 'USD', wireless: 12, general: 10 });
    expect(p.rows[0].status).toBe('new'); // a warning, not a blocker
  });

  it('skips rows with no code and duplicate codes (first one wins)', () => {
    const p = plan([PDF_HEADER, 'a,c,A1,,,10,150000,,,,', 'a,c,,,,5,75000,,,,', 'a,c,A1,,,99,1485000,,,,'].join('\n'));
    expect(p.rows.map((r) => r.status)).toEqual(['new', 'skipped', 'skipped']);
    expect(p.rows[1].issues[0].kind).toBe('missing_code');
    expect(p.rows[2].issues[0]).toMatchObject({ kind: 'duplicate_code', params: { firstLine: 2 } });
    expect(p.payload).toHaveLength(1);
    expect(p.payload[0].price_usd).toBe(10);
  });
});

describe('planImport — matching existing products', () => {
  const csv = [PDF_HEADER, 'a,Routers,A1,,,12,180000,,,,', 'a,Routers,A2,,,20,300000,,,,', 'a,Routers,A3,,,30,450000,,,,'].join('\n');

  it('counts new / updated / unchanged and sends only changed keys', () => {
    const p = plan(csv, [
      existing({ item_code: 'A1', name: 'A1', category: 'Routers', price_usd: 10, price_syp: 150000, for_sale: true }), // price changed
      existing({ item_code: 'A2', name: 'A2', category: 'Routers', price_usd: 20, price_syp: 300000 }), // identical
    ]);
    expect(p.counts).toEqual({ new: 1, update: 1, unchanged: 1, skipped: 0 });
    const upd = p.payload.find((x) => x.item_code === 'A1')!;
    expect(upd).toEqual({ item_code: 'A1', price_usd: 12, price_syp: 180000 });
    const added = p.payload.find((x) => x.item_code === 'A3')!;
    expect(added).toMatchObject({ item_code: 'A3', name: 'A3', price_usd: 30 });
    expect(p.payload.find((x) => x.item_code === 'A2')).toBeUndefined();
  });

  it('notes a match with a deleted (inactive) product', () => {
    const p = plan(csv, [existing({ item_code: 'A1', name: 'A1', active: false })]);
    expect(p.rows[0].issues.some((i) => i.kind === 'inactive_match')).toBe(true);
  });
});

describe('planImport — template format', () => {
  const header = 'item_code,name,name_ar,category,unit,price_usd,price_syp,wireless_price_usd,wireless_price_syp,for_sale,barcode';

  it('reads every column, including Arabic text and for_sale', () => {
    const p = plan([header, 'R1,Router,راوتر,Routers,قطعة,40,600000,36,540000,true,6291041500213'].join('\n'));
    expect(p.format).toBe('template');
    expect(p.rows[0].patch).toEqual({
      name: 'Router', name_ar: 'راوتر', category: 'Routers', unit: 'قطعة', specs: undefined,
      price_usd: 40, price_syp: 600000, wireless_price_usd: 36, wireless_price_syp: 540000,
      for_sale: true, barcode: '6291041500213',
    } as never);
  });

  it('empty wireless/barcode cells clear the value (template rows are complete)', () => {
    const p = plan([header, 'R1,Router,,,,40,600000,,,false,'].join('\n'));
    expect(p.rows[0].patch.wireless_price_usd).toBeNull();
    expect(p.rows[0].patch.barcode).toBeNull();
    expect(p.rows[0].patch.for_sale).toBe(false);
  });

  it('warns about unreadable numbers / for_sale and leaves them out', () => {
    const p = plan([header, 'R1,Router,,,,abc,600000,,,maybe,'].join('\n'));
    const kinds = p.rows[0].issues.map((i) => i.kind);
    expect(kinds).toContain('bad_number');
    expect(kinds).toContain('bad_for_sale');
    expect(p.rows[0].patch.price_usd).toBeUndefined();
    expect(p.rows[0].patch.for_sale).toBeUndefined();
  });

  it('catches barcodes ruined by spreadsheet scientific notation', () => {
    const p = plan([header, 'R1,Router,,,,40,600000,,,,6.2910415E+12'].join('\n'));
    expect(p.rows[0].issues.map((i) => i.kind)).toContain('barcode_mangled');
    expect(p.rows[0].patch.barcode).toBeUndefined();
  });

  it('skips duplicate barcodes in the file and barcodes owned by another product', () => {
    const p = plan(
      [header, 'R1,A,,,,1,1,,,,111', 'R2,B,,,,1,1,,,,111', 'R3,C,,,,1,1,,,,222'].join('\n'),
      [existing({ item_code: 'OLD', barcode: '222' })],
    );
    expect(p.rows.map((r) => r.status)).toEqual(['new', 'skipped', 'skipped']);
    expect(p.rows[1].issues[0].kind).toBe('duplicate_barcode');
    expect(p.rows[2].issues[0]).toMatchObject({ kind: 'barcode_in_use', params: { code: 'OLD' } });
  });

  it('accepts semicolon-separated files (Arabic-locale Excel)', () => {
    const p = plan('item_code;name;price_usd\nR1;Router;40');
    expect(p.rows[0].patch).toMatchObject({ name: 'Router', price_usd: 40 });
  });

  it('a row with a code but no name is skipped', () => {
    const p = plan([header, 'R1,,,,,40,600000,,,,'].join('\n'));
    expect(p.rows[0].status).toBe('skipped');
    expect(p.rows[0].issues[0].kind).toBe('missing_name');
  });
});

describe('planImport — bad files', () => {
  it('rejects unknown headers and empty files', () => {
    expect(planImport('foo,bar\n1,2', [])).toEqual({ ok: false, error: 'unknown_format' });
    expect(planImport('', [])).toEqual({ ok: false, error: 'empty_file' });
    expect(planImport('item_code,name\n', [])).toEqual({ ok: false, error: 'empty_file' });
  });
});

describe('CSV export / template', () => {
  const product = (over: Partial<Product>): Product => ({
    id: '1', item_code: 'R1', name: 'Router, "pro"', name_ar: 'راوتر', category: 'Routers', unit: 'قطعة', specs: null,
    price_usd: 40, price_syp: 600000, wireless_price_usd: null, wireless_price_syp: null, cost_usd: null,
    for_sale: true, barcode: null, reorder_level: 3, active: true, created_at: '', ...over,
  });

  it('template is just the header row, with a BOM for Excel', () => {
    expect(templateCsv().trimEnd()).toBe(
      '﻿item_code,name,name_ar,category,unit,price_usd,price_syp,wireless_price_usd,wireless_price_syp,for_sale,barcode',
    );
  });

  it('exported catalog re-imports as "unchanged" (round trip)', () => {
    const p = product({});
    const csv = catalogCsv([p]);
    expect(csv).toContain('"Router, ""pro"""');
    const ex = existing({ ...p });
    const result = plan(csv, [ex]);
    expect(result.counts).toEqual({ new: 0, update: 0, unchanged: 1, skipped: 0 });
  });
});

describe('validateConfig (setup screen)', () => {
  const jwt = (role: string) => `h.${btoa(JSON.stringify({ role }))}.s`;
  it('accepts an https URL with an anon key', () => {
    expect(validateConfig('https://abc.supabase.co', jwt('anon'))).toBeNull();
    expect(validateConfig(' https://abc.supabase.co/ ', 'sb_publishable_abc')).toBeNull();
  });
  it('refuses secret / service_role keys', () => {
    expect(validateConfig('https://abc.supabase.co', jwt('service_role'))).toBe('secret_key');
    expect(validateConfig('https://abc.supabase.co', 'sb_secret_abc')).toBe('secret_key');
  });
  it('refuses bad URLs and empty keys', () => {
    expect(validateConfig('abc.supabase.co', jwt('anon'))).toBe('bad_url');
    expect(validateConfig('http://abc.supabase.co', jwt('anon'))).toBe('bad_url');
    expect(validateConfig('https://abc.supabase.co', '  ')).toBe('empty_key');
  });
});
