#!/usr/bin/env node
/**
 * Drives a bus down the demo route so you can watch it move in the app.
 *
 * Testing this app needs two actors at once: a driver broadcasting GPS, and a
 * rider watching the map. With one phone you can only be one of them. So this
 * script plays the driver, and you open the app as a parent or a student.
 *
 *   node scripts/simulate-trip.mjs                  # morning run, ~3 min
 *   node scripts/simulate-trip.mjs --direction outbound
 *   node scripts/simulate-trip.mjs --minutes 8      # slower, more realistic
 *   node scripts/simulate-trip.mjs --no-board       # don't mark anyone aboard
 *
 * It authenticates as the seeded driver with the seeded password and calls the
 * same ingest_location RPC the real app calls -- no service key, no back door.
 * Everything it does, a real driver's phone could do.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync(join(root, 'mobile/.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const URL_BASE = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!URL_BASE || !KEY) {
  console.error('mobile/.env is missing EXPO_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};

const DIRECTION = flag('direction', 'inbound');
const MINUTES = Number(flag('minutes', 3));
const BOARD = !args.includes('--no-board');
const DRIVER_EMAIL = flag('driver', 'ramesh@demo.school');
const PASSWORD = flag('password', 'password123');

// A real phone reports every few seconds. Keep it in that ballpark so the
// rolling-average speed estimator behaves the way it will in the field.
const TICK_MS = 3000;

// ---------------------------------------------------------------------------
// Supabase helpers -- plain fetch, same endpoints the app uses
// ---------------------------------------------------------------------------

async function signIn(email, password) {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}

let token;
async function api(path, opts = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers ?? {}),
    },
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
/**
 * Every RPC here can fail for a reason you need to see -- the trip is not yours,
 * the trip is not active, another trip is already running on this bus. Swallowing
 * that leaves the bus silently frozen on the map with no clue why, which is
 * exactly what happened the first time this script ran.
 */
async function rpc(fn, body) {
  const res = await api(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
  if (res && typeof res === 'object' && !Array.isArray(res) && res.code && res.message) {
    throw new Error(`${fn} failed [${res.code}]: ${res.message}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Metres between two lat/lng points (haversine). */
function metres(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing a -> b, so the bus icon points where it is going. */
function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Signing in as ${DRIVER_EMAIL}…`);
  token = await signIn(DRIVER_EMAIL, PASSWORD);

  // Same call the driver's app makes on load: bring today's trips into being if
  // they do not exist yet. Idempotent, so running this script twice is fine.
  await rpc('ensure_todays_trips', {});

  const today = new Date().toISOString().slice(0, 10);
  const [trip] = await api(
    `trips?select=id,route_id,status,direction&direction=eq.${DIRECTION}&service_date=eq.${today}`,
  );

  if (!trip) {
    console.error(
      `No ${DIRECTION} trip for ${today}.\n` +
        `That usually means the route has no bus or no driver assigned.`,
    );
    process.exit(1);
  }

  if (trip.status === 'completed') {
    console.error(`Today's ${DIRECTION} trip is already completed. Run scripts/reset-demo.sql first.`);
    process.exit(1);
  }

  // A bus can only be on one trip at a time -- there is a unique index enforcing
  // it, precisely so a forgotten trip cannot split the GPS stream in two. If an
  // earlier run left one open, close it, which is what the driver would do.
  const stale = await api(
    `trips?select=id,direction&status=eq.active&id=neq.${trip.id}`,
  );
  for (const s of stale) {
    console.log(`Closing a still-running ${s.direction} trip from an earlier run…`);
    await rpc('end_trip', { p_trip_id: s.id });
  }

  if (trip.status === 'scheduled') {
    await rpc('start_trip', { p_trip_id: trip.id });
    console.log('Trip started.');
  } else {
    console.log('Trip already running — resuming.');
  }

  // Stops in the order the bus actually meets them.
  const rs = await api(
    `route_stops?select=seq,stop_id&route_id=eq.${trip.route_id}&order=seq.${
      DIRECTION === 'inbound' ? 'asc' : 'desc'
    }`,
  );
  const stopRows = await api(`stops?select=id,name,lat,lng&id=in.(${rs.map((r) => r.stop_id).join(',')})`);
  const byId = new Map(stopRows.map((s) => [s.id, s]));
  const route = rs.map((r) => byId.get(r.stop_id)).filter(Boolean);

  console.log(`Route: ${route.map((s) => s.name).join(' → ')}\n`);

  // Riders, so we can mark them aboard at their stop.
  const riders = await api(`riders?select=id,full_name,pickup_stop_id,drop_stop_id&route_id=eq.${trip.route_id}`);
  const [me] = await api('profiles?select=id,org_id&role=eq.driver');

  // On the evening run everyone gets on at campus, before the bus moves. Do that
  // now -- without a 'boarded' event the arrival geofence has nobody to report,
  // and the parent would never be told their child was dropped.
  if (BOARD && DIRECTION === 'outbound') {
    const origin = route[0];
    for (const rider of riders) {
      await api('ride_events', {
        method: 'POST',
        body: JSON.stringify({
          org_id: me.org_id,
          rider_id: rider.id,
          trip_id: trip.id,
          stop_id: origin.id,
          event_type: 'boarded',
          source: 'driver',
          recorded_by: me.id,
        }),
      });
    }
    console.log(`Boarded ${riders.length} riders at ${origin.name}.\n`);
  }

  const totalLegs = route.length - 1;
  const tickCount = Math.max(1, Math.round((MINUTES * 60 * 1000) / TICK_MS));
  const ticksPerLeg = Math.max(2, Math.round(tickCount / totalLegs));

  for (let leg = 0; leg < totalLegs; leg++) {
    const from = route[leg];
    const to = route[leg + 1];
    const legMetres = metres(from, to);
    const head = bearing(from, to);

    for (let step = 1; step <= ticksPerLeg; step++) {
      const t = step / ticksPerLeg;
      const at = lerp(from, to, t);

      // km/h actually covered in this tick — what a real GPS would report.
      const speed = (legMetres / ticksPerLeg / (TICK_MS / 1000)) * 3.6;

      const res = await rpc('ingest_location', {
        p_trip_id: trip.id,
        p_lat: at.lat,
        p_lng: at.lng,
        p_heading: head,
        p_speed_kmh: Number(speed.toFixed(1)),
        p_accuracy_m: 6,
        p_recorded_at: new Date().toISOString(),
      });

      const eta = res.eta_seconds == null ? '—' : `${Math.round(res.eta_seconds / 60)} min`;
      process.stdout.write(
        `\r  → ${to.name.padEnd(20)} ${Math.round(t * 100).toString().padStart(3)}%  ` +
          `${speed.toFixed(0).padStart(3)} km/h  ETA ${eta.padEnd(7)}`,
      );

      if (res.stops_reached?.length) {
        const reached = byId.get(res.stops_reached[0]);
        process.stdout.write(`\n  ✓ reached ${reached?.name ?? '?'}\n`);

        if (BOARD) {
          const key = DIRECTION === 'inbound' ? 'pickup_stop_id' : 'drop_stop_id';
          const here = riders.filter((r) => r[key] === reached?.id);

          for (const rider of here) {
            // Inbound: they get on. Outbound: the geofence already logs the drop,
            // so there is nothing for the driver to tap.
            if (DIRECTION !== 'inbound') continue;
            await api('ride_events', {
              method: 'POST',
              body: JSON.stringify({
                org_id: me.org_id,
                rider_id: rider.id,
                trip_id: trip.id,
                stop_id: reached.id,
                event_type: 'boarded',
                source: 'driver',
                recorded_by: me.id,
              }),
            });
            console.log(`    · ${rider.full_name} boarded`);
          }
        }
      }

      await sleep(TICK_MS);
    }
  }

  console.log('\n\nReached the last stop. Ending trip…');
  await rpc('end_trip', { p_trip_id: trip.id });
  console.log('Trip completed. The bus disappears from the live map.');
}

main().catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});
