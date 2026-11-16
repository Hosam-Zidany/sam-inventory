import Papa from 'papaparse';
import { parseNumber, type ParsedNumber } from './number';

/**
 * Catalog CSV import — pure logic (no UI, no network) so it can be unit tested.
 *
 *   planImport(csvText, existingProducts) -> { ok, plan }
 *
 * Three formats are auto-detected from the header row (spec 4.7):
 *   'pdf'      Source_Group, Category, Item_Code_or_Name, Unit_or_Length,
 *              Specs_or_Resolution, Price_USD, Price_SYP,
 *              Wireless_Customer_Price_USD, Wireless_Customer_Price_SYP,
 *              Duplicate_Status, Sources
 *   'section'  Price List, Section, Item No, Description, Unit, USD Price,
 *              SYP Price, Notes
 *   'template' item_code, name, name_ar, category, unit, price_usd, price_syp,
 *              wireless_price_usd, wireless_price_syp, for_sale, barcode (+ specs)
 *
 * Merge semantics match the import_products() SQL function: a key missing from
 * a row's patch leaves the existing value alone; a key present is written.
 */

export type ImportFormat = 'pdf' | 'section' | 'template';

export interface ProductPatch {
  name?: string;
  name_ar?: string | null;
  category?: string | null;
  unit?: string;
  specs?: string | null;
  price_usd?: number;
  price_syp?: number;
  wireless_price_usd?: number | null;
  wireless_price_syp?: number | null;
  for_sale?: boolean;
  barcode?: string | null;
}
type PatchKey = keyof ProductPatch;

export interface ExistingProduct {
  item_code: string;
  name: string;
  name_ar: string | null;
  category: string | null;
  unit: string;
  specs: string | null;
  price_usd: number;
  price_syp: number;
  wireless_price_usd: number | null;
  wireless_price_syp: number | null;
  for_sale: boolean;
  barcode: string | null;
  active: boolean;
}

export type IssueKind =
  | 'missing_code'
  | 'missing_name'
  | 'duplicate_code'
  | 'duplicate_barcode'
  | 'barcode_in_use'
  | 'ratio'
  | 'wireless_higher'
  | 'no_standalone_price'
  | 'bad_number'
  | 'bad_for_sale'
  | 'barcode_mangled'
  | 'inactive_match';

export interface Issue {
  kind: IssueKind;
  /** error = row is skipped; warning = imported but check it; note = FYI */
  severity: 'error' | 'warning' | 'note';
  params?: Record<string, string | number>;
}

export type RowStatus = 'new' | 'update' | 'unchanged' | 'skipped';

export interface PlannedRow {
  /** 1-based line in the file (header is line 1) */
  line: number;
  item_code: string;
  name: string;
  status: RowStatus;
  patch: ProductPatch;
  /** fields that differ from the existing product (update) or all fields (new) */
  changes: PatchKey[];
  issues: Issue[];
}

export interface ImportPlan {
  format: ImportFormat;
  rows: PlannedRow[];
  counts: Record<RowStatus, number>;
  /** rows that will be imported but carry at least one warning */
  warningRows: number;
  medianRatio: number | null;
  /** what to send to import_products(): new rows in full, updated rows only with changed keys */
  payload: Array<{ item_code: string } & ProductPatch>;
}

export type PlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; error: 'empty_file' | 'unknown_format' };

// ---------------------------------------------------------------------------

const RATIO_TOLERANCE = 0.15; // spec: >15% away from the file's median SYP/USD ratio
const MIN_RATIOS_FOR_MEDIAN = 3;

const KNOWN_UNIT = /^(قطعة|قطع|طقم|متر|م|pcs?|piece|pieces|set|kit|meter|metre|m)$/i;

const clean = (s: string | undefined | null): string => (s ?? '').replace(/\s+/g, ' ').trim();

export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function detectFormat(headers: string[]): ImportFormat | null {
  if (headers.includes('item_code_or_name')) return 'pdf';
  if (headers.includes('item_no') && headers.includes('description')) return 'section';
  if (headers.includes('item_code')) return 'template';
  return null;
}

export function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'نعم', 'صح', '✓'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'لا', 'خطأ', 'خطا'].includes(v)) return false;
  return null;
}

/** Spreadsheet apps turn 6291041500213 into 6.29104E+12 — that barcode is lost. */
const MANGLED_BARCODE = /^\d+(\.\d+)?e\+?\d+$/i;

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function nextGeneratedCode(used: Set<string>, nextNumber: { value: number }): string {
  let code = '';
  do {
    code = `AUTO-${String(nextNumber.value++).padStart(4, '0')}`;
  } while (used.has(code));
  used.add(code);
  return code;
}

// ---------------------------------------------------------------------------
// Row mapping

interface MappedRow {
  item_code: string;
  name: string;
  patch: ProductPatch;
  issues: Issue[];
}

type Cells = Record<string, string>;

function setPrice(
  patch: ProductPatch,
  issues: Issue[],
  field: 'price_usd' | 'price_syp' | 'wireless_price_usd' | 'wireless_price_syp',
  parsed: ParsedNumber,
  format: ImportFormat,
) {
  const nullable = field.startsWith('wireless');
  if (parsed.state === 'ok') {
    (patch as Record<string, unknown>)[field] = parsed.value;
  } else if (parsed.state === 'invalid') {
    if (format === 'pdf') {
      // "ضمن الطقم", "طقم مع الصحن (65700)", "-" ... = no standalone price
      (patch as Record<string, unknown>)[field] = nullable ? null : 0;
      issues.push({ kind: 'no_standalone_price', severity: 'note', params: { field, text: parsed.text } });
    } else {
      issues.push({ kind: 'bad_number', severity: 'warning', params: { field, text: parsed.text } });
    }
  } else if (format === 'template' && nullable) {
    (patch as Record<string, unknown>)[field] = null; // template is a full row: an empty wireless cell means "none"
  }
}

function mapPdfRow(r: Cells): MappedRow {
  const issues: Issue[] = [];
  const patch: ProductPatch = {};
  // The PDF format has ONE column that is both the code and the name.
  const code = clean(r.item_code_or_name);
  if (code) patch.name = code;

  const category = clean(r.category);
  if (category) patch.category = category;

  const unitOrLength = clean(r.unit_or_length);
  const specParts: string[] = [];
  if (unitOrLength) {
    if (KNOWN_UNIT.test(unitOrLength)) patch.unit = unitOrLength;
    else specParts.push(unitOrLength); // e.g. "305m", "2 m" is a length, not a unit
  }
  const specs = clean(r.specs_or_resolution);
  if (specs) specParts.push(specs);
  if (specParts.length) patch.specs = specParts.join(' — ');

  setPrice(patch, issues, 'price_usd', parseNumber(r.price_usd), 'pdf');
  setPrice(patch, issues, 'price_syp', parseNumber(r.price_syp), 'pdf');
  setPrice(patch, issues, 'wireless_price_usd', parseNumber(r.wireless_customer_price_usd), 'pdf');
  setPrice(patch, issues, 'wireless_price_syp', parseNumber(r.wireless_customer_price_syp), 'pdf');

  return { item_code: code, name: code, patch, issues };
}

function mapSectionRow(r: Cells): MappedRow {
  const issues: Issue[] = [];
  const patch: ProductPatch = {};
  const code = clean(r.item_no);
  const name = clean(r.description);
  const category = clean(r.section);
  const unit = clean(r.unit);

  if (category) patch.category = category;
  if (unit) patch.unit = unit;
  setPrice(patch, issues, 'price_usd', parseNumber(r.usd_price), 'template');
  setPrice(patch, issues, 'price_syp', parseNumber(r.syp_price), 'template');
  const notes = clean(r.notes);
  if (notes) patch.specs = notes;

  return { item_code: code, name, patch, issues };
}

function mapTemplateRow(r: Cells, headers: Set<string>): MappedRow {
  const issues: Issue[] = [];
  const patch: ProductPatch = {};
  const has = (k: string) => headers.has(k);

  const code = clean(r.item_code);
  const name = has('name') ? clean(r.name) : '';
  if (name) patch.name = name;

  // Columns that are present are written; empty -> cleared (nullable text only).
  for (const k of ['name_ar', 'category', 'specs'] as const) {
    if (has(k)) patch[k] = clean(r[k]) || null;
  }
  if (has('unit') && clean(r.unit)) patch.unit = clean(r.unit);

  if (has('price_usd')) setPrice(patch, issues, 'price_usd', parseNumber(r.price_usd), 'template');
  if (has('price_syp')) setPrice(patch, issues, 'price_syp', parseNumber(r.price_syp), 'template');
  if (has('wireless_price_usd')) setPrice(patch, issues, 'wireless_price_usd', parseNumber(r.wireless_price_usd), 'template');
  if (has('wireless_price_syp')) setPrice(patch, issues, 'wireless_price_syp', parseNumber(r.wireless_price_syp), 'template');

  if (has('for_sale') && clean(r.for_sale)) {
    const b = parseBool(r.for_sale);
    if (b === null) issues.push({ kind: 'bad_for_sale', severity: 'warning', params: { text: clean(r.for_sale) } });
    else patch.for_sale = b;
  }

  if (has('barcode')) {
    const bc = clean(r.barcode);
    if (!bc) patch.barcode = null;
    else if (MANGLED_BARCODE.test(bc)) issues.push({ kind: 'barcode_mangled', severity: 'warning', params: { text: bc } });
    else patch.barcode = bc;
  }

  return { item_code: code, name, patch, issues };
}

// ---------------------------------------------------------------------------
// Diff against the existing catalog

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  return (a ?? null) === (b ?? null);
}

// ---------------------------------------------------------------------------

export function planImport(text: string, existing: ExistingProduct[]): PlanResult {
  const parsed = Papa.parse<Cells>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normalizeHeader,
  });

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (headers.length === 0 || parsed.data.length === 0) {
    return { ok: false, error: headers.length === 0 ? 'empty_file' : detectFormat(headers) ? 'empty_file' : 'unknown_format' };
  }
  const format = detectFormat(headers);
  if (!format) return { ok: false, error: 'unknown_format' };
  const headerSet = new Set(headers);

  const byCode = new Map(existing.map((p) => [p.item_code, p]));
  const barcodeOwner = new Map<string, string>();
  for (const p of existing) if (p.barcode) barcodeOwner.set(p.barcode, p.item_code);

  const firstLineOfCode = new Map<string, number>();
  const firstLineOfBarcode = new Map<string, number>();
  const usedCodes = new Set(byCode.keys());
  const nextAutoNumber = { value: 1 };
  for (const code of usedCodes) {
    const match = /^AUTO-(\d+)$/.exec(code);
    if (match) nextAutoNumber.value = Math.max(nextAutoNumber.value, Number(match[1]) + 1);
  }
  const rows: PlannedRow[] = [];

  parsed.data.forEach((cells, i) => {
    const line = i + 2;
    const mapped =
      format === 'pdf' ? mapPdfRow(cells) : format === 'section' ? mapSectionRow(cells) : mapTemplateRow(cells, headerSet);
    const issues = [...mapped.issues];
    if (!mapped.item_code && format !== 'pdf') mapped.item_code = nextGeneratedCode(usedCodes, nextAutoNumber);

    if (!mapped.item_code) issues.push({ kind: 'missing_code', severity: 'error' });
    else if (!mapped.name) issues.push({ kind: 'missing_name', severity: 'error' });

    if (mapped.item_code) {
      const first = firstLineOfCode.get(mapped.item_code);
      if (first !== undefined) issues.push({ kind: 'duplicate_code', severity: 'error', params: { firstLine: first } });
      else firstLineOfCode.set(mapped.item_code, line);
    }

    const bc = mapped.patch.barcode;
    if (bc && !issues.some((x) => x.severity === 'error')) {
      const owner = barcodeOwner.get(bc);
      const seen = firstLineOfBarcode.get(bc);
      if (seen !== undefined) issues.push({ kind: 'duplicate_barcode', severity: 'error', params: { firstLine: seen } });
      else if (owner && owner !== mapped.item_code) issues.push({ kind: 'barcode_in_use', severity: 'error', params: { code: owner } });
      else firstLineOfBarcode.set(bc, line);
    }

    rows.push({
      line,
      item_code: mapped.item_code,
      name: mapped.name,
      status: 'skipped',
      patch: mapped.patch,
      changes: [],
      issues,
    });
  });

  // Warnings that need the whole file ------------------------------------
  const importable = rows.filter((r) => !r.issues.some((x) => x.severity === 'error'));

  type Pair = { row: PlannedRow; tier: 'general' | 'wireless'; ratio: number };
  const pairs: Pair[] = [];
  for (const r of importable) {
    const p = r.patch;
    if (p.price_usd && p.price_syp) pairs.push({ row: r, tier: 'general', ratio: p.price_syp / p.price_usd });
    if (p.wireless_price_usd && p.wireless_price_syp) pairs.push({ row: r, tier: 'wireless', ratio: p.wireless_price_syp / p.wireless_price_usd });
  }
  const medianRatio = pairs.length >= MIN_RATIOS_FOR_MEDIAN ? median(pairs.map((x) => x.ratio)) : null;
  if (medianRatio) {
    for (const x of pairs) {
      const dev = x.ratio / medianRatio - 1;
      if (Math.abs(dev) > RATIO_TOLERANCE) {
        x.row.issues.push({
          kind: 'ratio',
          severity: 'warning',
          params: { tier: x.tier, ratio: Math.round(x.ratio), median: Math.round(medianRatio), pct: Math.round(dev * 100) },
        });
      }
    }
  }

  for (const r of importable) {
    const p = r.patch;
    if (p.wireless_price_usd != null && p.price_usd != null && p.wireless_price_usd > p.price_usd) {
      r.issues.push({ kind: 'wireless_higher', severity: 'warning', params: { currency: 'USD', wireless: p.wireless_price_usd, general: p.price_usd } });
    }
    if (p.wireless_price_syp != null && p.price_syp != null && p.wireless_price_syp > p.price_syp) {
      r.issues.push({ kind: 'wireless_higher', severity: 'warning', params: { currency: 'SYP', wireless: p.wireless_price_syp, general: p.price_syp } });
    }
  }

  // Status + payload ------------------------------------------------------
  const payload: ImportPlan['payload'] = [];
  for (const r of rows) {
    if (r.issues.some((x) => x.severity === 'error')) {
      r.status = 'skipped';
      continue;
    }
    const current = byCode.get(r.item_code);
    const keys = Object.keys(r.patch) as PatchKey[];
    if (!current) {
      r.status = 'new';
      r.changes = keys;
      payload.push({ item_code: r.item_code, ...r.patch });
      continue;
    }
    if (!current.active) r.issues.push({ kind: 'inactive_match', severity: 'note' });
    const changed = keys.filter((k) => !same(r.patch[k], current[k]));
    r.changes = changed;
    if (changed.length === 0) {
      r.status = 'unchanged';
    } else {
      r.status = 'update';
      const diff: ProductPatch = {};
      for (const k of changed) (diff as Record<string, unknown>)[k] = r.patch[k];
      payload.push({ item_code: r.item_code, ...diff });
    }
  }

  const counts: Record<RowStatus, number> = { new: 0, update: 0, unchanged: 0, skipped: 0 };
  for (const r of rows) counts[r.status]++;

  return {
    ok: true,
    plan: {
      format,
      rows,
      counts,
      warningRows: rows.filter((r) => r.status !== 'skipped' && r.issues.some((x) => x.severity === 'warning')).length,
      medianRatio,
      payload,
    },
  };
}
