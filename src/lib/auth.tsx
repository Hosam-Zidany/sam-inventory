'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from './supabase';
import type { Role } from './types';

type AuthState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed_out' }
  /** signed in; role is null when the account has no active staff_roles row */
  | { status: 'ready'; user: User; role: Role | null; fullName: string | null };

interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setState({ status: 'unconfigured' });
      return;
    }
    const sb = getSupabase();
    let alive = true;

    const apply = async (session: Session | null) => {
      if (!session) {
        if (alive) setState({ status: 'signed_out' });
        return;
      }
      const { data } = await sb
        .from('staff_roles')
        .select('role, full_name, active')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (!alive) return;
      const ok = data?.active === true;
      setState({
        status: 'ready',
        user: session.user,
        role: ok ? (data!.role as Role) : null,
        fullName: data?.full_name ?? null,
      });
    };

    sb.auth.getSession().then(({ data }) => apply(data.session));
    // Do not await Supabase calls inside this callback (it can deadlock the client).
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => apply(session), 0);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Role of the signed-in user, or null. Only meaningful under <RequireRole>. */
export function useRole(): Role | null {
  const { state } = useAuth();
  return state.status === 'ready' ? state.role : null;
}
