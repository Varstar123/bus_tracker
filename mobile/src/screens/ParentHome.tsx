import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { RefreshControl, View } from 'react-native';

import { Body, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatTime, useMyRiders } from '@/hooks/useData';
import { deriveStatus, useRideEvents } from '@/hooks/useRideEvents';
import { spacing, useTheme } from '@/theme';

/**
 * The parent's home screen answers exactly one question, for each child, in one
 * glance: where are they right now. Anything that does not serve that question
 * is a tap away, not on this screen.
 */
export function ParentHome() {
  const t = useTheme();
  const router = useRouter();
  const { riders, loading, refresh } = useMyRiders();
  const { byRider, loading: eventsLoading, refresh: refreshEvents } = useRideEvents();

  if (loading || eventsLoading) return <Loading label="Checking on your children…" />;

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => {
            void refresh();
            void refreshEvents();
          }}
        />
      }>
      <Title sub="Tap a child to see their bus and today's timeline.">Your children</Title>

      {riders.length === 0 ? (
        <Empty
          title="No children linked to your account"
          hint="The school office links parents to students. Ask them to add you, using this exact email address."
        />
      ) : null}

      {riders.map((rider) => {
        const status = deriveStatus(byRider.get(rider.id));

        return (
          <Card key={rider.id} onPress={() => router.push(`/child/${rider.id}`)}>
            <Row>
              <View style={{ flex: 1, gap: 3 }}>
                <Body>{rider.full_name}</Body>
                <Body muted>
                  {[rider.class_section, rider.route_name].filter(Boolean).join(' · ') ||
                    'No route assigned'}
                </Body>
              </View>
              <Ionicons name="chevron-forward" size={20} color={t.textMuted} />
            </Row>

            <Row style={{ marginTop: spacing.sm }}>
              <Pill label={status.label} tone={status.tone} />
              {status.at ? <Body muted>{formatTime(status.at)}</Body> : null}
            </Row>

            {rider.driver_name ? (
              <View style={{ marginTop: spacing.xs, gap: 2 }}>
                <Label>Driver</Label>
                <Body muted>
                  {rider.driver_name}
                  {rider.driver_phone ? ` · ${rider.driver_phone}` : ''}
                </Body>
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
