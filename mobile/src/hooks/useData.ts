import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { AppNotification, Invoice, RiderExpanded } from '@/lib/types';

import { useLoader } from './useLoader';

/**
 * Every rider the signed-in user may see. RLS decides what that means -- a
 * parent gets their children, a college student gets themselves, an admin gets
 * the school. The client sends the same query in all three cases.
 */
export function useMyRiders() {
  const { profile } = useAuth();
  const [riders, setRiders] = useState<RiderExpanded[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!profile) return;
    const { data, error } = await supabase
      .from('v_riders_expanded')
      .select('*')
      .eq('is_active', true)
      .order('full_name');

    if (error) console.warn('[riders]', error.message);
    setRiders(data ?? []);
    setLoading(false);
  }, [profile]);

  useLoader(load);

  return { riders, loading, refresh: load };
}

export function useNotifications() {
  const { profile } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!profile) return;
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    setItems(data ?? []);
    setLoading(false);
  }, [profile]);

  useLoader(load);

  useEffect(() => {
    if (!profile) return;

    // RLS is applied to realtime too, so this only ever delivers rows addressed
    // to us -- no client-side filtering needed, and none possible to bypass.
    const channel = supabase
      .channel(`notifications-${profile.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `profile_id=eq.${profile.id}`,
        },
        (payload) => {
          setItems((prev) => [payload.new as AppNotification, ...prev]);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profile]);

  const markRead = useCallback(async (id: string) => {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
  }, []);

  const unread = items.filter((n) => !n.read_at).length;

  return { items, unread, loading, refresh: load, markRead };
}

export function useInvoices() {
  const { profile } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!profile) return;
    const { data, error } = await supabase
      .from('v_my_invoices')
      .select('*')
      .order('due_date', { ascending: false });

    if (error) console.warn('[invoices]', error.message);
    setInvoices(data ?? []);
    setLoading(false);
  }, [profile]);

  useLoader(load);

  return { invoices, loading, refresh: load };
}

/** 120000 paise -> "₹1,200.00" */
export function formatMoney(paise: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
