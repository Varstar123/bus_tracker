-- ============================================================================
-- BusTracker :: 0012 :: Trips exist every day, not just the day you seeded
--
-- THE BUG
--
-- Trips were only ever created by the seed, pinned to the date the seed happened
-- to run. Come tomorrow, `service_date = current_date` matches nothing, and the
-- driver opens the app to "No trips scheduled today" -- forever. The whole app
-- is dead from the second midnight onwards.
--
-- Caught the moment the clock rolled past midnight during testing: the demo was
-- seeded on the 13th and by the 14th there was nothing to drive.
--
-- THE FIX
--
-- A route already knows everything a trip needs: its bus, its driver, and the
-- fact it runs twice a day. So derive today's trips from the routes, on demand,
-- idempotently. The driver's app calls this when it loads, which is exactly when
-- the answer matters and costs one cheap upsert.
--
-- The unique index on (route_id, service_date, direction) is what makes it safe
-- to call as often as you like -- two drivers opening the app at once cannot
-- create duplicate trips.
-- ============================================================================

set search_path = public, extensions;

create or replace function public.ensure_todays_trips()
returns int
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_role  user_role;
  v_org   uuid;
  v_count int;
begin
  v_role := app.current_role();
  v_org  := app.current_org_id();

  if v_org is null then
    raise exception 'no profile' using errcode = 'insufficient_privilege';
  end if;

  -- Only the people who would actually run a bus may bring today's trips into
  -- being. A parent opening the app should not be quietly writing to `trips`.
  if v_role not in ('driver', 'admin') then
    raise exception 'only a driver or an admin may schedule trips'
      using errcode = 'insufficient_privilege';
  end if;

  with created as (
    insert into trips (org_id, route_id, bus_id, driver_id, direction, service_date, status)
    select
      r.org_id, r.id, r.bus_id, r.driver_id, d.direction, current_date, 'scheduled'
    from routes r
    -- Every route runs twice: out to campus in the morning, home in the evening.
    cross join (values ('inbound'::trip_direction), ('outbound'::trip_direction)) as d(direction)
    where r.is_active
      and r.org_id = v_org
      -- A route with no bus or no driver assigned cannot run. Skip it rather
      -- than fail: the office may still be filling the roster in.
      and r.bus_id is not null
      and r.driver_id is not null
      -- A driver only conjures their OWN trips. An admin does the whole fleet.
      and (v_role = 'admin' or r.driver_id = auth.uid())
    on conflict (route_id, service_date, direction) do nothing
    returning 1
  )
  select count(*)::int into v_count from created;

  return v_count;
end;
$$;

grant execute on function public.ensure_todays_trips() to authenticated;
revoke execute on function public.ensure_todays_trips() from anon;
