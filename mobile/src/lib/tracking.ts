import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { supabase } from './supabase';
import type { LocationFix } from './types';

export const LOCATION_TASK = 'bustracker-location-updates';

const TRIP_KEY = 'bustracker.activeTripId';
const QUEUE_KEY = 'bustracker.pendingFixes';

/**
 * ~1 hour of buffer at a 5 s ping rate. A bus that has been offline longer than
 * that has bigger problems than a gap in its breadcrumb trail, and an unbounded
 * queue would eventually blow out AsyncStorage.
 */
const MAX_QUEUE = 720;

// ---------------------------------------------------------------------------
// Active trip handle. The background task runs in a headless JS context with no
// React state, so the trip it is reporting for has to live on disk.
// ---------------------------------------------------------------------------

export async function setActiveTripId(tripId: string | null): Promise<void> {
  if (tripId) {
    await AsyncStorage.setItem(TRIP_KEY, tripId);
  } else {
    await AsyncStorage.multiRemove([TRIP_KEY, QUEUE_KEY]);
  }
}

export async function getActiveTripId(): Promise<string | null> {
  return AsyncStorage.getItem(TRIP_KEY);
}

// ---------------------------------------------------------------------------
// Offline queue
// ---------------------------------------------------------------------------

async function readQueue(): Promise<LocationFix[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocationFix[]) : [];
  } catch {
    // Corrupt queue is not worth crashing the driver's trip over.
    await AsyncStorage.removeItem(QUEUE_KEY);
    return [];
  }
}

async function writeQueue(fixes: LocationFix[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(fixes.slice(-MAX_QUEUE)));
}

export async function getPendingCount(): Promise<number> {
  return (await readQueue()).length;
}

function toFix(loc: Location.LocationObject): LocationFix {
  const { coords, timestamp } = loc;
  // expo-location reports speed in m/s, and uses -1 (or null) for "unknown".
  const speed = coords.speed != null && coords.speed >= 0 ? coords.speed * 3.6 : null;
  const heading = coords.heading != null && coords.heading >= 0 ? coords.heading : null;

  return {
    lat: coords.latitude,
    lng: coords.longitude,
    heading,
    speed_kmh: speed,
    accuracy_m: coords.accuracy ?? null,
    recorded_at: new Date(timestamp).toISOString(),
  };
}

/**
 * Serialises flushes. The OS can deliver a second batch of locations while the
 * previous upload is still in flight; without this, both would read the same
 * queue and upload the same fixes twice.
 */
let inflight: Promise<void> = Promise.resolve();

async function flush(tripId: string, incoming: LocationFix[]): Promise<void> {
  const queued = await readQueue();
  const batch = [...queued, ...incoming].slice(-MAX_QUEUE);
  if (batch.length === 0) return;

  // No session means the driver signed out mid-trip, or the refresh token died.
  // Hold the fixes; they will go up when they sign back in.
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    await writeQueue(batch);
    return;
  }

  const { error } = await supabase.rpc('ingest_locations', {
    p_trip_id: tripId,
    p_fixes: batch,
  });

  if (error) {
    // 'insufficient_privilege' / 'check_violation' mean this trip is over or was
    // never ours. Retrying forever would pin the radio on, so drop the trip and
    // let the driver's next Start create a fresh one.
    const fatal =
      error.code === '42501' || // insufficient_privilege
      error.code === '23514' || // check_violation -> trip not active
      error.code === 'P0002'; // no_data_found -> trip deleted

    if (fatal) {
      console.warn('[tracking] trip no longer accepts fixes, stopping:', error.message);
      await stopTracking();
      return;
    }

    // Anything else (offline, 5xx, timeout) is transient. Keep the fixes.
    await writeQueue(batch);
    return;
  }

  await AsyncStorage.removeItem(QUEUE_KEY);
}

// ---------------------------------------------------------------------------
// The task itself.
//
// defineTask MUST run at module scope, and this module must be imported from the
// root layout. When Android relaunches the app headlessly to deliver a location,
// it evaluates the bundle and looks for a task under this exact name -- if the
// registration is hidden inside a component that has not rendered yet, the task
// is "not found" and updates are silently dropped.
// ---------------------------------------------------------------------------

type LocationTaskData = { locations: Location.LocationObject[] };

TaskManager.defineTask<LocationTaskData>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[tracking] task error:', error.message);
    return;
  }

  const locations = data?.locations ?? [];
  if (locations.length === 0) return;

  const tripId = await getActiveTripId();
  if (!tripId) {
    // The OS is still feeding us locations for a trip that has ended.
    await stopTracking();
    return;
  }

  const fixes = locations.map(toFix);
  inflight = inflight.then(() => flush(tripId, fixes)).catch((e: unknown) => {
    console.warn('[tracking] flush failed:', e);
  });
  await inflight;
});

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

export type PermissionOutcome =
  | { ok: true }
  | { ok: false; reason: 'foreground-denied' | 'background-denied' };

/**
 * Two separate prompts, in order -- this is an OS requirement, not a style
 * choice. Asking for "Always" before "While Using" is auto-denied on both
 * platforms, and on Android 11+ the user must additionally pick "Allow all the
 * time" from a settings screen we cannot skip past.
 */
export async function requestTrackingPermissions(): Promise<PermissionOutcome> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'foreground-denied' };

  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return { ok: false, reason: 'background-denied' };

  return { ok: true };
}

export async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
}

export async function startTracking(tripId: string): Promise<void> {
  await setActiveTripId(tripId);

  if (await isTracking()) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 5_000,
    distanceInterval: 15,

    // Android: without a foreground service the OS throttles a backgrounded app
    // to a handful of location updates per hour, which is useless for a live
    // map. The persistent notification is the price of a real-time feed, and it
    // doubles as the driver's "I am being tracked" disclosure.
    foregroundService: {
      notificationTitle: 'BusTracker is sharing your location',
      notificationBody: 'Students and parents can see this bus while the trip is running.',
      notificationColor: '#0B3D2E',
      killServiceOnDestroy: false,
    },

    // iOS
    activityType: Location.ActivityType.AutomotiveNavigation,
    // Must stay false. iOS "helpfully" pauses updates when it thinks you have
    // stopped moving -- e.g. a bus idling at a long red light -- and does not
    // reliably resume, which strands the bus on every rider's map.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,

    ...(Platform.OS === 'ios'
      ? {}
      : // Android only: let the OS batch fixes and hand them over every ~15 s.
        // Same data, far fewer wakeups, noticeably less battery drain.
        { deferredUpdatesInterval: 15_000, deferredUpdatesDistance: 50 }),
  });
}

export async function stopTracking(): Promise<void> {
  if (await isTracking()) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await setActiveTripId(null);
}
