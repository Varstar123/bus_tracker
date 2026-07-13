import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Linking, View } from 'react-native';

import { BusMap } from '@/components/BusMap';
import { Body, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatTime, useMyRiders } from '@/hooks/useData';
import { formatEta, useLiveRoute } from '@/hooks/useLiveRoute';
import { deriveStatus, describeEvent, useRideEvents } from '@/hooks/useRideEvents';
import { radius, spacing, useTheme } from '@/theme';

export default function ChildDetail() {
  const t = useTheme();
  const { riderId } = useLocalSearchParams<{ riderId: string }>();

  const { riders, loading: ridersLoading } = useMyRiders();
  const rider = useMemo(() => riders.find((r) => r.id === riderId) ?? null, [riders, riderId]);

  const { events, loading: eventsLoading } = useRideEvents(riderId);
  const { stops, trip, nextStop, loading: routeLoading } = useLiveRoute(rider?.route_id ?? null);

  if (ridersLoading || eventsLoading || routeLoading) return <Loading />;

  // RLS already guarantees a parent cannot fetch someone else's child -- if we
  // got nothing back, either the id is wrong or it is not theirs. Same message
  // either way: never confirm that a rider exists but is off-limits.
  if (!rider) {
    return (
      <Screen>
        <Empty title="Not found" hint="This student is not linked to your account." />
      </Screen>
    );
  }

  const status = deriveStatus(events);

  // Morning the bus collects them; evening it takes them home.
  const myStopId = trip?.direction === 'outbound' ? rider.drop_stop_id : rider.pickup_stop_id;
  const headingToTheirStop = nextStop?.id === myStopId;

  return (
    <>
      <Stack.Screen options={{ title: rider.full_name }} />

      <Screen scroll>
        <Title sub={[rider.class_section, rider.route_name].filter(Boolean).join(' · ')}>
          {rider.full_name}
        </Title>

        <Card>
          <Row>
            <Pill label={status.label} tone={status.tone} />
            {status.at ? <Body muted>{formatTime(status.at)}</Body> : null}
          </Row>

          {trip ? (
            <Row style={{ marginTop: spacing.sm }}>
              <View style={{ gap: 2 }}>
                <Label>Bus is at</Label>
                <Body muted>{nextStop?.name ?? '—'}</Body>
              </View>
              <View style={{ gap: 2, alignItems: 'flex-end' }}>
                <Label>{headingToTheirStop ? 'Reaches their stop' : 'Next stop in'}</Label>
                <Body muted>{formatEta(trip.eta_seconds)}</Body>
              </View>
            </Row>
          ) : (
            <Body muted>The bus is not running right now.</Body>
          )}
        </Card>

        {trip ? (
          <View style={{ height: 260, borderRadius: radius.lg, overflow: 'hidden' }}>
            <BusMap stops={stops} trip={trip} highlightStopId={myStopId} followBus={false} />
          </View>
        ) : null}

        {rider.driver_name ? (
          <Card
            onPress={
              rider.driver_phone
                ? () => void Linking.openURL(`tel:${rider.driver_phone}`)
                : undefined
            }>
            <Row>
              <View style={{ flex: 1, gap: 2 }}>
                <Label>Driver</Label>
                <Body>{rider.driver_name}</Body>
                {rider.driver_phone ? <Body muted>{rider.driver_phone}</Body> : null}
              </View>
              {rider.driver_phone ? <Ionicons name="call" size={22} color={t.brand} /> : null}
            </Row>
          </Card>
        ) : null}

        <Label>Today</Label>

        {events.length === 0 ? (
          <Empty
            title="Nothing yet today"
            hint="Boarding, arrival at school and drop-off all appear here as they happen."
          />
        ) : null}

        {/* Newest last reads like a story of the day, which is how a parent
            catching up at 4pm wants to read it. */}
        {events.map((e, i) => {
          const last = i === events.length - 1;
          const stop = stops.find((s) => s.id === e.stop_id);

          return (
            <Row key={e.id} style={{ alignItems: 'flex-start', gap: spacing.lg }}>
              <View style={{ alignItems: 'center', width: 14 }}>
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    backgroundColor: last ? t.brand : t.border,
                    marginTop: 5,
                  }}
                />
                {!last ? (
                  <View style={{ width: 2, flex: 1, backgroundColor: t.border, minHeight: 28 }} />
                ) : null}
              </View>

              <View style={{ flex: 1, paddingBottom: spacing.lg, gap: 2 }}>
                <Body>{describeEvent(e)}</Body>
                <Body muted>
                  {formatTime(e.occurred_at)}
                  {stop ? ` · ${stop.name}` : ''}
                  {/* Being honest about provenance: a driver's tap is a human
                      observation, a geofence is an inference from GPS. */}
                  {e.source === 'geofence' ? ' · detected automatically' : ''}
                </Body>
              </View>
            </Row>
          );
        })}
      </Screen>
    </>
  );
}
