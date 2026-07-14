import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useLoader } from '@/hooks/useLoader';

import { useAuth } from './auth';
import { supabase } from './supabase';
import type { AppNotification } from './types';

/**
 * ONE notifications store for the whole app.
 *
 * This is a provider rather than a plain hook because two different components
 * need the same data: the Alerts screen renders the list, and the tab bar needs
 * the unread count for its badge. Calling a fetching hook in both places was a
 * genuine bug on three counts:
 *
 *   1. Two realtime subscriptions opened with the SAME channel topic.
 *   2. Every notification fetched twice.
 *   3. Worst: the tab layout owned fetching state, so its setState re-rendered
 *      the whole <Tabs> navigator -- and when that landed mid tab-transition,
 *      React Navigation tried to mount a screen view that was already mounted:
 *
 *        IllegalStateException: addViewAt: failed to insert view [170] into
 *        parent [90] -- The specified child already has a parent.
 *
 *      Tapping the Alerts tab crashed the app, every time.
 *
 * Hoisting the state above the navigator means the fetch resolves once, at sign
 * in, instead of racing the navigation that reads it.
 */

type NotificationsState = {
  items: AppNotification[];
  unread: number;
  loading: boolean;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
};

const NotificationsContext = createContext<NotificationsState | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const profileId = profile?.id ?? null;

  const refresh = useCallback(async () => {
    if (!profileId) {
      setItems([]);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) console.warn('[notifications]', error.message);
    setItems(data ?? []);
    setLoading(false);
  }, [profileId]);

  useLoader(refresh);

  useEffect(() => {
    if (!profileId) return;

    // RLS applies to realtime too, so this only ever delivers rows addressed to
    // us -- no client-side filtering needed, and none possible to bypass.
    const channel = supabase
      .channel(`notifications-${profileId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `profile_id=eq.${profileId}`,
        },
        (payload) => {
          const row = payload.new as AppNotification;
          setItems((prev) =>
            // A realtime row can arrive while the initial fetch is still in
            // flight, and then show up in that fetch too. Two React children
            // with the same key is its own crash, so guard against it.
            prev.some((n) => n.id === row.id) ? prev : [row, ...prev],
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId]);

  const markRead = useCallback(async (id: string) => {
    const readAt = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: readAt } : n)));
    await supabase.from('notifications').update({ read_at: readAt }).eq('id', id);
  }, []);

  const value = useMemo<NotificationsState>(
    () => ({
      items,
      unread: items.filter((n) => !n.read_at).length,
      loading,
      refresh,
      markRead,
    }),
    [items, loading, refresh, markRead],
  );

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationsProvider>');
  return ctx;
}
