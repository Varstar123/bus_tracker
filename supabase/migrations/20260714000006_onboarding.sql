-- ============================================================================
-- BusTracker :: 0006 :: Roster-driven onboarding
--
-- Nobody gets to pick their own role. If self-signup assigned roles, any parent
-- could register as an admin and read the whole school. Instead the admin
-- uploads a roster of invites, and signing up merely *claims* a pre-authorised
-- seat that already carries the org, the role, and the child linkage.
--
-- An email with no invite gets an account with no profile -- and every RLS
-- policy in 0004 keys off `profiles`, so such a user can read precisely nothing.
-- ============================================================================

create table invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  email       text not null,
  role        user_role not null,
  full_name   text not null,
  phone       text,
  -- For role='parent': the child this account will be able to monitor.
  -- For role='student'/'faculty': the rider record this login *is*.
  rider_id    uuid references riders (id) on delete cascade,
  relation    text,
  claimed_at  timestamptz,
  claimed_by  uuid references profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Case-insensitive, because people type their email however they feel that day.
create unique index invites_email_rider_uniq
  on invites (lower(email), coalesce(rider_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where claimed_at is null;
create index on invites (lower(email));

alter table invites enable row level security;

create policy invites_admin_all on invites
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- Runs as the auth admin on every new signup.
-- ---------------------------------------------------------------------------

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_invite invites%rowtype;
  v_email  text := lower(new.email);
begin
  -- All invites for this email share one org and role; take the first for the
  -- profile, then walk the rest to wire up multiple children.
  select * into v_invite
  from invites
  where lower(email) = v_email and claimed_at is null
  order by created_at
  limit 1;

  if not found then
    -- No invite: leave them profile-less. They can authenticate but not read.
    return new;
  end if;

  insert into profiles (id, org_id, role, full_name, phone, email)
  values (new.id, v_invite.org_id, v_invite.role, v_invite.full_name, v_invite.phone, new.email)
  on conflict (id) do nothing;

  if v_invite.role = 'parent' then
    -- One parent, possibly several children on the roster.
    insert into guardians (profile_id, rider_id, relation, is_primary)
    select new.id, i.rider_id, i.relation, false
    from invites i
    where lower(i.email) = v_email
      and i.claimed_at is null
      and i.role = 'parent'
      and i.rider_id is not null
    on conflict (profile_id, rider_id) do nothing;

  elsif v_invite.role in ('student', 'faculty') and v_invite.rider_id is not null then
    -- This login *is* the rider: bind the account to their seat on the bus.
    update riders set profile_id = new.id
    where id = v_invite.rider_id and profile_id is null;
  end if;

  update invites
     set claimed_at = now(), claimed_by = new.id
   where lower(email) = v_email and claimed_at is null;

  return new;
end;
$$;

create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function app.handle_new_user();
