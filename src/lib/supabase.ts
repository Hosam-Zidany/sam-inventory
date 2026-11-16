import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Product } from './types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

/** Browser-side client. Security lives in Postgres (RLS + RPC role checks), not here. */
export function getSupabase(): SupabaseClient {
  if (!url || !key) throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  client ??= createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
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
