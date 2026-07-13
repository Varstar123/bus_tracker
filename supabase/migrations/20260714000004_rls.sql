-- ============================================================================
-- BusTracker :: 0004 :: Row-level security
--
-- Threat model, stated plainly: a parent must never be able to read another
-- family's child, and a rider must never be able to write telemetry. Everything
-- below follows from those two sentences. All writes to trips and telemetry go
-- through the SECURITY DEFINER RPCs in 0003, which do their own authorisation --
-- so the table policies here can stay read-mostly and deny by default.
-- ============================================================================

alter table organizations   enable row level security;
alter table profiles        enable row level security;
alter table buses           enable row level security;
alter table stops           enable row level security;
alter table routes          enable row level security;
alter table route_stops     enable row level security;
alter table riders          enable row level security;
alter table guardians       enable row level security;
alter table trips           enable row level security;
alter table bus_locations   enable row level security;
alter table bus_live        enable row level security;
alter table trip_stop_events enable row level security;
alter table ride_events     enable row level security;
alter table device_tokens   enable row level security;
alter table notifications   enable row level security;

-- ---------------------------------------------------------------------------
-- Org + directory
-- ---------------------------------------------------------------------------

create policy org_read on organizations
  for select to authenticated
  using (id = app.current_org_id());

-- Names within a school are not a secret, and a parent seeing "Driver: Ramesh"
-- is a feature, not a leak. Cross-org reads stay impossible.
create policy profiles_read_own_org on profiles
  for select to authenticated
  using (org_id = app.current_org_id());

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and org_id = app.current_org_id());

create policy profiles_admin_write on profiles
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- Fleet reference data: everyone in the org reads, only admins write.
-- ---------------------------------------------------------------------------

create policy buses_read on buses
  for select to authenticated using (org_id = app.current_org_id());
create policy buses_admin_write on buses
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

create policy stops_read on stops
  for select to authenticated using (org_id = app.current_org_id());
create policy stops_admin_write on stops
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

create policy routes_read on routes
  for select to authenticated using (org_id = app.current_org_id());
create policy routes_admin_write on routes
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

create policy route_stops_read on route_stops
  for select to authenticated
  using (exists (
    select 1 from routes r
    where r.id = route_stops.route_id and r.org_id = app.current_org_id()
  ));
create policy route_stops_admin_write on route_stops
  for all to authenticated
  using (app.is_admin() and exists (
    select 1 from routes r
    where r.id = route_stops.route_id and r.org_id = app.current_org_id()
  ))
  with check (app.is_admin() and exists (
    select 1 from routes r
    where r.id = route_stops.route_id and r.org_id = app.current_org_id()
  ));

-- ---------------------------------------------------------------------------
-- Riders -- the sensitive one.
--
-- You may read a rider only if you ARE them, you are their guardian, you are
-- the driver currently running their route (you need the manifest), or you are
-- an admin. There is deliberately no "any parent can read any child" path.
-- ---------------------------------------------------------------------------

create policy riders_read_visible on riders
  for select to authenticated
  using (
    id in (select app.visible_rider_ids())
    or (app.is_admin() and org_id = app.current_org_id())
    or exists (
      select 1 from trips t
      where t.driver_id = auth.uid()
        and t.status = 'active'
        and t.route_id = riders.route_id
    )
  );

create policy riders_admin_write on riders
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

create policy guardians_read_own on guardians
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (app.is_admin() and exists (
      select 1 from riders r
      where r.id = guardians.rider_id and r.org_id = app.current_org_id()
    ))
  );

create policy guardians_admin_write on guardians
  for all to authenticated
  using (app.is_admin() and exists (
    select 1 from riders r where r.id = guardians.rider_id and r.org_id = app.current_org_id()
  ))
  with check (app.is_admin() and exists (
    select 1 from riders r where r.id = guardians.rider_id and r.org_id = app.current_org_id()
  ));

-- ---------------------------------------------------------------------------
-- Trips + telemetry
--
-- Note there is no INSERT/UPDATE policy for drivers anywhere here. That is not
-- an oversight: drivers mutate trips exclusively through start_trip / end_trip /
-- ingest_location, which verify `driver_id = auth.uid()` themselves.
-- ---------------------------------------------------------------------------

create policy trips_read on trips
  for select to authenticated using (org_id = app.current_org_id());

create policy trips_admin_write on trips
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

-- Everyone in the org may watch every bus move. This is the core feature.
create policy bus_live_read on bus_live
  for select to authenticated using (org_id = app.current_org_id());

-- The raw GPS firehose is a movement history of a named driver. Riders get the
-- live dot; only admins get the trail.
create policy bus_locations_admin_read on bus_locations
  for select to authenticated
  using (app.is_admin() and exists (
    select 1 from trips t
    where t.id = bus_locations.trip_id and t.org_id = app.current_org_id()
  ));

create policy trip_stop_events_read on trip_stop_events
  for select to authenticated
  using (exists (
    select 1 from trips t
    where t.id = trip_stop_events.trip_id and t.org_id = app.current_org_id()
  ));

-- ---------------------------------------------------------------------------
-- Ride events: the parent timeline, and the driver's manifest taps.
-- ---------------------------------------------------------------------------

create policy ride_events_read on ride_events
  for select to authenticated
  using (
    rider_id in (select app.visible_rider_ids())
    or (app.is_admin() and org_id = app.current_org_id())
    or exists (
      select 1 from trips t
      where t.id = ride_events.trip_id and t.driver_id = auth.uid()
    )
  );

-- A driver may only mark attendance for riders on the trip they are running,
-- and only while it is running. `recorded_by` is pinned to the caller so the
-- audit trail cannot be forged.
create policy ride_events_driver_insert on ride_events
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and source = 'driver'
    and exists (
      select 1 from trips t
      join riders r on r.id = ride_events.rider_id
      where t.id = ride_events.trip_id
        and t.driver_id = auth.uid()
        and t.status = 'active'
        and t.route_id = r.route_id
        and t.org_id = ride_events.org_id
    )
  );

create policy ride_events_admin_write on ride_events
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- Per-user private data
-- ---------------------------------------------------------------------------

create policy device_tokens_own on device_tokens
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy notifications_read_own on notifications
  for select to authenticated
  using (profile_id = auth.uid());

-- Marking your own notification as read. Inserts are done by triggers running
-- as SECURITY DEFINER, so no insert policy is needed or wanted.
create policy notifications_update_own on notifications
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());
