// Fails if messages/en.json and messages/ar.json differ in keys or {placeholders}.
import { readFileSync } from 'node:fs';

const load = (l) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8'));
const flatten = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${p}${k}.`) : [[`${p}${k}`, String(v)]]));

const en = new Map(flatten(load('en')));
const ar = new Map(flatten(load('ar')));
const problems = [];

for (const k of en.keys()) if (!ar.has(k)) problems.push(`missing in ar: ${k}`);
for (const k of ar.keys()) if (!en.has(k)) problems.push(`missing in en: ${k}`);
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const [k, v] of en) if (ar.has(k) && vars(v) !== vars(ar.get(k))) problems.push(`placeholder mismatch: ${k}`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`i18n OK: ${en.size} keys in both languages`);
