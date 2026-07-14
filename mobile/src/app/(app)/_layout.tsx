import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { Loading } from '@/components/ui';
import { useNotifications } from '@/lib/notifications';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/theme';

/**
 * One tab bar, four audiences.
 *
 * Rather than three near-identical route groups, every role shares this layout
 * and hides the tabs that do not apply (`href: null` removes a screen from the
 * bar without unregistering the route). That keeps deep links like /alerts
 * working for everyone, and means a bug fixed in one tab is fixed for all.
 */
export default function AppLayout() {
  const t = useTheme();
  const { profile, loading } = useAuth();
  const { unread } = useNotifications();

  if (loading || !profile) return <Loading label="Loading your school…" />;

  const role = profile.role;
  const isDriver = role === 'driver';
  const isParent = role === 'parent';
  const isRider = role === 'student' || role === 'faculty';
  const isAdmin = role === 'admin';

  // Fees are billed to a rider. A driver has no bill; an admin manages them from
  // a back office, not a phone.
  const seesFees = isParent || isRider;

  const homeIcon = isDriver ? 'bus' : isParent ? 'people' : 'map';
  const homeLabel = isDriver ? 'Trip' : isParent ? 'Children' : isAdmin ? 'Fleet' : 'Map';

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: homeLabel,
          tabBarIcon: ({ color, size }) => <Ionicons name={homeIcon} size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="manifest"
        options={{
          title: 'Manifest',
          href: isDriver ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          // The badge is the whole point of the alerts tab -- a parent should be
          // able to tell from the home screen that something needs them.
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: t.liveDeep, color: '#fff' },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="fees"
        options={{
          title: 'Fees',
          href: seesFees ? undefined : null,
          tabBarIcon: ({ color, size }) => <Ionicons name="card" size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
