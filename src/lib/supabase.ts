import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Product } from './types';

/**
 * Connection settings come from, in order:
 *   1. build-time env vars NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   2. a value the user pasted into the in-app setup screen (kept in this browser only)
 * Option 2 lets the site be deployed without any build settings and configured from a phone.
 * Only the PUBLIC anon key is ever used here; row-level security protects the data.
 */
const STORAGE_KEY = 'sam-supabase-config';

export interface SupabaseConfig {
  url: string;
  key: string;
}

export function readConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && key) return { url, key };
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SupabaseConfig>;
    return parsed.url && parsed.key ? { url: parsed.url, key: parsed.key } : null;
  } catch {
    return null;
  }
}

export const isSupabaseConfigured = (): boolean => readConfig() !== null;

export type ConfigProblem = 'bad_url' | 'empty_key' | 'secret_key';

/** Checks what the user pasted. Refuses the secret/service key: it would bypass all security. */
export function validateConfig(url: string, key: string): ConfigProblem | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) return 'bad_url';
  } catch {
    return 'bad_url';
  }
  const k = key.trim();
  if (!k) return 'empty_key';
  if (k.startsWith('sb_secret_')) return 'secret_key';
  const payload = k.split('.')[1];
  if (payload) {
    try {
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (json?.role === 'service_role') return 'secret_key';
    } catch {
      /* not a JWT: fine (new-style publishable keys are not JWTs) */
    }
  }
  return null;
}

export function saveConfig(url: string, key: string): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: url.trim().replace(/\/+$/, ''), key: key.trim() }));
}

export function clearConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

let client: SupabaseClient | null = null;

/** Browser-side client. Security lives in Postgres (RLS + RPC role checks), not here. */
export function getSupabase(): SupabaseClient {
  const cfg = readConfig();
  if (!cfg) throw new Error('Supabase is not configured');
  client ??= createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

const PAGE = 1000; // PostgREST returns at most 1000 rows per request

export async function fetchAllProducts(): Promise<Product[]> {
  const sb = getSupabase();
  const out: Product[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('products')
      .select('*')
      .order('item_code')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as Product[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}
