/** Arabic-Indic / Persian digits and separators -> ASCII. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ','); // Arabic thousands separator
}

export type ParsedNumber =
  | { state: 'empty' }
  | { state: 'ok'; value: number }
  | { state: 'invalid'; text: string };

/**
 * Parses a price cell. Strips commas, quotes, spaces and "$" (spec 4.7), accepts
 * Arabic digits. Anything else that is not a plain non-negative number
 * ("ضمن الطقم", "طقم مع الصحن (65700)", "-") is 'invalid' — the caller decides
 * what that means ("no standalone price" for the PDF format).
 */
export function parseNumber(raw: string | null | undefined): ParsedNumber {
  if (raw == null) return { state: 'empty' };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { state: 'empty' };
  const cleaned = normalizeDigits(trimmed).replace(/[\s,'"$ ‎‏]/g, '');
  if (/^\d+(\.\d+)?$/.test(cleaned)) return { state: 'ok', value: Number(cleaned) };
  return { state: 'invalid', text: trimmed };
}
