-- ============================================================================
-- Reset the demo back to "start of day".
--
-- Run this between simulation runs. Paste into the Supabase SQL Editor:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- It clears ONLY the transactional rows a trip produces. Every piece of
-- reference data the seed created -- the school, the bus, the stops, the route,
-- the 5 riders, their guardians, the fee invoices and all 6 logins -- is left
-- exactly as it is. You do NOT need to re-run seed.sql afterwards.
--
-- What it deletes:
--   bus_locations     the raw GPS trail
--   bus_live          the moving dot
--   trip_stop_events  which stops the bus reached
--   trip_alerts       the "arriving soon" / "delayed" dedupe ledger
--   ride_events       who boarded / was dropped
--   incidents         SOS, accidents, breakdowns, diversions
--   notifications     everything the above sent to people's phones
--
-- And it puts today's two trips back to 'scheduled', so the driver can press
-- Start again.
-- ============================================================================

begin;

delete from bus_locations;
delete from bus_live;
delete from trip_stop_events;
delete from trip_alerts;
delete from ride_events;
delete from incidents;
delete from notifications;

update trips
   set status = 'scheduled',
       started_at = null,
       ended_at = null;

-- Also un-pay the fees, so the payment flow is demoable again.
-- (April 2026 stays paid -- it is meant to show what a settled invoice looks
--  like. Only the ones the seed left outstanding are reset.)
delete from payments;

update fee_invoices
   set status = case when due_date < current_date then 'overdue' else 'pending' end,
       paid_at = null
 where period_label <> 'April 2026';

commit;

-- What you should see afterwards.
select
  (select count(*) from trips where status = 'scheduled') as trips_ready,
  (select count(*) from bus_locations)                    as gps_rows,
  (select count(*) from notifications)                    as notifications,
  (select count(*) from riders)                           as riders_kept,
  (select count(*) from profiles)                         as logins_kept,
  (select count(*) from fee_invoices where status <> 'paid') as invoices_payable;
-- expect: 2 | 0 | 0 | 5 | 6 | 4
