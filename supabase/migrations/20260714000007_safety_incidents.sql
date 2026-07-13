-- ============================================================================
-- BusTracker :: 0007 :: Safety & emergency (deck p.13)
--
--   Route Change Alert   -- notify riders + parents when a route is diverted
--   Accident Notification-- immediate alert to parents and the school
--   SOS for Passengers   -- a student can summon help in real time
--
-- The design rule throughout: an alert goes to the people who can *act* on it
-- and nobody else. An SOS wakes the school office, the child's own parents, and
-- the driver sitting ten feet away -- it does not wake 200 other families. Alarm
-- spam is how safety features get muted, and a muted alarm is worse than none.
-- ============================================================================


-- PostGIS may live in `public` or in `extensions` depending on how the project
-- was provisioned. Naming both means this migration applies either way.
set search_path = public, extensions;

create type incident_kind as enum ('sos', 'accident', 'breakdown', 'route_change');
create type incident_status as enum ('open', 'acknowledged', 'resolved');

create table incidents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  trip_id         uuid references trips (id) on delete set null,
  route_id        uuid references routes (id) on delete set null,
  kind            incident_kind not null,
  status          incident_status not null default 'open',
  reported_by     uuid not null references profiles (id) on delete restrict,
  -- Set when a passenger (not the driver) raised it -- i.e. an SOS.
  rider_id        uuid references riders (id) on delete set null,
  -- Where it happened. For an SOS this is the single most useful field in the
  -- row, so it is captured on the phone at press time, not looked up later.
  location        geography(Point, 4326),
  lat             double precision,
  lng             double precision,
  note            text,
  acknowledged_by uuid references profiles (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on incidents (org_id, status, created_at desc);
create index on incidents (trip_id);

create trigger trg_incidents_latlng
  before insert or update of location on incidents
  for each row execute function app.sync_latlng();

-- ---------------------------------------------------------------------------
-- Audiences
-- ---------------------------------------------------------------------------

-- Everyone travelling a route, plus their guardians.
create or replace function app.route_audience(p_route_id uuid)
returns table (profile_id uuid, rider_id uuid, rider_name text)
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  with aboard as (
    select r.id, r.full_name, r.profile_id
    from riders r
    where r.route_id = p_route_id and r.is_active
  )
  select a.profile_id, a.id, a.full_name from aboard a where a.profile_id is not null
  union
  select g.profile_id, a.id, a.full_name from aboard a join guardians g on g.rider_id = a.id;
$$;

create or replace function app.org_admins(p_org_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select id from profiles where org_id = p_org_id and role = 'admin' and is_active;
$$;

-- ---------------------------------------------------------------------------
-- Fan-out. Runs on insert so every path that creates an incident -- RPC, admin
-- console, a future hardware panic button -- notifies identically.
-- ---------------------------------------------------------------------------

create or replace function app.on_incident()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_title    text;
  v_body     text;
  v_severity text;
  v_rider    text;
  v_route    text;
  v_driver   uuid;
  v_where    text;
begin
  select full_name into v_rider from riders where id = new.rider_id;
  select name into v_route from routes where id = new.route_id;
  select driver_id into v_driver from trips where id = new.trip_id;

  -- A raw lat/lng is not something a panicking parent can use, but it is
  -- exactly what the school office needs to dispatch help, so include it.
  v_where := case
    when new.lat is not null
      then ' Location: ' || round(new.lat::numeric, 5) || ', ' || round(new.lng::numeric, 5) || '.'
    else ''
  end;

  if new.kind = 'sos' then
    v_severity := 'critical';
    v_title := 'SOS - emergency on the bus';
    v_body := coalesce(v_rider, 'A passenger') || ' raised an emergency alert on '
              || coalesce(v_route, 'their route') || '.'
              || coalesce(' ' || nullif(new.note, ''), '') || v_where;

    -- School office + this child's own parents + the driver on board. Nobody else.
    insert into notifications (profile_id, title, body, severity, data)
    select p, v_title, v_body, v_severity,
           jsonb_build_object('kind', 'sos', 'incident_id', new.id, 'trip_id', new.trip_id)
    from (
      select profile_id as p from app.org_admins(new.org_id)
      union
      select g.profile_id from guardians g where g.rider_id = new.rider_id
      union
      select v_driver where v_driver is not null
    ) targets
    where p is not null and p <> new.reported_by;

  elsif new.kind = 'accident' then
    v_severity := 'critical';
    v_title := 'Accident reported';
    v_body := 'The bus on ' || coalesce(v_route, 'this route')
              || ' has reported an accident. The school has been alerted.'
              || coalesce(' ' || nullif(new.note, ''), '') || v_where;

    insert into notifications (profile_id, title, body, severity, data)
    select p, v_title, v_body, v_severity,
           jsonb_build_object('kind', 'accident', 'incident_id', new.id, 'trip_id', new.trip_id)
    from (
      select profile_id as p from app.org_admins(new.org_id)
      union
      select profile_id from app.route_audience(new.route_id)
    ) targets
    where p is not null and p <> new.reported_by;

  elsif new.kind = 'breakdown' then
    v_severity := 'warning';
    v_title := 'Bus breakdown';
    v_body := 'The bus on ' || coalesce(v_route, 'this route')
              || ' has broken down. The school is arranging a replacement.'
              || coalesce(' ' || nullif(new.note, ''), '');

    insert into notifications (profile_id, title, body, severity, data)
    select p, v_title, v_body, v_severity,
           jsonb_build_object('kind', 'breakdown', 'incident_id', new.id, 'trip_id', new.trip_id)
    from (
      select profile_id as p from app.org_admins(new.org_id)
      union
      select profile_id from app.route_audience(new.route_id)
    ) targets
    where p is not null and p <> new.reported_by;

  elsif new.kind = 'route_change' then
    v_severity := 'warning';
    v_title := 'Route diverted';
    v_body := coalesce(v_route, 'Your route') || ' has been diverted today.'
              || coalesce(' ' || nullif(new.note, ''), '')
              || ' Check the live map for the current position.';

    insert into notifications (profile_id, title, body, severity, data)
    select p, v_title, v_body, v_severity,
           jsonb_build_object('kind', 'route_change', 'incident_id', new.id, 'trip_id', new.trip_id)
    from (
      select profile_id as p from app.route_audience(new.route_id)
      union
      select profile_id from app.org_admins(new.org_id)
    ) targets
    where p is not null and p <> new.reported_by;
  end if;

  return new;
end;
$$;

create trigger trg_on_incident
  after insert on incidents
  for each row execute function app.on_incident();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Driver (or admin) reporting something about a trip they are running.
create or replace function public.report_incident(
  p_trip_id uuid,
  p_kind    incident_kind,
  p_note    text default null,
  p_lat     double precision default null,
  p_lng     double precision default null
)
returns incidents
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_trip     trips%rowtype;
  v_incident incidents%rowtype;
begin
  select * into v_trip from trips where id = p_trip_id;
  if not found then
    raise exception 'trip % not found', p_trip_id using errcode = 'no_data_found';
  end if;

  if v_trip.driver_id <> auth.uid() and not app.is_admin() then
    raise exception 'only the driver or an admin may report on trip %', p_trip_id
      using errcode = 'insufficient_privilege';
  end if;

  insert into incidents (org_id, trip_id, route_id, kind, reported_by, note, location)
  values (
    v_trip.org_id, v_trip.id, v_trip.route_id, p_kind, auth.uid(), nullif(trim(p_note), ''),
    case when p_lat is not null and p_lng is not null
         then ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography end
  )
  returning * into v_incident;

  return v_incident;
end;
$$;

-- The passenger SOS button. Deliberately takes no trip id: a child in trouble
-- should not have to pick the right trip from a list, so we resolve it from
-- their route. It still works if no trip is running -- the alert simply carries
-- no trip, and the school office gets it anyway.
create or replace function public.raise_sos(
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_note text default null
)
returns incidents
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_profile  profiles%rowtype;
  v_rider    riders%rowtype;
  v_trip     trips%rowtype;
  v_incident incidents%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then
    raise exception 'no profile' using errcode = 'insufficient_privilege';
  end if;

  select * into v_rider from riders where profile_id = auth.uid();

  if v_rider.route_id is not null then
    select * into v_trip
    from trips
    where route_id = v_rider.route_id
      and status = 'active'
    order by started_at desc
    limit 1;
  end if;

  insert into incidents (org_id, trip_id, route_id, kind, reported_by, rider_id, note, location)
  values (
    v_profile.org_id, v_trip.id, coalesce(v_trip.route_id, v_rider.route_id),
    'sos', auth.uid(), v_rider.id, nullif(trim(p_note), ''),
    case when p_lat is not null and p_lng is not null
         then ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography end
  )
  returning * into v_incident;

  return v_incident;
end;
$$;

create or replace function public.acknowledge_incident(p_incident_id uuid)
returns incidents
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_incident incidents%rowtype;
begin
  if not app.is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  update incidents
     set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_at = now()
   where id = p_incident_id
     and org_id = app.current_org_id()
     and status = 'open'
  returning * into v_incident;

  if not found then
    raise exception 'incident % not open', p_incident_id using errcode = 'no_data_found';
  end if;

  -- Close the loop: whoever pressed the button learns that a human has it.
  insert into notifications (profile_id, title, body, severity, data)
  values (
    v_incident.reported_by,
    'Help is on the way',
    'The school has seen your alert and is responding.',
    'warning',
    jsonb_build_object('kind', 'incident_ack', 'incident_id', v_incident.id)
  );

  return v_incident;
end;
$$;

create or replace function public.resolve_incident(p_incident_id uuid)
returns incidents
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_incident incidents%rowtype;
begin
  if not app.is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;

  update incidents
     set status = 'resolved', resolved_at = now()
   where id = p_incident_id and org_id = app.current_org_id()
  returning * into v_incident;

  return v_incident;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table incidents  enable row level security;
alter table trip_alerts enable row level security;

create policy incidents_read on incidents
  for select to authenticated
  using (
    (app.is_admin() and org_id = app.current_org_id())
    or reported_by = auth.uid()
    or exists (select 1 from trips t where t.id = incidents.trip_id and t.driver_id = auth.uid())
    or exists (
      select 1 from riders r
      where r.id in (select app.visible_rider_ids())
        and r.route_id = incidents.route_id
    )
  );

-- No insert/update policy: incidents are created and moved only through the
-- RPCs above, which do their own authorisation.
create policy incidents_admin_write on incidents
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

create policy trip_alerts_read on trip_alerts
  for select to authenticated
  using (exists (
    select 1 from trips t
    where t.id = trip_alerts.trip_id and t.org_id = app.current_org_id()
  ));

alter publication supabase_realtime add table incidents;
alter table incidents replica identity full;

grant execute on function public.report_incident(uuid, incident_kind, text, double precision, double precision) to authenticated;
grant execute on function public.raise_sos(double precision, double precision, text) to authenticated;
grant execute on function public.acknowledge_incident(uuid) to authenticated;
grant execute on function public.resolve_incident(uuid) to authenticated;
