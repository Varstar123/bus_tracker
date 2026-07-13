-- ============================================================================
-- BusTracker :: demo seed
--
-- One school, one route, one bus, four riders, two parents.
-- Every login below uses the password: password123
--
--   admin@demo.school     -- admin
--   ramesh@demo.school    -- driver
--   priya@demo.parent     -- parent of Aarav (Grade 5-B)
--   suresh@demo.parent    -- parent of Diya AND Kabir (two kids, one account)
--   meera@demo.college    -- college student (rides + tracks, no guardian)
--   anand@demo.school     -- faculty
--
-- Note the users are created by INSERTing into auth.users, which fires the real
-- handle_new_user trigger from 0006. So this seed is also an end-to-end test of
-- onboarding: if invites are wired wrong, the seed produces broken profiles.
-- ============================================================================

-- PostGIS and pgcrypto may live in `public` or in `extensions` depending on how
-- the project was provisioned. Naming both means this seed runs either way.
set search_path = public, extensions;

-- Creates a confirmed, password-login auth user the way GoTrue would.
create or replace function app.seed_user(p_email text, p_password text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    p_email, crypt(p_password, gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  )
  values (
    gen_random_uuid(), v_id,
    jsonb_build_object('sub', v_id::text, 'email', p_email),
    'email', v_id::text,
    now(), now(), now()
  );

  return v_id;
end;
$$;

do $$
declare
  v_org      uuid;
  v_bus      uuid;
  v_route    uuid;
  s_indira   uuid; s_domlur uuid; s_marath uuid; s_brook uuid; s_campus uuid;
  v_admin    uuid; v_driver uuid;
  r_aarav    uuid; r_diya uuid; r_kabir uuid; r_meera uuid; r_anand uuid;
  v_trip_in  uuid; v_trip_out uuid;
begin

  -- --------------------------------------------------------------------------
  -- Institution + fleet
  -- --------------------------------------------------------------------------
  insert into organizations (name, kind, timezone)
  values ('Greenwood International School', 'school', 'Asia/Kolkata')
  returning id into v_org;

  insert into buses (org_id, registration_no, display_name, capacity)
  values (v_org, 'KA-01-MB-4412', 'Bus 12 - Green Line', 42)
  returning id into v_bus;

  -- A real Bangalore corridor: Indiranagar -> Domlur -> Marathahalli -> campus.
  insert into stops (org_id, name, address, location, geofence_radius_m, is_campus) values
    (v_org, 'Indiranagar Metro',   '100 Ft Rd, Indiranagar',  ST_SetSRID(ST_MakePoint(77.6408, 12.9784), 4326)::geography, 120, false),
    (v_org, 'Domlur Bridge',       'Old Airport Rd, Domlur',  ST_SetSRID(ST_MakePoint(77.6387, 12.9611), 4326)::geography, 120, false),
    (v_org, 'Marathahalli Bridge', 'ORR, Marathahalli',       ST_SetSRID(ST_MakePoint(77.7011, 12.9569), 4326)::geography, 150, false),
    (v_org, 'Brookefield',         'ITPL Main Rd, Brookefield',ST_SetSRID(ST_MakePoint(77.7169, 12.9698), 4326)::geography, 120, false),
    (v_org, 'Greenwood Campus',    'Whitefield Main Rd',      ST_SetSRID(ST_MakePoint(77.7500, 12.9698), 4326)::geography, 200, true);

  select id into s_indira from stops where org_id = v_org and name = 'Indiranagar Metro';
  select id into s_domlur from stops where org_id = v_org and name = 'Domlur Bridge';
  select id into s_marath from stops where org_id = v_org and name = 'Marathahalli Bridge';
  select id into s_brook  from stops where org_id = v_org and name = 'Brookefield';
  select id into s_campus from stops where org_id = v_org and name = 'Greenwood Campus';

  -- --------------------------------------------------------------------------
  -- Staff. Invite first, then sign up -- the trigger builds the profile.
  -- --------------------------------------------------------------------------
  insert into invites (org_id, email, role, full_name, phone)
  values (v_org, 'admin@demo.school',  'admin',  'Latha Menon',   '+91 98450 10001'),
         (v_org, 'ramesh@demo.school', 'driver', 'Ramesh Kumar',  '+91 98450 10002');

  v_admin  := app.seed_user('admin@demo.school',  'password123');
  v_driver := app.seed_user('ramesh@demo.school', 'password123');

  -- --------------------------------------------------------------------------
  -- Route: five stops, ~10 minutes apart in the morning run.
  -- --------------------------------------------------------------------------
  insert into routes (org_id, name, code, bus_id, driver_id)
  values (v_org, 'Route 4 - Indiranagar / Whitefield', 'R4', v_bus, v_driver)
  returning id into v_route;

  insert into route_stops (route_id, stop_id, seq, offset_minutes) values
    (v_route, s_indira,  1, 0),
    (v_route, s_domlur,  2, 10),
    (v_route, s_marath,  3, 25),
    (v_route, s_brook,   4, 35),
    (v_route, s_campus,  5, 45);

  -- --------------------------------------------------------------------------
  -- Riders
  -- --------------------------------------------------------------------------
  insert into riders (org_id, full_name, kind, class_section, route_id, pickup_stop_id, drop_stop_id) values
    (v_org, 'Aarav Sharma',  'school_student',  'Grade 5-B',   v_route, s_indira, s_indira),
    (v_org, 'Diya Nair',     'school_student',  'Grade 3-A',   v_route, s_domlur, s_domlur),
    (v_org, 'Kabir Nair',    'school_student',  'Grade 7-C',   v_route, s_domlur, s_domlur),
    (v_org, 'Meera Raghav',  'college_student', 'CSE 3rd Yr',  v_route, s_marath, s_marath),
    (v_org, 'Anand Iyer',    'faculty',         'Mathematics', v_route, s_brook,  s_brook);

  select id into r_aarav from riders where org_id = v_org and full_name = 'Aarav Sharma';
  select id into r_diya  from riders where org_id = v_org and full_name = 'Diya Nair';
  select id into r_kabir from riders where org_id = v_org and full_name = 'Kabir Nair';
  select id into r_meera from riders where org_id = v_org and full_name = 'Meera Raghav';
  select id into r_anand from riders where org_id = v_org and full_name = 'Anand Iyer';

  -- --------------------------------------------------------------------------
  -- Parents. Suresh gets two invite rows -- one per child -- which is exactly
  -- how the trigger wires a single login to two kids.
  -- --------------------------------------------------------------------------
  insert into invites (org_id, email, role, full_name, phone, rider_id, relation) values
    (v_org, 'priya@demo.parent',  'parent',  'Priya Sharma',  '+91 98450 20001', r_aarav, 'mother'),
    (v_org, 'suresh@demo.parent', 'parent',  'Suresh Nair',   '+91 98450 20002', r_diya,  'father'),
    (v_org, 'suresh@demo.parent', 'parent',  'Suresh Nair',   '+91 98450 20002', r_kabir, 'father');

  -- Riders who log in as themselves.
  insert into invites (org_id, email, role, full_name, phone, rider_id) values
    (v_org, 'meera@demo.college', 'student', 'Meera Raghav', '+91 98450 30001', r_meera),
    (v_org, 'anand@demo.school',  'faculty', 'Anand Iyer',   '+91 98450 30002', r_anand);

  perform app.seed_user('priya@demo.parent',  'password123');
  perform app.seed_user('suresh@demo.parent', 'password123');
  perform app.seed_user('meera@demo.college', 'password123');
  perform app.seed_user('anand@demo.school',  'password123');

  -- --------------------------------------------------------------------------
  -- Bus fees. One settled, one due, one already overdue -- so every state in the
  -- payments UI has something to render without you having to create it.
  -- --------------------------------------------------------------------------
  insert into fee_invoices (org_id, rider_id, period_label, amount_paise, due_date, status, paid_at) values
    (v_org, r_aarav, 'April 2026', 120000, date '2026-04-30', 'paid', now() - interval '75 days'),
    (v_org, r_aarav, 'May 2026',   120000, current_date + 12,  'pending', null),
    (v_org, r_diya,  'May 2026',   120000, current_date + 12,  'pending', null),
    (v_org, r_kabir, 'May 2026',   120000, current_date - 5,   'overdue', null),
    (v_org, r_meera, 'Term 1 2026', 450000, current_date + 20, 'pending', null);

  -- --------------------------------------------------------------------------
  -- Today's two runs. Both start 'scheduled' -- the driver presses Start.
  -- --------------------------------------------------------------------------
  insert into trips (org_id, route_id, bus_id, driver_id, direction, service_date, status)
  values (v_org, v_route, v_bus, v_driver, 'inbound',  current_date, 'scheduled')
  returning id into v_trip_in;

  insert into trips (org_id, route_id, bus_id, driver_id, direction, service_date, status)
  values (v_org, v_route, v_bus, v_driver, 'outbound', current_date, 'scheduled')
  returning id into v_trip_out;

  raise notice 'Seeded org % / route % / trips % and %', v_org, v_route, v_trip_in, v_trip_out;
end;
$$;

drop function app.seed_user(text, text);
