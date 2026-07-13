import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, RefreshControl, View } from 'react-native';

import { Body, Button, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatTime } from '@/hooks/useData';
import { useLoader } from '@/hooks/useLoader';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import {
  getActiveTripId,
  getPendingCount,
  isTracking,
  requestTrackingPermissions,
  startTracking,
  stopTracking,
} from '@/lib/tracking';
import type { IncidentKind, Trip } from '@/lib/types';
import { spacing, useTheme } from '@/theme';

type TripRow = Trip & { route_name: string; bus_name: string };

export function DriverHome() {
  const t = useTheme();
  const { profile } = useAuth();

  const [trips, setTrips] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [pending, setPending] = useState(0);

  const load = useCallback(async () => {
    if (!profile) return;

    const today = new Date().toISOString().slice(0, 10);

    const { data: tripRows } = await supabase
      .from('trips')
      .select('*')
      .eq('driver_id', profile.id)
      .eq('service_date', today)
      .order('direction');

    const rows = tripRows ?? [];

    // Names for display. Two small queries beats depending on embedded-join
    // typing, and these tables are tiny.
    const routeIds = [...new Set(rows.map((r) => r.route_id))];
    const busIds = [...new Set(rows.map((r) => r.bus_id))];

    const [{ data: routes }, { data: buses }] = await Promise.all([
      supabase.from('routes').select('id, name').in('id', routeIds),
      supabase.from('buses').select('id, display_name').in('id', busIds),
    ]);

    const routeName = new Map((routes ?? []).map((r) => [r.id, r.name]));
    const busName = new Map((buses ?? []).map((b) => [b.id, b.display_name]));

    setTrips(
      rows.map((r) => ({
        ...r,
        route_name: routeName.get(r.route_id) ?? 'Route',
        bus_name: busName.get(r.bus_id) ?? 'Bus',
      })),
    );
    setLoading(false);
  }, [profile]);

  const syncTrackingState = useCallback(async () => {
    setTracking(await isTracking());
    setPending(await getPendingCount());
  }, []);

  useLoader(load);
  useLoader(syncTrackingState);

  // The driver will background the app the moment the bus moves -- that is the
  // whole point. Re-sync whenever they come back so the UI is never lying about
  // whether tracking is running.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void load();
        void syncTrackingState();
      }
    });
    return () => sub.remove();
  }, [load, syncTrackingState]);

  const active = trips.find((tr) => tr.status === 'active') ?? null;

  // The OS can kill a background task -- battery saver, a force-quit, a reboot.
  // If the database still thinks a trip is running but the phone is not
  // reporting, every rider sees a bus frozen in the road. Detect it and offer to
  // resume rather than waiting for someone to phone the school.
  useEffect(() => {
    if (!active || tracking) return;

    let cancelled = false;
    void (async () => {
      const stored = await getActiveTripId();
      if (cancelled || stored === active.id) return;

      Alert.alert(
        'Trip is running but not reporting',
        'This bus is marked as on the road, but your phone stopped sending its location. Resume sharing?',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Resume', onPress: () => void begin(active, { resume: true }) },
        ],
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, tracking]);

  async function begin(trip: TripRow, opts?: { resume?: boolean }) {
    setBusy(true);
    try {
      const perm = await requestTrackingPermissions();

      if (!perm.ok) {
        Alert.alert(
          'Location permission needed',
          perm.reason === 'foreground-denied'
            ? 'BusTracker cannot share the bus position without location access.'
            : // This is the one users get wrong, so name the exact setting.
              'Please set location access to "Allow all the time". With "While using the app", the bus disappears from every student\'s map the moment your screen turns off.',
        );
        return;
      }

      if (!opts?.resume) {
        const { error } = await supabase.rpc('start_trip', { p_trip_id: trip.id });
        if (error) throw new Error(error.message);
      }

      await startTracking(trip.id);
      await load();
      await syncTrackingState();
    } catch (e) {
      Alert.alert('Could not start trip', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function finish(trip: TripRow) {
    Alert.alert('End this trip?', 'The bus will disappear from the live map.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End trip',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              // Stop the GPS first. If end_trip succeeded but the task kept
              // running, the next fix would be rejected by the RPC and the
              // driver would see errors for a trip they already closed.
              await stopTracking();

              const { error } = await supabase.rpc('end_trip', { p_trip_id: trip.id });
              if (error) throw new Error(error.message);

              await load();
              await syncTrackingState();
            } catch (e) {
              Alert.alert('Could not end trip', e instanceof Error ? e.message : 'Unknown error');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  function report(trip: TripRow, kind: IncidentKind, label: string) {
    Alert.alert(
      `Report ${label.toLowerCase()}?`,
      kind === 'accident'
        ? 'This immediately alerts the school and the parents of every child on this bus.'
        : 'This alerts the school and everyone travelling on this route.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Report ${label.toLowerCase()}`,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const { error } = await supabase.rpc('report_incident', {
                p_trip_id: trip.id,
                p_kind: kind,
                p_note: null,
                p_lat: null,
                p_lng: null,
              });

              Alert.alert(
                error ? 'Could not send' : 'Reported',
                error ? error.message : 'The school and affected families have been notified.',
              );
            })();
          },
        },
      ],
    );
  }

  if (loading) return <Loading label="Loading today's trips…" />;

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}>
      <Title sub={profile?.full_name ?? undefined}>Today&apos;s trips</Title>

      {tracking ? (
        <Card style={{ backgroundColor: t.liveSoft, borderColor: t.liveDeep }}>
          <Row>
            <View style={{ flex: 1, gap: 2 }}>
              <Body>Sharing location</Body>
              <Body muted>
                {pending > 0
                  ? `${pending} location${pending === 1 ? '' : 's'} waiting to upload — no signal.`
                  : 'Students and parents can see this bus.'}
              </Body>
            </View>
            <Pill label="Live" tone="live" />
          </Row>
        </Card>
      ) : null}

      {trips.length === 0 ? (
        <Empty
          title="No trips scheduled today"
          hint="The school office assigns trips. If you were expecting one, contact them."
        />
      ) : null}

      {trips.map((trip) => {
        const isActive = trip.status === 'active';
        const isDone = trip.status === 'completed';

        return (
          <Card key={trip.id}>
            <Row>
              <View style={{ flex: 1, gap: 2 }}>
                <Label>{trip.direction === 'inbound' ? 'Morning — to campus' : 'Evening — to home'}</Label>
                <Body>{trip.route_name}</Body>
                <Body muted>{trip.bus_name}</Body>
              </View>
              <Pill
                label={isActive ? 'Running' : isDone ? 'Done' : 'Scheduled'}
                tone={isActive ? 'live' : isDone ? 'good' : 'neutral'}
              />
            </Row>

            {trip.started_at ? (
              <Body muted>
                Started {formatTime(trip.started_at)}
                {trip.ended_at ? ` · Ended ${formatTime(trip.ended_at)}` : ''}
              </Body>
            ) : null}

            <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              {trip.status === 'scheduled' ? (
                <Button label="Start trip" onPress={() => void begin(trip)} loading={busy} />
              ) : null}

              {isActive ? (
                <>
                  <Button
                    label="End trip"
                    variant="danger"
                    onPress={() => finish(trip)}
                    loading={busy}
                  />

                  <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
                    <Label>Report a problem</Label>
                    <Button
                      label="Route diverted"
                      variant="secondary"
                      onPress={() => report(trip, 'route_change', 'Route change')}
                    />
                    <Button
                      label="Breakdown"
                      variant="secondary"
                      onPress={() => report(trip, 'breakdown', 'Breakdown')}
                    />
                    <Button
                      label="Accident"
                      variant="live"
                      onPress={() => report(trip, 'accident', 'Accident')}
                    />
                  </View>
                </>
              ) : null}
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
