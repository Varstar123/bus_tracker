# BusTracker

Real-time school/college bus tracking for **students, faculty, parents, drivers and the transport office** — one Expo app, one Postgres database.

Built to the Group 17 *Zeroth Review* spec: live GPS tracking, smart arrival & delay alerts, route-change and accident notifications, an emergency SOS for passengers, and bus-fee payments.

---

## What each person gets

| Role | Sees |
|---|---|
| **Student / Faculty** | Live map of their bus, ETA to *their* stop, emergency SOS, their fees |
| **Parent** | Each child's status (boarded → at school → dropped), live map, alerts, fee payment |
| **Driver** | Start/end trip, background GPS sharing, boarding manifest, incident reporting |
| **Transport office** | Live fleet, open incidents, acknowledge/resolve |

## Feature map

Every feature from the deck, and where it actually lives:

| Deck feature | Implementation |
|---|---|
| Real-time GPS tracking | `mobile/src/lib/tracking.ts` → `ingest_locations()` → `bus_live` → Realtime |
| Live map + ETA | `mobile/src/components/BusMap.tsx` (MapLibre + OpenFreeMap), `app.estimate_eta_seconds()` |
| Smart alert: arriving soon | `app.fire_stop_alerts()` — fires once at ETA ≤ 5 min |
| Smart alert: delay | `app.fire_stop_alerts()` — fires once at >10 min behind timetable |
| Student boarding location | Driver manifest → `ride_events` |
| Parent alerts on home arrival | Geofence → `trip_stop_events` → `app.on_stop_reached()` |
| Route-change alert | `report_incident(kind => 'route_change')` |
| Accident notification | `report_incident(kind => 'accident')` — critical priority |
| Emergency SOS | `raise_sos()` → school office + that child's parents + the driver |
| Fee payment + confirmation | `fee_invoices` → `create-payment-order` → Razorpay → `razorpay-webhook` |

---

## Architecture

```
Driver's phone                  Supabase                       Everyone else
──────────────                  ────────                       ─────────────
expo-location                   ingest_locations()             Realtime subscription
background task     ─────────▶  ├─ bus_locations (history)  ─▶ bus_live (1 row/bus)
(5s, survives                   ├─ geofence → trip_stop_events      │
 screen-off)                    ├─ ETA → bus_live                   ▼
      │                         └─ fire_stop_alerts()          live map + ETA
      │                                    │
      └─ offline queue                     ▼
         (AsyncStorage,              notifications ──▶ send-push ──▶ Expo Push
          flushed in batch)                                              │
                                                                         ▼
                                                                   parent's phone
```

Three decisions worth knowing:

**Riders are records, not accounts.** A seven-year-old has no phone. So a `rider` may or may not link to a login, and `guardians` links parents to riders. This is what makes the parent feature work without forcing every child to have an account.

**Clients subscribe to `bus_live`, never `bus_locations`.** The latter is the raw GPS firehose — one row every 5 seconds per bus. Publishing it over Realtime would push every fix to every phone. `bus_live` is one upserted row per bus; that is the moving dot.

**Boarding is observed, not inferred.** GPS proves the *bus* reached the stop. It cannot prove a *child* walked onto it. So the driver taps the manifest, and that tap is what notifies the parent. Everything else in the app is derived; this one thing is witnessed, and it is why the parent alerts can be trusted.

---

## Setup

### 1. Supabase project

Create one at [supabase.com](https://supabase.com), then:

```bash
npm i -g supabase
supabase link --project-ref <your-project-ref>
supabase db push          # applies migrations/
```

Then run `supabase/seed.sql` in the SQL Editor to get a demo school.
*(You do not need Docker for any of this — it all runs against the hosted project.)*

### 2. Mobile env

```bash
cd mobile
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Settings → API Keys). That key is safe to ship — RLS is what protects the data, not the key.

**There is no map key.** Maps are MapLibre + [OpenFreeMap](https://openfreemap.org), which serves OpenStreetMap vector tiles with no account, no key, and no rate limit. Google's Maps SDK is free for mobile map loads too, but it won't issue a working key without a billing account and a card on file — not a trade worth making to draw a line and a moving dot.

### 3. Run it

**Background GPS and push notifications do not work in Expo Go.** You need a development build:

```bash
npx expo install expo-dev-client   # already in package.json
npx eas build --profile development --platform android
# then
npm start
```

Expo Go is fine for looking at the UI, but the driver's location will stop the moment the screen turns off.

### 4. Edge functions

```bash
supabase secrets set WEBHOOK_SECRET=$(openssl rand -hex 32)
supabase functions deploy send-push
supabase functions deploy create-payment-order
supabase functions deploy razorpay-webhook --no-verify-jwt
```

Then in the Supabase dashboard: **Database → Webhooks → Create**
- Table `public.notifications`, event `INSERT`
- Type: Edge Function → `send-push`
- HTTP header: `x-webhook-secret: <the same value you just set>`

### 5. Payments

To demo without a merchant account:

```bash
supabase secrets set PAYMENTS_MODE=mock
```

Invoices settle instantly and no money moves. **Never set this in production** — anyone could clear their own fees. The function refuses to start in mock mode if Razorpay keys are also present.

For real payments:

```bash
supabase secrets set PAYMENTS_MODE=razorpay \
  RAZORPAY_KEY_ID=rzp_test_xxx \
  RAZORPAY_KEY_SECRET=xxx \
  RAZORPAY_WEBHOOK_SECRET=xxx
```

Then add a Razorpay webhook for `payment_link.paid` and `payment_link.expired` pointing at `razorpay-webhook`.

---

## How to actually test it

Testing this needs **two** actors at once: a driver broadcasting GPS, and a rider watching the map. One phone can only be one of them. So there's a script that plays the driver, and you watch as a parent.

**1. Run the app.** Background GPS, push and MapLibre all need native code, so this is a development build — Expo Go won't do:

```bash
cd mobile
npx expo run:android      # or: npx expo run:ios
```

On Windows, if the build complains about Java, point it at Android Studio's JDK — the `java` on your PATH is probably an old JRE:

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
```

**2. Sign in as a parent** — `priya@demo.parent` / `password123`.
You'll see Aarav, and "Not on the bus yet".

**3. Drive the bus** (in another terminal):

```bash
node scripts/simulate-trip.mjs
```

It signs in as the seeded driver and calls the same `ingest_location` RPC the real app calls — no service key, no back door. Everything it does, a real driver's phone could do.

Now watch the app. The bus appears and moves. As it reaches each stop you get **"Bus arriving soon"**, then **"Aarav boarded"**, then **"Reached school"** — the whole parent journey, live.

```bash
node scripts/simulate-trip.mjs --minutes 8        # slower, more realistic
node scripts/simulate-trip.mjs --direction outbound   # the evening run home
node scripts/simulate-trip.mjs --no-board         # don't mark anyone aboard
```

**4. Reset between runs** — paste [`scripts/reset-demo.sql`](scripts/reset-demo.sql) into the SQL Editor. It clears the trip data and puts the buses back to `scheduled`, leaving all the seed reference data alone.

**Try the other roles too.** Sign in as `suresh@demo.parent` and you'll see *two* children — and notice he gets one "bus arriving" alert but two separate "boarded" messages, which is the correct distinction. Sign in as `ramesh@demo.school` to be the driver and tap the manifest yourself.

## Demo logins

After running the seed. Password for all: `password123`

| Email | Role |
|---|---|
| `admin@demo.school` | Transport office |
| `ramesh@demo.school` | Driver — Route 4 |
| `priya@demo.parent` | Parent of Aarav (Grade 5-B) |
| `suresh@demo.parent` | Parent of **two** children — Diya and Kabir |
| `meera@demo.college` | College student |
| `anand@demo.school` | Faculty |

Sign in as Ramesh, press **Start trip**, and drive (or use the simulator's location tools) — the bus appears live for everyone else.

---

## What this costs

Nothing, for a project of this size. Nothing here asks for a credit card.

| Piece | Cost |
|---|---|
| Maps — MapLibre + OpenFreeMap | Free. No key, no account, no rate limit. |
| Supabase | Free tier: 500 MB DB, 50k monthly users, Realtime included |
| Expo push notifications | Free, unlimited |
| Android build | Free — `npx expo run:android` builds locally, no EAS quota |
| Payments (demo) | Free — `PAYMENTS_MODE=mock`, no merchant account |
| Payments (live) | Razorpay, ~2% per transaction |

Two things that will bite you if you don't know them:

- **Supabase pauses free projects after ~1 week of inactivity.** If you build now and demo in three weeks, it'll be asleep. One click to wake — but don't discover that in front of an audience.
- **`bus_locations` is what fills the free tier.** ~7k rows per bus per day. Prune or partition it before this sees a real fleet.

## Security model

- **RLS on every table.** A parent's query for `riders` returns their children and nothing else. This is enforced in the database, not the app, so it holds even if someone hits the API directly with the anon key.
- **Roles are not self-assigned.** Signing up doesn't grant anything. The school uploads an `invites` roster; signing up *claims* a pre-authorised seat. An email with no invite gets an account with no profile — and every policy keys off the profile, so they can read precisely nothing.
- **Drivers write telemetry only through RPCs** that verify `driver_id = auth.uid()` and that the trip is actually running. There is no INSERT policy on `trips` or `bus_live` for anyone.
- **The client never states a price.** It names an invoice; the server looks up what that invoice costs. Razorpay's HMAC-signed webhook — not the app — is what marks a fee paid.

## Known limits

Worth being straight about:

- **"Arrived home" means "dropped at their stop."** Without a device on the child we cannot know they walked through the front door. The app says *"Dropped at Domlur Bridge, 4:12 PM"*, which is true, rather than *"reached home safely"*, which we cannot verify. The wording throughout is deliberate.
- **The ETA is a straight-line estimate** (great-circle distance × 1.35 detour factor ÷ speed). Good to roughly ±3 minutes in city traffic. `app.estimate_eta_seconds()` is a single function — swap its body for a Directions API call and nothing else changes.
- **The admin surface is deliberately thin.** Managing routes, rosters and fees belongs in a web console, not on a phone. What's here is what genuinely needs answering from a phone: *is a bus in trouble right now.*
- **`bus_locations` grows fast** — about 7k rows per bus per day at a 5-second ping. Partition it by month or prune it on a schedule before this goes anywhere near a real fleet.

## Layout

```
supabase/
  migrations/     0001 schema · 0003 geofence+ETA+RPCs · 0004 RLS
                  0006 roster onboarding · 0007 safety · 0008 fees
  functions/      send-push · create-payment-order · razorpay-webhook
  seed.sql        one school, one route, 5 riders, 2 parents
mobile/
  src/lib/        supabase · auth · tracking (background GPS) · push
  src/hooks/      useLiveRoute · useRideEvents · useData
  src/screens/    RiderHome · DriverHome · ParentHome · AdminHome
  src/app/        expo-router routes; (app)/ is the role-aware tab layout
```
