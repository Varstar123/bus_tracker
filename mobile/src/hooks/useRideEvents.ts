import { useCallback, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { RideEvent } from '@/lib/types';

import { useLoader } from './useLoader';

export type RiderStatus = {
  label: string;
  tone: 'neutral' | 'live' | 'good' | 'bad';
  at: string | null;
};

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * The day's ride events for every rider the user can see. RLS restricts this to
 * their own children, so no rider filter is needed -- or possible to bypass.
 */
export function useRideEvents(riderId?: string) {
  const [events, setEvents] = useState<RideEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let q = supabase
      .from('ride_events')
      .select('*')
      .gte('occurred_at', startOfToday())
      .order('occurred_at', { ascending: true });

    if (riderId) q = q.eq('rider_id', riderId);

    const { data, error } = await q;
    if (error) console.warn('[ride_events]', error.message);

    setEvents(data ?? []);
    setLoading(false);
  }, [riderId]);

  useLoader(load);

  useEffect(() => {
    // The parent's whole reason for holding the phone is to watch this update.
    const channel = supabase
      .channel(`ride-events-${riderId ?? 'all'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ride_events' }, (p) => {
        const row = p.new as RideEvent;
        if (riderId && row.rider_id !== riderId) return;
        setEvents((prev) => [...prev, row]);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [riderId]);

  const byRider = useMemo(() => {
    const map = new Map<string, RideEvent[]>();
    for (const e of events) {
      const list = map.get(e.rider_id) ?? [];
      list.push(e);
      map.set(e.rider_id, list);
    }
    return map;
  }, [events]);

  return { events, byRider, loading, refresh: load };
}

/**
 * Turn a rider's event log into the one line a parent actually wants to read.
 *
 * The last event wins, because the events are a strict progression through the
 * day: boarded -> arrived at school -> boarded again -> dropped at stop.
 */
export function deriveStatus(events: RideEvent[] | undefined): RiderStatus {
  const last = events?.[events.length - 1];

  if (!last) {
    return { label: 'Not on the bus yet', tone: 'neutral', at: null };
  }

  switch (last.event_type) {
    case 'boarded':
      return { label: 'On the bus', tone: 'live', at: last.occurred_at };
    case 'arrived_campus':
      return { label: 'Reached school', tone: 'good', at: last.occurred_at };
    case 'arrived_stop':
    case 'alighted':
      // The honest wording. The bus reached their stop with them aboard -- we do
      // not know that they walked through their front door, and saying "reached
      // home" would be claiming a certainty we do not have.
      return { label: 'Dropped at stop', tone: 'good', at: last.occurred_at };
    case 'absent':
      return { label: 'Did not board', tone: 'bad', at: last.occurred_at };
    default:
      return { label: 'Not on the bus yet', tone: 'neutral', at: null };
  }
}

export function describeEvent(e: RideEvent): string {
  switch (e.event_type) {
    case 'boarded':
      return 'Boarded the bus';
    case 'alighted':
      return 'Got off the bus';
    case 'arrived_campus':
      return 'Reached school';
    case 'arrived_stop':
      return 'Dropped at their stop';
    case 'absent':
      return 'Was not at the stop';
    default:
      return e.event_type;
  }
}
