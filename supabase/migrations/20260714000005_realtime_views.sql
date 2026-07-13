-- ============================================================================
-- BusTracker :: 0005 :: Client-friendly lat/lng, realtime, views
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PostGIS geography serialises over the wire as WKB hex, which is useless to a
-- map component and to realtime payloads. Mirror every point into plain lat/lng
-- columns and keep them in sync with a trigger.
--
-- A trigger rather than a GENERATED column on purpose: the geography->geometry
-- cast is not reliably treated as immutable across PostGIS versions, and a
-- failed migration on the customer's database is a worse trade than a trigger.
-- ---------------------------------------------------------------------------


-- PostGIS may live in `public` or in `extensions` depending on how the project
-- was provisioned. Naming both means this migration applies either way.
set search_path = public, extensions;

alter table stops    add column lat double precision, add column lng double precision;
alter table bus_live add column lat double precision, add column lng double precision;

create or replace function app.sync_latlng()
returns trigger
language plpgsql
as $$
begin
  new.lat := ST_Y(new.location::geometry);
  new.lng := ST_X(new.location::geometry);
  return new;
end;
$$;

create trigger trg_stops_latlng
  before insert or update of location on stops
  for each row execute function app.sync_latlng();

create trigger trg_bus_live_latlng
  before insert or update of location on bus_live
  for each row execute function app.sync_latlng();

-- ---------------------------------------------------------------------------
-- Realtime
--
-- Only three tables are published, and each is deliberately small:
--   bus_live      -- one row per bus, the moving dot on the map
--   notifications -- per-user, already scoped by RLS
--   ride_events   -- the parent timeline updating live
--
-- bus_locations (the firehose) is NOT published. Publishing it would push every
-- 5-second fix to every subscribed phone and melt both the database and the
-- users' data plans.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table bus_live;
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table ride_events;

-- Realtime applies RLS to each change before sending it, and needs the full old
-- row to do that on updates.
alter table bus_live      replica identity full;
alter table notifications replica identity full;
alter table ride_events   replica identity full;

-- ---------------------------------------------------------------------------
-- Views
--
-- security_invoker is essential: without it a view runs as its owner and
-- silently bypasses every RLS policy in 0004, which would hand any parent the
-- entire school roster.
-- ---------------------------------------------------------------------------

-- Everything the app needs to render one rider's card in a single round trip.
create view v_riders_expanded
with (security_invoker = true)
as
select
  r.id,
  r.org_id,
  r.profile_id,
  r.full_name,
  r.kind,
  r.class_section,
  r.is_active,
  r.route_id,
  ro.name  as route_name,
  ro.code  as route_code,
  b.id     as bus_id,
  b.display_name as bus_name,
  b.registration_no,
  d.full_name as driver_name,
  d.phone     as driver_phone,
  ps.id    as pickup_stop_id,
  ps.name  as pickup_stop_name,
  ds.id    as drop_stop_id,
  ds.name  as drop_stop_name
from riders r
left join routes   ro on ro.id = r.route_id
left join buses    b  on b.id  = ro.bus_id
left join profiles d  on d.id  = ro.driver_id
left join stops    ps on ps.id = r.pickup_stop_id
left join stops    ds on ds.id = r.drop_stop_id;

-- Today's trips with the live position folded in -- what the rider map reads.
create view v_active_trips
with (security_invoker = true)
as
select
  t.id            as trip_id,
  t.org_id,
  t.route_id,
  t.direction,
  t.status,
  t.started_at,
  t.service_date,
  ro.name         as route_name,
  ro.code         as route_code,
  b.id            as bus_id,
  b.display_name  as bus_name,
  d.full_name     as driver_name,
  d.phone         as driver_phone,
  bl.lat,
  bl.lng,
  bl.heading,
  bl.speed_kmh,
  bl.eta_seconds,
  bl.recorded_at,
  ns.id           as next_stop_id,
  ns.name         as next_stop_name
from trips t
join routes ro    on ro.id = t.route_id
join buses  b     on b.id  = t.bus_id
join profiles d   on d.id  = t.driver_id
left join bus_live bl on bl.trip_id = t.id
left join stops ns    on ns.id = bl.next_stop_id
where t.status = 'active';

-- The driver's manifest: who is expected at each stop on this trip, and whether
-- they have already been marked. Ordered the way the bus will actually drive it.
create view v_trip_manifest
with (security_invoker = true)
as
select
  t.id                as trip_id,
  r.id                as rider_id,
  r.full_name,
  r.class_section,
  rs.seq,
  s.id                as stop_id,
  s.name              as stop_name,
  tse.arrived_at      as stop_arrived_at,
  ev.event_type       as marked_as,
  ev.occurred_at      as marked_at
from trips t
join riders r
  on r.route_id = t.route_id
 and r.is_active
join stops s
  on s.id = case when t.direction = 'inbound' then r.pickup_stop_id else r.drop_stop_id end
join route_stops rs
  on rs.route_id = t.route_id and rs.stop_id = s.id
left join trip_stop_events tse
  on tse.trip_id = t.id and tse.stop_id = s.id
left join lateral (
  select e.event_type, e.occurred_at
  from ride_events e
  where e.trip_id = t.id
    and e.rider_id = r.id
    and e.event_type in ('boarded', 'absent')
  order by e.occurred_at desc
  limit 1
) ev on true;

grant select on v_riders_expanded, v_active_trips, v_trip_manifest to authenticated;
