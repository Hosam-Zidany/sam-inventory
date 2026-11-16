import { normalizeDigits } from './number';

/**
 * Search key: lower-case, Arabic digits -> ASCII, diacritics/tatweel removed and
 * the common letter variants folded (أ إ آ -> ا, ى -> ي, ة -> ه) so staff find
 * "راوتر" however it was typed.
 */
export function searchKey(s: string | null | undefined): string {
  if (!s) return '';
  return normalizeDigits(s)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}
