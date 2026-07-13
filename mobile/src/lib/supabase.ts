import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import 'react-native-url-polyfill/auto';

import type { Database } from './types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;

// Supabase renamed the client-side key: new projects issue a "publishable key"
// (sb_publishable_...), older ones an "anon key" (a JWT starting eyJ...). They
// are the same thing to supabase-js, so accept either and let whichever you have
// win. Both are safe to ship inside the app -- RLS is what protects the data,
// not the key. The *secret* key (sb_secret_...) must never appear in this file.
const publishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !publishableKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL and/or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
      'Copy mobile/.env.example to mobile/.env and restart the dev server with ' +
      '`npm start -- --clear` (env vars are inlined at build time, so a hot ' +
      'reload will not pick up a new .env).',
  );
}

export const supabase = createClient<Database>(url, publishableKey, {
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
