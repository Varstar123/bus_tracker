import { useMemo } from 'react';
import { View } from 'react-native';

import { BusMap } from '@/components/BusMap';
import { SosButton } from '@/components/SosButton';
import { Body, Card, Empty, Label, Loading, Pill, Row, Screen } from '@/components/ui';
import { useMyRiders } from '@/hooks/useData';
import { formatEta, useLiveRoute } from '@/hooks/useLiveRoute';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

/**
 * What a student or a lecturer opens the app for: where is my bus, and when does
 * it get to my stop. Everything else on this screen is secondary to those two
 * numbers, so they are the largest things on it.
 */
export function RiderHome() {
  const { profile } = useAuth();
  const { riders, loading: ridersLoading } = useMyRiders();

  // A rider's own record is the one linked to their login.
  const me = useMemo(
    () => riders.find((r) => r.profile_id === profile?.id) ?? null,
    [riders, profile?.id],
  );

  const { stops, trip, nextStop, loading } = useLiveRoute(me?.route_id ?? null);

  // Morning: the bus is coming to collect me. Evening: it is taking me home.
  // Either way "my stop" is the one I care about the ETA for.
  const myStopId = trip?.direction === 'outbound' ? me?.drop_stop_id : me?.pickup_stop_id;
  const myStop = stops.find((s) => s.id === myStopId) ?? null;

  const heading = nextStop?.id === myStopId;
  const alreadyPassed = !!myStop?.arrived_at;

  if (ridersLoading || loading) return <Loading label="Finding your bus…" />;

  if (!me?.route_id) {
    return (
      <Screen>
        <Empty
          title="You're not on a bus route yet"
          hint="The school office assigns routes. Once they add you, your bus appears here."
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }}>
        <BusMap stops={stops} trip={trip} highlightStopId={myStopId} />
      </View>

      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <Card>
          <Row>
            <View style={{ gap: 2 }}>
              <Label>{alreadyPassed ? 'Bus passed your stop' : 'Arrives at your stop'}</Label>
              <Body>{myStop?.name ?? me.pickup_stop_name ?? 'Your stop'}</Body>
            </View>

            {trip ? (
              <View style={{ alignItems: 'flex-end' }}>
                <Body>
                  {/* Only show a countdown when the bus is genuinely heading for
                      MY stop. Showing the ETA to somebody else's stop would be a
                      confidently-wrong number, which is worse than none. */}
                  {alreadyPassed ? '—' : heading ? formatEta(trip.eta_seconds) : 'En route'}
                </Body>
                <Pill label="Live" tone="live" />
              </View>
            ) : (
              <Pill label="Not running" tone="neutral" />
            )}
          </Row>
        </Card>

        {trip ? (
          <Card>
            <Row>
              <View style={{ gap: 2, flex: 1 }}>
                <Label>Next stop</Label>
                <Body>{nextStop?.name ?? '—'}</Body>
              </View>
              <View style={{ gap: 2, alignItems: 'flex-end' }}>
                <Label>Driver</Label>
                <Body muted>{trip.driver_name}</Body>
              </View>
            </Row>
            <Body muted>
              {trip.bus_name}
              {trip.speed_kmh != null ? ` · ${Math.round(trip.speed_kmh)} km/h` : ''}
            </Body>
          </Card>
        ) : (
          <Card>
            <Body muted>
              Your bus is not on the road right now. It appears here as soon as the driver starts
              the trip.
            </Body>
          </Card>
        )}

        {/* Only meaningful while a trip is running -- an SOS from a bus that is
            parked at the depot would just confuse the office. */}
        {trip ? <SosButton /> : null}
      </View>
    </Screen>
  );
}
