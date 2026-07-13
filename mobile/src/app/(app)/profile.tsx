import { View } from 'react-native';

import { Body, Button, Card, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { useMyRiders } from '@/hooks/useData';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Transport office',
  driver: 'Driver',
  student: 'Student',
  faculty: 'Faculty',
  parent: 'Parent',
};

export default function ProfileScreen() {
  const { profile, signOut } = useAuth();
  const { riders } = useMyRiders();

  if (!profile) return <Loading />;

  return (
    <Screen scroll>
      <Title>{profile.full_name}</Title>

      <Card>
        <Row>
          <Label>Role</Label>
          <Pill label={ROLE_LABEL[profile.role] ?? profile.role} tone="good" />
        </Row>

        <View style={{ gap: 2, marginTop: spacing.sm }}>
          <Label>Email</Label>
          <Body muted>{profile.email ?? '—'}</Body>
        </View>

        {profile.phone ? (
          <View style={{ gap: 2, marginTop: spacing.sm }}>
            <Label>Phone</Label>
            <Body muted>{profile.phone}</Body>
          </View>
        ) : null}
      </Card>

      {profile.role === 'parent' && riders.length > 0 ? (
        <Card>
          <Label>Children</Label>
          {riders.map((r) => (
            <View key={r.id} style={{ gap: 2, marginTop: spacing.sm }}>
              <Body>{r.full_name}</Body>
              <Body muted>
                {[r.class_section, r.route_name, r.pickup_stop_name].filter(Boolean).join(' · ')}
              </Body>
            </View>
          ))}
        </Card>
      ) : null}

      <View style={{ marginTop: spacing.md }}>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </View>

      <Body muted>
        To change your route, stop, or the people linked to your account, contact the school
        transport office — those are set from the school&apos;s roster, not from the app.
      </Body>
    </Screen>
  );
}
