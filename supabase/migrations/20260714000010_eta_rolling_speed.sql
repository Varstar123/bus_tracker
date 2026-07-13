-- ============================================================================
-- BusTracker :: 0010 :: Fix a false "bus is delayed" alert
--
-- THE BUG
--
-- app.apply_fix passed the *instantaneous* speed from the GPS fix straight into
-- the ETA. But the moment a bus is at a stop -- which is exactly when we compute
-- the ETA to the NEXT stop -- its instantaneous speed is ~0. The ETA function
-- clamped that to its 12 km/h floor and then projected a 7 km leg as a 46-minute
-- journey.
--
-- Observed on the very first test run: the bus reached Domlur Bridge SEVEN
-- MINUTES EARLY, and we told every parent it was 23 MINUTES LATE. And because it
-- triggers whenever the bus is stationary, it would have fired at every stop of
-- every trip -- a false alarm on a schedule.
--
-- THE FIX
--
-- Estimate speed from the trip's own recent GPS trail (distance covered / time
-- elapsed) rather than from a single fix. That is self-calibrating: it absorbs
-- the stop dwell time, it adapts to traffic, and one stationary reading can no
-- longer dominate it.
--
-- Note this deliberately does NOT filter out the stopped moments. A bus that
-- spends half its time at stops really is slower, and the parent waiting at the
-- gate cares about when it *arrives*, not how fast it goes between stops.
-- ============================================================================

set search_path = public, extensions;

create or replace function app.recent_speed_kmh(p_trip_id uuid)
returns real
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  with recent as (
    select location, recorded_at
    from bus_locations
    where trip_id = p_trip_id
      and recorded_at > now() - interval '10 minutes'
    order by recorded_at
  ),
  legs as (
    select
      ST_Distance(location, lag(location) over w) as metres,
      extract(epoch from (recorded_at - lag(recorded_at) over w)) as secs
    from recent
    window w as (order by recorded_at)
  )
  select case
    -- Below a minute of history the average is noise -- a couple of fixes taken
    -- while pulling away from the kerb would read as walking pace. Return null
    -- and let estimate_eta_seconds fall back to its default cruising speed.
    when sum(secs) >= 60 and sum(metres) > 0
      then (sum(metres) / sum(secs) * 3.6)::real
    else null
  end
  from legs
  where secs > 0;
$$;

-- Same as 0003 except for the speed used in the ETA -- see v_speed below.
create or replace function app.apply_fix(
  p_trip        trips,
  p_lat         double precision,
  p_lng         double precision,
  p_heading     real,
  p_speed_kmh   real,
  p_accuracy_m  real,
  p_recorded_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_point  geography;
  v_next   record;
  v_eta    int;
  v_speed  real;
  v_fired  uuid[] := '{}';
begin
  v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  -- 1. raw fix. Must be inserted BEFORE the speed is estimated, so this fix is
  --    part of the trail the estimate is computed from.
  insert into bus_locations (trip_id, bus_id, location, heading, speed_kmh, accuracy_m, recorded_at)
  values (p_trip.id, p_trip.bus_id, v_point, p_heading, p_speed_kmh, p_accuracy_m, p_recorded_at);

  -- 2. geofence: any not-yet-visited stop on this route we are now inside of.
  with hits as (
    insert into trip_stop_events (trip_id, stop_id, seq, arrived_at)
    select p_trip.id, r.stop_id, r.seq, p_recorded_at
    from app.remaining_stops(p_trip.id) r
    join stops s on s.id = r.stop_id
    where ST_DWithin(v_point, r.location, s.geofence_radius_m)
    on conflict (trip_id, stop_id) do nothing
    returning stop_id
  )
  select coalesce(array_agg(stop_id), '{}') into v_fired from hits;

  -- 3. next stop + ETA.
  --    The rolling average is the whole point of this migration: a bus sitting
  --    at a stop reads ~0 km/h instantaneously, and projecting the next leg from
  --    that produced a false "23 minutes late" alert. Fall back to the single
  --    fix only when there is not yet enough trail to average.
  v_speed := coalesce(app.recent_speed_kmh(p_trip.id), p_speed_kmh);

  select * into v_next from app.remaining_stops(p_trip.id) limit 1;
  if found then
    v_eta := app.estimate_eta_seconds(v_point, v_next.location, v_speed);
    perform app.fire_stop_alerts(p_trip, v_next.stop_id, v_eta);
  else
    v_eta := null;
  end if;

  -- 4. live row
  insert into bus_live as bl (
    bus_id, org_id, trip_id, route_id, location, heading, speed_kmh,
    next_stop_id, eta_seconds, recorded_at, updated_at
  )
  values (
    p_trip.bus_id, p_trip.org_id, p_trip.id, p_trip.route_id, v_point, p_heading, p_speed_kmh,
    v_next.stop_id, v_eta, p_recorded_at, now()
  )
  on conflict (bus_id) do update set
    trip_id      = excluded.trip_id,
    route_id     = excluded.route_id,
    location     = excluded.location,
    heading      = excluded.heading,
    speed_kmh    = excluded.speed_kmh,
    next_stop_id = excluded.next_stop_id,
    eta_seconds  = excluded.eta_seconds,
    recorded_at  = excluded.recorded_at,
    updated_at   = now()
  where excluded.recorded_at > bl.recorded_at;

  return jsonb_build_object(
    'ok', true,
    'stops_reached', v_fired,
    'next_stop_id', v_next.stop_id,
    'eta_seconds', v_eta
  );
end;
$$;
