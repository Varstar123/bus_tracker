-- ============================================================================
-- BusTracker :: 0011 :: One stop alert per person, not per child
--
-- THE BUG
--
-- app.stop_audience returns a row per (profile, rider) pair, because the alerts
-- that carry a child's name -- "Aarav boarded", "Diya was dropped" -- genuinely
-- do need one row per child.
--
-- But the stop-level alerts ("Bus reaches Domlur Bridge in about 2 min") are
-- about the STOP. Their text never mentions a child. So a parent with two kids
-- who board at the same stop received the identical push twice.
--
-- Caught with the demo seed, where Suresh has both Diya and Kabir at Domlur
-- Bridge. He got "Bus arriving soon" twice, word for word. A family with three
-- children on one route would have got it three times.
--
-- THE FIX
--
-- Collapse the audience to one row per profile for stop-level alerts only. The
-- per-child alerts in app.on_ride_event and app.on_stop_reached are left exactly
-- as they are -- a parent with two kids SHOULD get "Diya boarded" and "Kabir
-- boarded" as two separate messages, because those say different things.
-- ============================================================================

set search_path = public, extensions;

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
          'eta_seconds', p_eta_seconds
        )
      -- DISTINCT ON collapses a parent with several children at this stop down to
      -- a single notification. Without it Suresh, who has two kids at Domlur, got
      -- the identical push twice.
      from (
        select distinct on (s.profile_id) s.profile_id
        from app.stop_audience(p_trip, p_stop_id) s
        order by s.profile_id
      ) a;
    end if;
  end if;

  -- ---- delayed --------------------------------------------------------------
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
          'late_minutes', v_late_min
        )
      from (
        select distinct on (s.profile_id) s.profile_id
        from app.stop_audience(p_trip, p_stop_id) s
        order by s.profile_id
      ) a;
    end if;
  end if;
end;
$$;
