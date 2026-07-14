import { useCallback, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Invoice, RiderExpanded } from '@/lib/types';

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
