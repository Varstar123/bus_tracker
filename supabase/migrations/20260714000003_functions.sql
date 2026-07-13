-- ============================================================================
-- BusTracker :: 0003 :: Helper functions, geofencing, ETA, ingest RPC
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Identity helpers used by every RLS policy.
--
-- These are SECURITY DEFINER so they can read `profiles` without tripping the
-- RLS policy that is itself defined in terms of them -- without that, every
-- policy on profiles would recurse into itself.
-- ---------------------------------------------------------------------------


-- PostGIS may live in `public` or in `extensions` depending on how the project
-- was provisioned. Naming both means this migration applies either way.
set search_path = public, extensions;

create or replace function app.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select org_id from profiles where id = auth.uid();
$$;

create or replace function app.current_role()
returns user_role
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

-- Every rider the current user is allowed to see: themselves (if they ride),
-- plus every child they are a guardian of. This single function is what the
-- parent-facing policies hang off.
create or replace function app.visible_rider_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select id from riders where profile_id = auth.uid()
  union
  select g.rider_id from guardians g where g.profile_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- ETA
--
-- Deliberately simple and dependency-free: sum the great-circle distance along
-- the remaining stops, inflate it by a detour factor because roads are not
-- straight lines, and divide by a speed estimate. Good to roughly +/- 3 min in
-- city traffic, which is all a parent waiting at a gate actually needs.
--
-- When you outgrow it, swap the body for a Directions API call -- the callers
-- and the `bus_live.eta_seconds` column do not change.
-- ---------------------------------------------------------------------------

create or replace function app.estimate_eta_seconds(
  p_from        geography,
  p_to          geography,
  p_speed_kmh   real
)
returns int
language plpgsql
immutable
as $$
declare
  v_metres      double precision;
  v_speed_kmh   double precision;
  detour_factor constant double precision := 1.35;  -- straight line -> road
  floor_speed   constant double precision := 12.0;  -- crawling / at a light
  default_speed constant double precision := 25.0;  -- typical urban bus
begin
  if p_from is null or p_to is null then
    return null;
  end if;

  v_metres := ST_Distance(p_from, p_to) * detour_factor;

  -- A stopped bus must not produce an infinite ETA, so clamp to a floor.
  v_speed_kmh := coalesce(nullif(p_speed_kmh, 0), default_speed);
  if v_speed_kmh < floor_speed then
    v_speed_kmh := floor_speed;
  end if;

  return greatest(0, round(v_metres / (v_speed_kmh * 1000.0 / 3600.0))::int);
end;
$$;

-- Stops still ahead of the bus on this trip, in the order it will meet them.
-- Outbound runs the route backwards, which is why seq is sorted by direction.
create or replace function app.remaining_stops(p_trip_id uuid)
returns table (stop_id uuid, seq int, location geography, is_campus boolean)
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select s.id, rs.seq, s.location, s.is_campus
  from trips t
  join route_stops rs on rs.route_id = t.route_id
  join stops s on s.id = rs.stop_id
  where t.id = p_trip_id
    and not exists (
      select 1 from trip_stop_events e
      where e.trip_id = p_trip_id and e.stop_id = s.id
    )
  order by case when t.direction = 'inbound' then rs.seq end asc,
           case when t.direction = 'outbound' then rs.seq end desc;
$$;

-- ---------------------------------------------------------------------------
-- Everyone who cares about a given stop on a given trip: the riders who get on
-- or off there (if they have a login of their own), plus their guardians.
--
-- Direction decides which stop of the rider's is relevant -- on the morning run
-- we care about their pickup, on the evening run their drop.
-- ---------------------------------------------------------------------------

create or replace function app.stop_audience(p_trip trips, p_stop_id uuid)
returns table (profile_id uuid, rider_id uuid, rider_name text)
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  with aboard as (
    select r.id, r.full_name, r.profile_id
    from riders r
    where r.route_id = p_trip.route_id
      and r.is_active
      and p_stop_id = case
            when p_trip.direction = 'inbound' then r.pickup_stop_id
            else r.drop_stop_id
          end
  )
  select a.profile_id, a.id, a.full_name from aboard a where a.profile_id is not null
  union
  select g.profile_id, a.id, a.full_name from aboard a join guardians g on g.rider_id = a.id;
$$;

-- ---------------------------------------------------------------------------
-- Smart alerts, fired from the GPS hot path.
--
--   approaching -- the bus is within ARRIVING_SOON of your stop. "Be ready."
--   delayed     -- it will reach your stop more than LATE_THRESHOLD after the
--                  timetable said it would.
--
-- Both insert into trip_alerts first and only notify if that insert actually
-- created a row. That `if found` is the whole anti-spam mechanism: on the next
-- ping the insert conflicts, nothing is returned, and no second push goes out.
-- ---------------------------------------------------------------------------

create or replace function app.fire_stop_alerts(
  p_trip        trips,
  p_stop_id     uuid,
  p_eta_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  arriving_soon  constant int := 300;  -- 5 minutes
  late_threshold constant int := 600;  -- 10 minutes late is worth a push
  v_stop      stops%rowtype;
  v_tz        text;
  v_offset    int;
  v_scheduled timestamptz;
  v_projected timestamptz;
  v_late_min  int;
  -- GET DIAGNOSTICS ... = ROW_COUNT yields an integer. Declaring this boolean
  -- would only work via an implicit I/O cast through text, which is exactly the
  -- kind of thing that quietly stops working. Count rows, compare to zero.
  v_inserted  int;
begin
  if p_stop_id is null or p_eta_seconds is null then
    return;
  end if;

  select * into v_stop from stops where id = p_stop_id;
  select timezone into v_tz from organizations where id = p_trip.org_id;
  v_projected := now() + make_interval(secs => p_eta_seconds);

  -- ---- approaching ----------------------------------------------------------
  if p_eta_seconds <= arriving_soon then
    insert into trip_alerts (trip_id, stop_id, kind)
    values (p_trip.id, p_stop_id, 'approaching')
    on conflict do nothing;

    get diagnostics v_inserted = row_count;

    if v_inserted > 0 then
      insert into notifications (profile_id, title, body, severity, data)
      select
        a.profile_id,
        'Bus arriving soon',
        'Bus reaches ' || v_stop.name || ' in about '
          || greatest(1, round(p_eta_seconds / 60.0))::text || ' min. Be ready.',
        'info',
        jsonb_build_object(
          'kind', 'approaching',
          'trip_id', p_trip.id,
          'stop_id', p_stop_id,
          'rider_id', a.rider_id,
          'eta_seconds', p_eta_seconds
        )
      from app.stop_audience(p_trip, p_stop_id) a;
    end if;
  end if;

  -- ---- delayed --------------------------------------------------------------
  -- Only meaningful once the trip has actually started; before that there is no
  -- clock to be late against.
  if p_trip.started_at is null then
    return;
  end if;

  select offset_minutes into v_offset
  from route_stops
  where route_id = p_trip.route_id and stop_id = p_stop_id;

  if v_offset is null then
    return;
  end if;

  v_scheduled := p_trip.started_at + make_interval(mins => v_offset);
  v_late_min  := floor(extract(epoch from (v_projected - v_scheduled)) / 60.0)::int;

  if extract(epoch from (v_projected - v_scheduled)) > late_threshold then
    insert into trip_alerts (trip_id, stop_id, kind)
    values (p_trip.id, p_stop_id, 'delayed')
    on conflict do nothing;

    get diagnostics v_inserted = row_count;

    if v_inserted > 0 then
      insert into notifications (profile_id, title, body, severity, data)
      select
        a.profile_id,
        'Bus delayed',
        'Bus is running about ' || v_late_min::text || ' min late for ' || v_stop.name
          || '. Now expected around '
          || to_char(v_projected at time zone coalesce(v_tz, 'UTC'), 'HH12:MI AM') || '.',
        'warning',
        jsonb_build_object(
          'kind', 'delayed',
          'trip_id', p_trip.id,
          'stop_id', p_stop_id,
          'rider_id', a.rider_id,
          'late_minutes', v_late_min
        )
      from app.stop_audience(p_trip, p_stop_id) a;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The hot path: applying one GPS fix from the driver's phone.
--
-- Does four things in one transaction so the client stays dumb and a dropped
-- request can simply be retried:
--   1. append the raw fix
--   2. fire any stop geofence the bus has just entered
--   3. recompute next stop + ETA
--   4. refresh the single-row live position that clients subscribe to
--
-- This is the internal core -- it does NO authorisation. The two public
-- entrypoints below authorise once, then call it.
-- ---------------------------------------------------------------------------

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
  v_fired  uuid[] := '{}';
begin
  v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  -- 1. raw fix
  insert into bus_locations (trip_id, bus_id, location, heading, speed_kmh, accuracy_m, recorded_at)
  values (p_trip.id, p_trip.bus_id, v_point, p_heading, p_speed_kmh, p_accuracy_m, p_recorded_at);

  -- 2. geofence: any not-yet-visited stop on this route we are now inside of.
  -- Recording it here (before picking the next stop) means a stop the bus just
  -- entered is excluded from the ETA below, which is what we want.
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

  -- 3. next stop + ETA
  select * into v_next from app.remaining_stops(p_trip.id) limit 1;
  if found then
    v_eta := app.estimate_eta_seconds(v_point, v_next.location, p_speed_kmh);
    -- "Arriving soon" / "Running late". Self-deduping, so calling it on every
    -- ping is safe -- see app.fire_stop_alerts.
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
  -- A phone that lost signal flushes its backlog oldest-first, and retries can
  -- arrive out of order. Without this guard a stale fix would overwrite a
  -- fresher one and the bus would teleport backwards on every rider's map.
  where excluded.recorded_at > bl.recorded_at;

  return jsonb_build_object(
    'ok', true,
    'stops_reached', v_fired,
    'next_stop_id', v_next.stop_id,
    'eta_seconds', v_eta
  );
end;
$$;

-- Authorise a driver against a trip. Raises rather than returning false so no
-- caller can forget to check the result.
create or replace function app.assert_driving(p_trip_id uuid)
returns trips
language plpgsql
stable
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip trips%rowtype;
begin
  select * into v_trip from trips where id = p_trip_id;

  if not found then
    raise exception 'trip % not found', p_trip_id using errcode = 'no_data_found';
  end if;

  -- SECURITY DEFINER bypasses RLS, so this check *is* the access control.
  if v_trip.driver_id <> auth.uid() then
    raise exception 'not the driver of trip %', p_trip_id using errcode = 'insufficient_privilege';
  end if;

  if v_trip.status <> 'active' then
    raise exception 'trip % is %, not active', p_trip_id, v_trip.status using errcode = 'check_violation';
  end if;

  return v_trip;
end;
$$;

-- Single fix. Used for the common case: one ping, one call.
create or replace function public.ingest_location(
  p_trip_id     uuid,
  p_lat         double precision,
  p_lng         double precision,
  p_heading     real default null,
  p_speed_kmh   real default null,
  p_accuracy_m  real default null,
  p_recorded_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip trips%rowtype;
begin
  v_trip := app.assert_driving(p_trip_id);
  return app.apply_fix(v_trip, p_lat, p_lng, p_heading, p_speed_kmh, p_accuracy_m, p_recorded_at);
end;
$$;

-- Batch. A bus driving through a tunnel or a dead zone buffers fixes on the
-- phone and flushes them when signal returns; without this the app would fire
-- one round trip per buffered fix and could take minutes to catch up.
--
-- Fixes are applied strictly oldest-first so the geofences fire in the order
-- they were actually crossed.
create or replace function public.ingest_locations(
  p_trip_id uuid,
  p_fixes   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip   trips%rowtype;
  v_fix    jsonb;
  v_result jsonb;
  v_count  int := 0;
begin
  v_trip := app.assert_driving(p_trip_id);

  for v_fix in
    select value
    from jsonb_array_elements(p_fixes) as value
    order by (value ->> 'recorded_at')::timestamptz asc
  loop
    v_result := app.apply_fix(
      v_trip,
      (v_fix ->> 'lat')::double precision,
      (v_fix ->> 'lng')::double precision,
      (v_fix ->> 'heading')::real,
      (v_fix ->> 'speed_kmh')::real,
      (v_fix ->> 'accuracy_m')::real,
      (v_fix ->> 'recorded_at')::timestamptz
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    return jsonb_build_object('ok', true, 'applied', 0);
  end if;

  return v_result || jsonb_build_object('applied', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- When the bus reaches a stop, turn that into (a) a timeline entry for every
-- rider aboard and (b) a queued notification for their guardians.
--
-- Rows land in `notifications`; a database webhook on that table hands them to
-- the send-push edge function. Keeping the send out of the transaction means a
-- flaky push provider can never roll back a confirmed arrival.
-- ---------------------------------------------------------------------------

create or replace function app.on_stop_reached()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip      trips%rowtype;
  v_stop      stops%rowtype;
  v_org       uuid;
begin
  select * into v_trip from trips where id = new.trip_id;
  select * into v_stop from stops where id = new.stop_id;
  v_org := v_trip.org_id;

  -- Riders who boarded this trip and get off here (or at campus).
  with arriving as (
    select r.id as rider_id
    from riders r
    where r.org_id = v_org
      and r.is_active
      and exists (
        select 1 from ride_events be
        where be.rider_id = r.id
          and be.trip_id = new.trip_id
          and be.event_type = 'boarded'
      )
      and not exists (
        select 1 from ride_events ae
        where ae.rider_id = r.id
          and ae.trip_id = new.trip_id
          and ae.event_type in ('alighted', 'arrived_stop', 'arrived_campus')
      )
      and (
        (v_stop.is_campus and v_trip.direction = 'inbound')
        or (not v_stop.is_campus and v_trip.direction = 'outbound' and r.drop_stop_id = new.stop_id)
      )
  ),
  logged as (
    insert into ride_events (org_id, rider_id, trip_id, stop_id, event_type, source, occurred_at)
    select v_org, a.rider_id, new.trip_id, new.stop_id,
           case when v_stop.is_campus then 'arrived_campus' else 'arrived_stop' end::ride_event_type,
           'geofence', new.arrived_at
    from arriving a
    returning rider_id
  )
  insert into notifications (profile_id, title, body, data)
  select
    g.profile_id,
    case when v_stop.is_campus then 'Reached school' else 'Dropped at stop' end,
    r.full_name
      || case when v_stop.is_campus
              then ' reached ' || v_stop.name
              else ' was dropped at ' || v_stop.name end
      || ' at ' || to_char(new.arrived_at at time zone o.timezone, 'HH12:MI AM') || '.',
    jsonb_build_object(
      'kind', case when v_stop.is_campus then 'arrived_campus' else 'arrived_stop' end,
      'rider_id', r.id,
      'trip_id', new.trip_id,
      'stop_id', new.stop_id
    )
  from logged l
  join riders r on r.id = l.rider_id
  join guardians g on g.rider_id = r.id
  join organizations o on o.id = v_org;

  return new;
end;
$$;

create trigger trg_on_stop_reached
  after insert on trip_stop_events
  for each row execute function app.on_stop_reached();

-- ---------------------------------------------------------------------------
-- Boarding is the one thing we refuse to guess. A geofence tells us the bus is
-- at a stop -- it cannot tell us the child walked onto it. So the driver taps
-- the manifest, and *that* is what notifies the parent.
-- ---------------------------------------------------------------------------

create or replace function app.on_ride_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_rider riders%rowtype;
  v_stop  stops%rowtype;
  v_tz    text;
begin
  if new.event_type not in ('boarded', 'absent') then
    return new;
  end if;

  select * into v_rider from riders where id = new.rider_id;
  select * into v_stop  from stops  where id = new.stop_id;
  select timezone into v_tz from organizations where id = new.org_id;

  insert into notifications (profile_id, title, body, data)
  select
    g.profile_id,
    case new.event_type
      when 'boarded' then 'Boarded the bus'
      when 'absent'  then 'Did not board'
    end,
    case new.event_type
      when 'boarded' then v_rider.full_name || ' boarded at ' || coalesce(v_stop.name, 'their stop')
                          || ' at ' || to_char(new.occurred_at at time zone coalesce(v_tz, 'UTC'), 'HH12:MI AM') || '.'
      when 'absent'  then v_rider.full_name || ' was not at ' || coalesce(v_stop.name, 'their stop')
                          || ' when the bus arrived.'
    end,
    jsonb_build_object('kind', new.event_type, 'rider_id', v_rider.id, 'trip_id', new.trip_id)
  from guardians g
  where g.rider_id = new.rider_id;

  return new;
end;
$$;

create trigger trg_on_ride_event
  after insert on ride_events
  for each row execute function app.on_ride_event();

-- ---------------------------------------------------------------------------
-- Trip lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.start_trip(p_trip_id uuid)
returns trips
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip trips%rowtype;
begin
  select * into v_trip from trips where id = p_trip_id;

  if not found then
    raise exception 'trip % not found', p_trip_id using errcode = 'no_data_found';
  end if;
  if v_trip.driver_id <> auth.uid() then
    raise exception 'not the driver of trip %', p_trip_id using errcode = 'insufficient_privilege';
  end if;
  if v_trip.status <> 'scheduled' then
    raise exception 'trip % already %', p_trip_id, v_trip.status using errcode = 'check_violation';
  end if;

  update trips
     set status = 'active', started_at = now()
   where id = p_trip_id
  returning * into v_trip;

  return v_trip;
end;
$$;

create or replace function public.end_trip(p_trip_id uuid)
returns trips
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip trips%rowtype;
begin
  select * into v_trip from trips where id = p_trip_id;

  if not found then
    raise exception 'trip % not found', p_trip_id using errcode = 'no_data_found';
  end if;
  if v_trip.driver_id <> auth.uid() then
    raise exception 'not the driver of trip %', p_trip_id using errcode = 'insufficient_privilege';
  end if;

  update trips
     set status = 'completed', ended_at = now()
   where id = p_trip_id
  returning * into v_trip;

  -- Stop broadcasting a position for a bus that is no longer running, so rider
  -- maps show "not running" instead of a ghost parked at the depot.
  delete from bus_live where trip_id = p_trip_id;

  return v_trip;
end;
$$;

grant execute on function public.ingest_location(uuid, double precision, double precision, real, real, real, timestamptz) to authenticated;
grant execute on function public.ingest_locations(uuid, jsonb) to authenticated;
grant execute on function public.start_trip(uuid) to authenticated;
grant execute on function public.end_trip(uuid) to authenticated;
