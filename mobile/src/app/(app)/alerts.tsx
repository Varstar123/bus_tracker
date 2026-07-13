import { RefreshControl, View } from 'react-native';

import { Body, Card, Empty, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatDay, formatTime, useNotifications } from '@/hooks/useData';
import type { Severity } from '@/lib/types';
import { spacing, useTheme } from '@/theme';

function toneFor(severity: Severity): 'neutral' | 'live' | 'bad' {
  if (severity === 'critical') return 'bad';
  if (severity === 'warning') return 'live';
  return 'neutral';
}

function labelFor(severity: Severity): string {
  if (severity === 'critical') return 'Emergency';
  if (severity === 'warning') return 'Attention';
  return 'Info';
}

export default function Alerts() {
  const t = useTheme();
  const { items, loading, refresh, markRead } = useNotifications();

  if (loading) return <Loading />;

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}>
      <Title sub="Arrivals, delays, emergencies and receipts.">Alerts</Title>

      {items.length === 0 ? (
        <Empty
          title="Nothing yet"
          hint="Bus arrivals, delays and safety alerts will show up here."
        />
      ) : null}

      {items.map((n) => {
        const unread = !n.read_at;

        return (
          <Card
            key={n.id}
            onPress={unread ? () => void markRead(n.id) : undefined}
            style={
              unread
                ? {
                    // A quiet left rule, not a loud background: the list stays
                    // readable when everything is unread, which is the normal
                    // state for a parent opening the app after school.
                    borderLeftWidth: 3,
                    borderLeftColor: n.severity === 'critical' ? t.danger : t.live,
                  }
                : { opacity: 0.72 }
            }>
            <Row>
              <Pill label={labelFor(n.severity)} tone={toneFor(n.severity)} />
              <Body muted>
                {formatDay(n.created_at)} · {formatTime(n.created_at)}
              </Body>
            </Row>

            <View style={{ gap: 3, marginTop: spacing.xs }}>
              <Body>{n.title}</Body>
              <Body muted>{n.body}</Body>
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
