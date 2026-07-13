import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider, useAuth } from '@/lib/auth';
import { registerForPush } from '@/lib/push';
// Side-effect import, and it must stay at the top level of the app entry.
// TaskManager.defineTask has to have run before Android hands us a background
// location, and Android may relaunch the app headlessly -- with no screen
// mounted -- purely to deliver one. Registering inside a component would be too
// late and the fix would be dropped on the floor.
import '@/lib/tracking';

void SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) {
      void SplashScreen.hideAsync();
    }
  }, [loading]);

  // Register for push once we know who we are. Safe to call on every profile
  // change: it upserts on the token.
  useEffect(() => {
    if (profile) {
      void registerForPush(profile.id);
    }
  }, [profile]);

  // Tapping a push should land you on the thing it was about, not the home tab.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as {
        kind?: string;
        rider_id?: string;
      };

      if (data?.rider_id && data.kind !== 'approaching') {
        router.push(`/child/${data.rider_id}`);
      } else {
        router.push('/alerts');
      }
    });

    return () => sub.remove();
  }, [router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" />
        <Stack.Screen name="child/[riderId]" options={{ headerShown: true, title: '' }} />
      </Stack.Protected>

      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
