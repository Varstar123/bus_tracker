import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { supabase } from './supabase';
import type { Profile } from './types';

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  /** True until we know whether there is a session AND have tried to load a profile. */
  loading: boolean;
  /**
   * Signed in, but no profile row exists -- i.e. the email was never on a roster.
   * RLS gives this user access to nothing, so we show them a dead end rather
   * than an empty app they will file a bug about.
   */
  unprovisioned: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileChecked, setProfileChecked] = useState(false);

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.warn('[auth] could not load profile', error.message);
    }
    setProfile(data ?? null);
    setProfileChecked(true);
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        void loadProfile(data.session.user.id);
      } else {
        setProfileChecked(true);
      }
      setLoading(false);
    });

    // Fires on sign-in, sign-out, and every token refresh. Refreshes carry the
    // same user, so re-fetching the profile on each one would be a needless
    // query every hour -- hence the id comparison below.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession((prev) => {
        const changedUser = prev?.user.id !== next?.user.id;
        if (changedUser) {
          setProfile(null);
          setProfileChecked(false);
          if (next) {
            void loadProfile(next.user.id);
          } else {
            setProfileChecked(true);
          }
        }
        return next;
      });
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setProfileChecked(true);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      loading: loading || (!!session && !profileChecked),
      unprovisioned: !!session && profileChecked && !profile,
      signIn,
      signOut,
    }),
    [session, profile, loading, profileChecked, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
