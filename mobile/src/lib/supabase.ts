import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import 'react-native-url-polyfill/auto';

import type { Database } from './types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy mobile/.env.example to mobile/.env and restart the dev server ' +
      '(env vars are inlined at build time, so a hot reload will not pick them up).',
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // AsyncStorage, not SecureStore: the background location task needs to read
    // the session from a headless JS context, and SecureStore can be unavailable
    // there when the device is locked. The token is short-lived and the device
    // itself is the security boundary.
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  realtime: {
    // A bus ping every 5s across a few open routes; this is plenty of headroom
    // and keeps us well under the default connection quota.
    params: { eventsPerSecond: 10 },
  },
});

/**
 * supabase-js only refreshes tokens on a timer while the JS runtime is awake.
 * Without this, a phone that sat in a pocket for an hour resumes with a dead
 * token and every query 401s until something forces a refresh.
 */
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
