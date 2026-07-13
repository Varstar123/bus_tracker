import type { ExpoConfig } from 'expo/config';

/**
 * Maps are MapLibre + OpenFreeMap (OpenStreetMap vector tiles). There is
 * deliberately no map API key anywhere in this file: Google's Maps SDK will not
 * issue a working key without a billing account and a card, which is a poor
 * trade for a project that only ever draws a line and a moving dot.
 */
const config: ExpoConfig = {
  name: 'BusTracker',
  slug: 'bustracker',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'bustracker',
  userInterfaceStyle: 'automatic',
  // The New Architecture is on by default from SDK 52 and is no longer a config
  // key -- setting it here is now a type error.

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'school.demo.bustracker',
    infoPlist: {
      // Required for the driver's phone to keep reporting with the screen off.
      UIBackgroundModes: ['location', 'fetch', 'remote-notification'],
    },
  },

  android: {
    package: 'school.demo.bustracker',
    adaptiveIcon: {
      backgroundColor: '#0B3D2E',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    '@maplibre/maplibre-react-native',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0B3D2E',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    [
      'expo-location',
      {
        // Wording matters: the iOS reviewer reads these strings, and a vague
        // one is a common rejection for "Always" location.
        locationWhenInUsePermission:
          'BusTracker uses your location to show the school bus on the map.',
        locationAlwaysAndWhenInUsePermission:
          'BusTracker shares this bus’s location with students and parents while you are driving a route, even when the screen is off.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-notifications',
      {
        color: '#0B3D2E',
      },
    ],
  ],

  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },

  extra: {
    eas: {
      // Replace after `eas init`. getExpoPushTokenAsync reads this.
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '',
    },
  },
};

export default config;
