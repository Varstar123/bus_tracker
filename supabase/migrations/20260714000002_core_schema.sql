-- ============================================================================
-- BusTracker :: 0002 :: Core tables
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------


-- PostGIS may live in `public` or in `extensions` depending on how the project
-- was provisioned. Naming both means this migration applies either way.
set search_path = public, extensions;

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        institution_type not null,
  timezone    text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now()
);

-- Every human who can log in. Mirrors auth.users 1:1.
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  org_id      uuid not null references organizations (id) on delete cascade,
  role        user_role not null,
  full_name   text not null,
  phone       text,
  email       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on profiles (org_id, role);

-- ---------------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------------

create table buses (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  registration_no text not null,
  display_name    text not null,          -- "Bus 12 / Green Line"
  capacity        int  not null default 40 check (capacity > 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (org_id, registration_no)
);

create table stops (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  name         text not null,
  address      text,
  location     geography(Point, 4326) not null,
  -- How close the bus must get before we call it "arrived". Tight geofences
  -- miss arrivals in GPS-noisy areas; loose ones fire early. 120 m is a sane
  -- urban default -- tune per stop.
  geofence_radius_m int not null default 120 check (geofence_radius_m between 40 and 500),
  is_campus    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index stops_location_gix on stops using gist (location);
create index on stops (org_id);

create table routes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  name        text not null,             -- "Route 4 -- Whitefield"
  code        text not null,
  bus_id      uuid references buses (id) on delete set null,
  driver_id   uuid references profiles (id) on delete set null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (org_id, code)
);

-- Ordered stop list for a route. seq 1..n in the inbound direction; the
-- outbound run simply walks the same list backwards.
create table route_stops (
  route_id       uuid not null references routes (id) on delete cascade,
  stop_id        uuid not null references stops (id) on delete cascade,
  seq            int  not null check (seq > 0),
  -- Minutes from trip start that the bus is *scheduled* to reach this stop.
  -- Seeds the ETA before we have any live data to learn from.
  offset_minutes int  not null default 0 check (offset_minutes >= 0),
  primary key (route_id, seq),
  unique (route_id, stop_id)
);

-- ---------------------------------------------------------------------------
-- People on the bus
-- ---------------------------------------------------------------------------

-- A rider may have no login at all (a 7-year-old), so profile_id is nullable.
-- This is the join point for the whole parent-monitoring feature.
create table riders (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  profile_id     uuid unique references profiles (id) on delete set null,
  full_name      text not null,
  kind           rider_type not null,
  class_section  text,                    -- "Grade 5-B" / "CSE 3rd Yr"
  route_id       uuid references routes (id) on delete set null,
  pickup_stop_id uuid references stops (id) on delete set null,
  drop_stop_id   uuid references stops (id) on delete set null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index on riders (org_id);
create index on riders (route_id);
create index on riders (pickup_stop_id);
create index on riders (drop_stop_id);

-- Parent <-> child. Many-to-many on purpose: two parents, two kids, one bus.
create table guardians (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles (id) on delete cascade,
  rider_id    uuid not null references riders (id) on delete cascade,
  relation    text,                       -- 'mother' | 'father' | 'guardian'
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (profile_id, rider_id)
);
create index on guardians (rider_id);
create index on guardians (profile_id);

-- ---------------------------------------------------------------------------
-- Trips + telemetry
-- ---------------------------------------------------------------------------

create table trips (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  route_id      uuid not null references routes (id) on delete cascade,
  bus_id        uuid not null references buses (id) on delete restrict,
  driver_id     uuid not null references profiles (id) on delete restrict,
  direction     trip_direction not null,
  service_date  date not null,
  status        trip_status not null default 'scheduled',
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz not null default now(),
  -- One inbound and one outbound run per route per day.
  unique (route_id, service_date, direction)
);
create index on trips (org_id, service_date);
create index on trips (bus_id, status);
-- A bus can only be on one live trip at a time; this is what stops a driver
-- from accidentally opening a second trip and splitting the GPS stream.
create unique index trips_one_active_per_bus on trips (bus_id) where status = 'active';

-- Raw GPS firehose. Append-only, never updated. Keep it lean -- at a 5 s ping
-- rate one bus writes ~7 k rows/day, so prune or partition this by month.
create table bus_locations (
  id           bigserial primary key,
  trip_id      uuid not null references trips (id) on delete cascade,
  bus_id       uuid not null references buses (id) on delete cascade,
  location     geography(Point, 4326) not null,
  heading      real,          -- degrees, 0-360
  speed_kmh    real,
  accuracy_m   real,
  recorded_at  timestamptz not null,   -- clock on the driver's phone
  ingested_at  timestamptz not null default now()
);
create index on bus_locations (trip_id, recorded_at desc);

-- The "where is it right now" table. One row per bus, upserted on every ping.
-- Clients subscribe to *this* over realtime, not the firehose above -- it means
-- a rider watching the map pulls one small row instead of a growing table.
create table bus_live (
  bus_id      uuid primary key references buses (id) on delete cascade,
  org_id      uuid not null references organizations (id) on delete cascade,
  trip_id     uuid references trips (id) on delete set null,
  route_id    uuid references routes (id) on delete set null,
  location    geography(Point, 4326) not null,
  heading     real,
  speed_kmh   real,
  -- Which stop the bus is heading for next, and when we think it lands.
  next_stop_id uuid references stops (id) on delete set null,
  eta_seconds  int,
  recorded_at timestamptz not null,
  updated_at  timestamptz not null default now()
);
create index on bus_live (org_id);
create index bus_live_location_gix on bus_live using gist (location);

-- Auto-filled by the geofence trigger: when did this trip actually reach each
-- stop. Powers both the parent timeline and next-day ETA accuracy.
create table trip_stop_events (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips (id) on delete cascade,
  stop_id     uuid not null references stops (id) on delete cascade,
  seq         int not null,
  arrived_at  timestamptz not null default now(),
  unique (trip_id, stop_id)
);
create index on trip_stop_events (trip_id);

-- ---------------------------------------------------------------------------
-- The parent-facing timeline
-- ---------------------------------------------------------------------------

create table ride_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  rider_id     uuid not null references riders (id) on delete cascade,
  trip_id      uuid references trips (id) on delete set null,
  stop_id      uuid references stops (id) on delete set null,
  event_type   ride_event_type not null,
  source       event_source not null default 'driver',
  occurred_at  timestamptz not null default now(),
  recorded_by  uuid references profiles (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index on ride_events (rider_id, occurred_at desc);
create index on ride_events (trip_id);

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------

create table device_tokens (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles (id) on delete cascade,
  token       text not null unique,       -- Expo push token
  platform    text not null check (platform in ('ios', 'android')),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index on device_tokens (profile_id);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles (id) on delete cascade,
  title       text not null,
  body        text not null,
  -- Drives both the colour in the app and the push channel/priority. An SOS
  -- must not arrive looking like a routine "bus is 5 minutes away".
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  data        jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index on notifications (profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Dedupe ledger for automatic, ETA-driven alerts.
--
-- Without this, "bus arriving in 5 min" would re-fire on every single GPS ping
-- for the whole time the bus is within 5 minutes of the stop -- roughly 60 push
-- notifications per parent, per stop. One row per (trip, stop, kind) is what
-- makes the alert fire exactly once.
-- ---------------------------------------------------------------------------

create table trip_alerts (
  trip_id    uuid not null references trips (id) on delete cascade,
  stop_id    uuid not null references stops (id) on delete cascade,
  kind       text not null check (kind in ('approaching', 'delayed')),
  fired_at   timestamptz not null default now(),
  primary key (trip_id, stop_id, kind)
);
