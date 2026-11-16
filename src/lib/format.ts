// Western digits in both languages: prices and receipts are read and compared
// as numbers, and mixing Arabic-Indic digits into them invites mistakes.
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const syp = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const formatUsd = (n: number | null | undefined) => (n == null ? '—' : usd.format(n));
export const formatSyp = (n: number | null | undefined) => (n == null ? '—' : syp.format(n));
