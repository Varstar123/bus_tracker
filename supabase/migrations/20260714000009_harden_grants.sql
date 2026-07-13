-- ============================================================================
-- BusTracker :: 0009 :: Lock down function execution
--
-- Postgres grants EXECUTE to PUBLIC on every new function by default. For the
-- RPCs the app calls that is fine -- each one re-checks auth.uid() itself. But
-- two functions here are meant only for the service_role, and left as-is any
-- signed-in parent could call them:
--
--   mark_overdue_invoices()  -- would let anyone re-run the billing sweep
--   can_pay_invoice()        -- would let anyone probe which invoices exist
--
-- Note this is a *targeted* revoke, not `revoke ... on all functions in schema
-- public`. A blanket revoke would also strip EXECUTE from every PostGIS function
-- if the extension happens to be installed into `public`, and the whole app
-- would stop being able to read a map.
-- ============================================================================

revoke execute on function public.mark_overdue_invoices()          from public;
revoke execute on function public.can_pay_invoice(uuid, uuid)      from public;

-- anon = a visitor holding only the publishable key, with no session at all.
-- Nothing in this app is usable without a profile, so nothing is granted here.
revoke execute on function public.ingest_location(uuid, double precision, double precision, real, real, real, timestamptz) from anon;
revoke execute on function public.ingest_locations(uuid, jsonb)    from anon;
revoke execute on function public.start_trip(uuid)                 from anon;
revoke execute on function public.end_trip(uuid)                   from anon;
revoke execute on function public.report_incident(uuid, incident_kind, text, double precision, double precision) from anon;
revoke execute on function public.raise_sos(double precision, double precision, text) from anon;
revoke execute on function public.acknowledge_incident(uuid)       from anon;
revoke execute on function public.resolve_incident(uuid)           from anon;
