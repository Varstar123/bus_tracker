-- ============================================================================
-- BusTracker :: 0008 :: Bus fees & payments (deck p.11 / p.12)
--
-- Two rules govern this whole file.
--
--   1. Money is stored in paise as an integer. Never a float -- 0.1 + 0.2 is
--      not 0.3 in binary floating point, and that is not a bug you want on a
--      fee receipt.
--
--   2. The client never states an amount. It names an *invoice*; the server
--      looks up what that invoice costs. An app that posts "amount: 100" to a
--      payment endpoint is an app whose fees are whatever the user edits them
--      to be. Consequently there is no INSERT policy on `payments` at all --
--      only the edge function, holding the service_role key, may write there.
-- ============================================================================


-- PostGIS may live in `public` or in `extensions` depending on how the project
-- was provisioned. Naming both means this migration applies either way.
set search_path = public, extensions;

create type invoice_status as enum ('pending', 'paid', 'overdue', 'cancelled');
create type payment_status as enum ('created', 'captured', 'failed', 'refunded');

create table fee_invoices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  rider_id      uuid not null references riders (id) on delete cascade,
  period_label  text not null,                    -- 'May 2026', 'Term 1 2026'
  amount_paise  bigint not null check (amount_paise > 0),
  currency      text not null default 'INR',
  due_date      date not null,
  status        invoice_status not null default 'pending',
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  -- One invoice per rider per period. Stops a double-billing bug cold.
  unique (rider_id, period_label)
);
create index on fee_invoices (org_id, status);
create index on fee_invoices (rider_id, due_date desc);

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  invoice_id          uuid not null references fee_invoices (id) on delete restrict,
  -- Who tapped Pay. Kept even after the invoice is settled, for the receipt.
  profile_id          uuid not null references profiles (id) on delete restrict,
  amount_paise        bigint not null check (amount_paise > 0),
  currency            text not null default 'INR',
  provider            text not null default 'razorpay',
  provider_order_id   text unique,
  provider_payment_id text unique,
  status              payment_status not null default 'created',
  -- Whatever the gateway sent us, verbatim. When a parent says "the bank took
  -- my money and the app says unpaid", this column is the only thing that can
  -- settle the argument.
  raw                 jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  captured_at         timestamptz
);
create index on payments (invoice_id);
create index on payments (profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Capture -> invoice paid -> receipt notification.
--
-- A trigger, not application code, because the capture can arrive from two
-- different directions (the client returning from checkout, and the gateway's
-- webhook) and whichever lands first must settle the invoice exactly once.
-- ---------------------------------------------------------------------------

create or replace function app.on_payment_captured()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_invoice fee_invoices%rowtype;
  v_rider   text;
  v_tz      text;
begin
  if new.status <> 'captured' then
    return new;
  end if;

  -- Idempotent: if the webhook and the client both report the same capture, the
  -- second one finds the invoice already paid and changes nothing.
  update fee_invoices
     set status = 'paid', paid_at = coalesce(new.captured_at, now())
   where id = new.invoice_id
     and status <> 'paid'
  returning * into v_invoice;

  if not found then
    return new;
  end if;

  select full_name into v_rider from riders where id = v_invoice.rider_id;
  select timezone into v_tz from organizations where id = new.org_id;

  insert into notifications (profile_id, title, body, severity, data)
  values (
    new.profile_id,
    'Payment received',
    'Bus fee of ' || to_char(new.amount_paise / 100.0, 'FM999G999G990D00')
      || ' for ' || coalesce(v_rider, 'your ward') || ' (' || v_invoice.period_label
      || ') has been paid. Receipt: ' || coalesce(new.provider_payment_id, new.id::text) || '.',
    'info',
    jsonb_build_object(
      'kind', 'payment_received',
      'invoice_id', v_invoice.id,
      'payment_id', new.id,
      'amount_paise', new.amount_paise
    )
  );

  return new;
end;
$$;

create trigger trg_on_payment_captured
  after insert or update of status on payments
  for each row execute function app.on_payment_captured();

-- Flip pending invoices past their due date. Wire to pg_cron:
--   select cron.schedule('overdue', '0 1 * * *', 'select public.mark_overdue_invoices()');
create or replace function public.mark_overdue_invoices()
returns int
language plpgsql
security definer
set search_path = public, extensions, app
as $$
declare
  v_count int;
begin
  with bumped as (
    update fee_invoices
       set status = 'overdue'
     where status = 'pending' and due_date < current_date
    returning id, rider_id, org_id, period_label, amount_paise
  ),
  told as (
    insert into notifications (profile_id, title, body, severity, data)
    select
      g.profile_id,
      'Bus fee overdue',
      'The bus fee of ' || to_char(b.amount_paise / 100.0, 'FM999G999G990D00')
        || ' for ' || r.full_name || ' (' || b.period_label || ') is past its due date.',
      'warning',
      jsonb_build_object('kind', 'fee_overdue', 'invoice_id', b.id)
    from bumped b
    join riders r on r.id = b.rider_id
    join guardians g on g.rider_id = b.rider_id
    returning 1
  )
  select count(*) into v_count from bumped;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- View: an invoice with the human context the app needs to render it.
-- ---------------------------------------------------------------------------

create view v_my_invoices
with (security_invoker = true)
as
select
  i.id,
  i.org_id,
  i.rider_id,
  r.full_name    as rider_name,
  r.class_section,
  i.period_label,
  i.amount_paise,
  i.currency,
  i.due_date,
  i.status,
  i.paid_at,
  p.provider_payment_id as receipt_no
from fee_invoices i
join riders r on r.id = i.rider_id
left join lateral (
  select provider_payment_id
  from payments
  where invoice_id = i.id and status = 'captured'
  order by captured_at desc
  limit 1
) p on true;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table fee_invoices enable row level security;
alter table payments     enable row level security;

-- A parent sees their own children's bills. A college student sees their own.
create policy fee_invoices_read on fee_invoices
  for select to authenticated
  using (
    rider_id in (select app.visible_rider_ids())
    or (app.is_admin() and org_id = app.current_org_id())
  );

create policy fee_invoices_admin_write on fee_invoices
  for all to authenticated
  using (app.is_admin() and org_id = app.current_org_id())
  with check (app.is_admin() and org_id = app.current_org_id());

-- Read your own receipts. Note there is deliberately NO insert or update policy
-- for `authenticated`: payments are written only by the edge function using the
-- service_role key, which bypasses RLS. A client that could INSERT here could
-- mark its own fees paid.
create policy payments_read_own on payments
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (app.is_admin() and org_id = app.current_org_id())
  );

-- ---------------------------------------------------------------------------
-- May this user pay this bill?
--
-- The create-payment-order edge function holds the service_role key and so
-- bypasses RLS completely. This function re-states, in one place, exactly what
-- the `fee_invoices_read` policy would have allowed -- so the answer cannot
-- drift between the two paths. Without it the function would have to re-derive
-- the guardian join by hand, and the day someone changed the policy, the two
-- would silently disagree.
-- ---------------------------------------------------------------------------

create or replace function public.can_pay_invoice(p_profile_id uuid, p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, app
as $$
  select exists (
    select 1
    from fee_invoices i
    where i.id = p_invoice_id
      and i.status <> 'cancelled'
      and (
        exists (select 1 from riders r    where r.id = i.rider_id and r.profile_id = p_profile_id)
        or exists (select 1 from guardians g where g.rider_id = i.rider_id and g.profile_id = p_profile_id)
      )
  );
$$;

grant select on v_my_invoices to authenticated;
grant execute on function public.mark_overdue_invoices() to service_role;
grant execute on function public.can_pay_invoice(uuid, uuid) to service_role;

alter publication supabase_realtime add table fee_invoices;
alter table fee_invoices replica identity full;
