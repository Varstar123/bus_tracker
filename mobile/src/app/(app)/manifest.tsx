import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, Text, View, type ViewStyle } from 'react-native';

import { Body, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatTime } from '@/hooks/useData';
import { useLoader } from '@/hooks/useLoader';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { ManifestRow, RideEventType } from '@/lib/types';
import { radius, spacing, useTheme } from '@/theme';

/**
 * The one thing a geofence genuinely cannot tell us.
 *
 * GPS proves the bus reached the stop. It cannot prove a child walked onto it.
 * So the driver taps, and that tap -- not a guess -- is what tells a parent
 * their child is aboard. Every automatic event in this app is derived; this one
 * is observed, and it is the reason the parent alerts can be trusted at all.
 */
export default function Manifest() {
  const t = useTheme();
  const { profile } = useAuth();

  const [rows, setRows] = useState<ManifestRow[]>([]);
  const [tripId, setTripId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;

    const { data: trip } = await supabase
      .from('trips')
      .select('id')
      .eq('driver_id', profile.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!trip) {
      setTripId(null);
      setRows([]);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from('v_trip_manifest')
      .select('*')
      .eq('trip_id', trip.id)
      .order('seq')
      .order('full_name');

    if (error) console.warn('[manifest]', error.message);

    setTripId(trip.id);
    setRows(data ?? []);
    setLoading(false);
  }, [profile]);

  useLoader(load);

  async function mark(row: ManifestRow, event: RideEventType) {
    if (!tripId || !profile) return;
    setSaving(row.rider_id);

    // Optimistic: a driver at a stop with twenty kids climbing aboard cannot
    // wait on a round trip per tap. The insert is authorised by RLS, so a
    // rejected write simply reverts on the reload below.
    setRows((prev) =>
      prev.map((r) =>
        r.rider_id === row.rider_id
          ? { ...r, marked_as: event as 'boarded' | 'absent', marked_at: new Date().toISOString() }
          : r,
      ),
    );

    const { error } = await supabase.from('ride_events').insert({
      org_id: profile.org_id,
      rider_id: row.rider_id,
      trip_id: tripId,
      stop_id: row.stop_id,
      event_type: event,
      source: 'driver',
      recorded_by: profile.id,
    });

    if (error) {
      Alert.alert('Could not save', error.message);
      await load();
    }

    setSaving(null);
  }

  if (loading) return <Loading label="Loading the manifest…" />;

  if (!tripId) {
    return (
      <Screen>
        <Empty
          title="No trip running"
          hint="Start a trip from the Trip tab, and the students expected at each stop will appear here."
        />
      </Screen>
    );
  }

  // Group by stop, in the order the bus will actually meet them.
  const stops = [...new Map(rows.map((r) => [r.stop_id, r])).values()];

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}>
      <Title sub="Tap each student as they board, or mark them absent.">Manifest</Title>

      {rows.length === 0 ? (
        <Empty title="Nobody assigned to this route" hint="The school office assigns students to routes." />
      ) : null}

      {stops.map((stop) => {
        const atStop = rows.filter((r) => r.stop_id === stop.stop_id);

        return (
          <View key={stop.stop_id} style={{ gap: spacing.sm }}>
            <Row>
              <Label>
                Stop {stop.seq} · {stop.stop_name}
              </Label>
              {stop.stop_arrived_at ? (
                <Body muted>Reached {formatTime(stop.stop_arrived_at)}</Body>
              ) : null}
            </Row>

            {atStop.map((row) => (
              <Card key={row.rider_id}>
                <Row>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Body>{row.full_name}</Body>
                    {row.class_section ? <Body muted>{row.class_section}</Body> : null}
                  </View>

                  {row.marked_as ? (
                    <Pill
                      label={row.marked_as === 'boarded' ? 'Boarded' : 'Absent'}
                      tone={row.marked_as === 'boarded' ? 'good' : 'bad'}
                    />
                  ) : null}
                </Row>

                <Row style={{ marginTop: spacing.sm, gap: spacing.sm }}>
                  <Pressable
                    onPress={() => void mark(row, 'boarded')}
                    disabled={saving === row.rider_id}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark ${row.full_name} as boarded`}
                    style={({ pressed }) => [
                      choiceStyle,
                      {
                        backgroundColor: row.marked_as === 'boarded' ? t.brand : t.surfaceAlt,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}>
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: '600',
                        color: row.marked_as === 'boarded' ? '#fff' : t.text,
                      }}>
                      {row.marked_as === 'boarded' ? '✓ Boarded' : 'Boarded'}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => void mark(row, 'absent')}
                    disabled={saving === row.rider_id}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark ${row.full_name} as absent`}
                    style={({ pressed }) => [
                      choiceStyle,
                      {
                        backgroundColor: row.marked_as === 'absent' ? t.danger : t.surfaceAlt,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}>
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: '600',
                        color: row.marked_as === 'absent' ? '#fff' : t.text,
                      }}>
                      Absent
                    </Text>
                  </Pressable>
                </Row>
              </Card>
            ))}
          </View>
        );
      })}
    </Screen>
  );
}

const choiceStyle: ViewStyle = {
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  paddingVertical: spacing.md,
  borderRadius: radius.sm,
  minHeight: 46,
};
