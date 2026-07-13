import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';

import { Body, Button, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatTime } from '@/hooks/useData';
import { formatEta } from '@/hooks/useLiveRoute';
import { useLoader } from '@/hooks/useLoader';
import { supabase } from '@/lib/supabase';
import type { ActiveTrip, Incident } from '@/lib/types';
import { spacing } from '@/theme';

/**
 * A transport office view: which buses are on the road, and what is going wrong.
 *
 * Intentionally read-only plus acknowledge. Managing routes, rosters and fees on
 * a phone is miserable; that belongs in a web console. What genuinely needs to
 * be answerable from a phone -- "is a bus in trouble right now" -- is here.
 */
export function AdminHome() {
  const [trips, setTrips] = useState<ActiveTrip[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [{ data: t }, { data: i }] = await Promise.all([
      supabase.from('v_active_trips').select('*'),
      supabase
        .from('incidents')
        .select('*')
        .neq('status', 'resolved')
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    setTrips(t ?? []);
    setIncidents(i ?? []);
    setLoading(false);
  }, []);

  useLoader(load);

  useEffect(() => {
    const channel = supabase
      .channel('admin-incidents')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bus_live' }, () => void load())
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  async function acknowledge(id: string) {
    const { error } = await supabase.rpc('acknowledge_incident', { p_incident_id: id });
    if (error) Alert.alert('Could not acknowledge', error.message);
    else await load();
  }

  async function resolve(id: string) {
    const { error } = await supabase.rpc('resolve_incident', { p_incident_id: id });
    if (error) Alert.alert('Could not resolve', error.message);
    else await load();
  }

  if (loading) return <Loading label="Loading the fleet…" />;

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}>
      <Title sub="Live fleet and anything that needs attention.">Transport office</Title>

      {incidents.length > 0 ? (
        <View style={{ gap: spacing.md }}>
          <Label>Open incidents</Label>
          {incidents.map((inc) => {
            const critical = inc.kind === 'sos' || inc.kind === 'accident';
            return (
              <Card key={inc.id}>
                <Row>
                  <Pill
                    label={inc.kind.replace('_', ' ')}
                    tone={critical ? 'bad' : 'live'}
                  />
                  <Body muted>{formatTime(inc.created_at)}</Body>
                </Row>

                {inc.note ? <Body>{inc.note}</Body> : null}

                {inc.lat != null ? (
                  <Body muted>
                    Location: {inc.lat.toFixed(5)}, {inc.lng?.toFixed(5)}
                  </Body>
                ) : null}

                <Row style={{ marginTop: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    {inc.status === 'open' ? (
                      <Button
                        label="Acknowledge"
                        variant={critical ? 'danger' : 'primary'}
                        onPress={() => void acknowledge(inc.id)}
                      />
                    ) : (
                      <Button
                        label="Mark resolved"
                        variant="secondary"
                        onPress={() => void resolve(inc.id)}
                      />
                    )}
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
      ) : null}

      <Label>Buses on the road</Label>

      {trips.length === 0 ? (
        <Empty title="No buses running" hint="Trips appear here once a driver starts one." />
      ) : null}

      {trips.map((trip) => (
        <Card key={trip.trip_id}>
          <Row>
            <View style={{ flex: 1, gap: 2 }}>
              <Body>{trip.bus_name}</Body>
              <Body muted>{trip.route_name}</Body>
            </View>
            <Pill label="Live" tone="live" />
          </Row>

          <Row style={{ marginTop: spacing.sm }}>
            <View style={{ gap: 2 }}>
              <Label>Next stop</Label>
              <Body muted>{trip.next_stop_name ?? '—'}</Body>
            </View>
            <View style={{ gap: 2, alignItems: 'flex-end' }}>
              <Label>ETA</Label>
              <Body muted>{formatEta(trip.eta_seconds)}</Body>
            </View>
          </Row>

          <Body muted>
            {trip.driver_name}
            {trip.recorded_at ? ` · last seen ${formatTime(trip.recorded_at)}` : ''}
          </Body>
        </Card>
      ))}
    </Screen>
  );
}
