import { useCallback, useEffect, useMemo, useState } from 'react';

import { supabase } from '@/lib/supabase';
import type { ActiveTrip, BusLive, Stop, TripStopEvent } from '@/lib/types';

import { useLoader } from './useLoader';

export type RouteStopView = Stop & {
  seq: number;
  offset_minutes: number;
  /** When the bus actually reached this stop on the current trip, if it has. */
  arrived_at: string | null;
};

/**
 * The live picture of one route: its stops in order, the trip currently running
 * it, and the bus's position updating in real time.
 *
 * The initial position comes from v_active_trips; every position after that
 * arrives over a realtime subscription to `bus_live`, which is one row per bus.
 * We deliberately do NOT subscribe to `bus_locations` -- that is the raw GPS
 * firehose and would push a row to every phone every five seconds.
 */
export function useLiveRoute(routeId: string | null) {
  const [stops, setStops] = useState<RouteStopView[]>([]);
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!routeId) {
      setStops([]);
      setTrip(null);
      setLoading(false);
      return;
    }

    // Two queries rather than one embedded join: the join would depend on
    // PostgREST relationship metadata, and this stays readable and type-safe.
    const [{ data: rs }, { data: activeTrip }] = await Promise.all([
      supabase
        .from('route_stops')
        .select('stop_id, seq, offset_minutes')
        .eq('route_id', routeId)
        .order('seq'),
      supabase.from('v_active_trips').select('*').eq('route_id', routeId).maybeSingle(),
    ]);

    const ids = (rs ?? []).map((r) => r.stop_id);
    let arrivals: TripStopEvent[] = [];

    if (activeTrip?.trip_id) {
      const { data } = await supabase
        .from('trip_stop_events')
        .select('*')
        .eq('trip_id', activeTrip.trip_id);
      arrivals = data ?? [];
    }

    if (ids.length) {
      const { data: stopRows } = await supabase.from('stops').select('*').in('id', ids);
      const byId = new Map((stopRows ?? []).map((s) => [s.id, s]));
      const arrivedBy = new Map(arrivals.map((a) => [a.stop_id, a.arrived_at]));

      const merged = (rs ?? [])
        .map((r) => {
          const stop = byId.get(r.stop_id);
          if (!stop) return null;
          return {
            ...stop,
            seq: r.seq,
            offset_minutes: r.offset_minutes,
            arrived_at: arrivedBy.get(r.stop_id) ?? null,
          };
        })
        .filter((s): s is RouteStopView => s !== null);

      setStops(merged);
    } else {
      setStops([]);
    }

    setTrip(activeTrip ?? null);
    setLoading(false);
  }, [routeId]);

  useLoader(load);

  useEffect(() => {
    if (!routeId) return;

    const channel = supabase
      .channel(`live-route-${routeId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bus_live', filter: `route_id=eq.${routeId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            // end_trip deletes the live row -- the bus has stopped running.
            setTrip(null);
            return;
          }

          const live = payload.new as BusLive;

          setTrip((prev) => {
            // The very first fix of a trip can arrive before our v_active_trips
            // fetch has returned. Refetch rather than invent a partial trip.
            if (!prev) {
              void load();
              return prev;
            }

            // Merge only the fields that actually move. Spreading the whole
            // bus_live row would drag its nullable trip_id over the trip's own
            // non-null one, and drop the route/driver/bus names it does not have.
            return {
              ...prev,
              lat: live.lat,
              lng: live.lng,
              heading: live.heading,
              speed_kmh: live.speed_kmh,
              eta_seconds: live.eta_seconds,
              next_stop_id: live.next_stop_id,
              recorded_at: live.recorded_at,
            };
          });
        },
      )
      // A trip ending, or a geofence firing, changes which stops are "done".
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trip_stop_events' },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [routeId, load]);

  const nextStop = useMemo(
    () => stops.find((s) => s.id === trip?.next_stop_id) ?? null,
    [stops, trip?.next_stop_id],
  );

  return { stops, trip, nextStop, loading, refresh: load };
}

/** "4 min" / "just arriving" / "--" -- never a bare number of seconds. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null) return '--';
  if (seconds < 60) return 'arriving now';
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}
