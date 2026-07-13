import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase';

/**
 * How a notification behaves when it lands while the app is open. In SDK 57 the
 * old `shouldShowAlert` is gone -- banner and list are separate switches now.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Registers this device for push and stores the token against the profile.
 * Returns null (rather than throwing) whenever push is simply unavailable --
 * a simulator, a denied permission -- because none of those should block a
 * parent from using the rest of the app.
 */
export async function registerForPush(profileId: string): Promise<string | null> {
  // Push requires real hardware; simulators cannot receive it.
  if (!Device.isDevice) {
    console.log('[push] skipped: not a physical device');
    return null;
  }

  // Android needs a channel before any notification can be shown, and it must
  // exist before the token is requested.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('bus-alerts', {
      name: 'Bus alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#F59E0B',
      sound: 'default',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;

  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }

  if (status !== 'granted') {
    console.log('[push] permission denied');
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  if (!projectId) {
    console.warn('[push] no EAS projectId -- run `eas init` and set EXPO_PUBLIC_EAS_PROJECT_ID');
    return null;
  }

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

  // Tokens rotate (reinstall, restore from backup), so upsert on the token and
  // refresh last_seen_at. The edge function prunes tokens the push service
  // reports as dead.
  const { error } = await supabase.from('device_tokens').upsert(
    {
      profile_id: profileId,
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );

  if (error) {
    console.warn('[push] could not save token:', error.message);
    return null;
  }

  return token;
}
