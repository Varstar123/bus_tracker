-- ============================================================================
-- BusTracker :: 0001 :: Extensions, enums, helper schema
-- ============================================================================

-- Supabase provisions an `extensions` schema and puts extensions there rather
-- than polluting `public`. Create it if we are running on plain Postgres, then
-- name it explicitly so the outcome is the same either way.
--
-- `if not exists` means that if PostGIS is ALREADY installed somewhere else on
-- this database, this is a no-op and the existing location wins. That is why
-- every function below sets `search_path = public, extensions, app` -- it
-- resolves ST_* and the geography type wherever they actually ended up.
create schema if not exists extensions;

create extension if not exists postgis  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Internal helpers live here so they are never exposed via PostgREST.
create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type user_role as enum ('admin', 'driver', 'student', 'faculty', 'parent');

create type institution_type as enum ('school', 'college');

-- A rider is anyone who sits on the bus. School students are the only ones we
-- hold guardians for; college students and faculty simply track the vehicle.
create type rider_type as enum ('school_student', 'college_student', 'faculty');

-- Inbound = towards campus (morning). Outbound = towards home (evening).
create type trip_direction as enum ('inbound', 'outbound');

create type trip_status as enum ('scheduled', 'active', 'completed', 'cancelled');

create type ride_event_type as enum (
  'boarded',        -- rider got on at a pickup stop
  'alighted',       -- rider got off at a drop stop
  'absent',         -- driver marked them a no-show at their stop
  'arrived_campus', -- bus reached the campus stop with them aboard
  'arrived_stop'    -- bus reached their home stop with them aboard
);

-- How confident are we that a ride event really happened?
--   driver   -> a human tapped it on the manifest (highest trust)
--   geofence -> inferred from the bus crossing a stop boundary
--   scan     -> QR / RFID at the door (reserved for a later phase)
create type event_source as enum ('driver', 'geofence', 'scan', 'admin');
