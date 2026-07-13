/**
 * Hand-written to match supabase/migrations. Once your project is linked, this
 * file should be *generated* instead, so the types can never drift from the
 * schema:
 *
 *   npx supabase gen types typescript --linked > src/lib/types.ts
 *
 * Only the tables, views and RPCs the app actually touches are modelled here.
 */

export type UserRole = 'admin' | 'driver' | 'student' | 'faculty' | 'parent';
export type RiderKind = 'school_student' | 'college_student' | 'faculty';
export type TripDirection = 'inbound' | 'outbound';
export type TripStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';
export type RideEventType =
  | 'boarded'
  | 'alighted'
  | 'absent'
  | 'arrived_campus'
  | 'arrived_stop';
export type EventSource = 'driver' | 'geofence' | 'scan' | 'admin';

export type Profile = {
  id: string;
  org_id: string;
  role: UserRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  created_at: string;
};

export type Stop = {
  id: string;
  org_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number;
  is_campus: boolean;
};

export type Trip = {
  id: string;
  org_id: string;
  route_id: string;
  bus_id: string;
  driver_id: string;
  direction: TripDirection;
  service_date: string;
  status: TripStatus;
  started_at: string | null;
  ended_at: string | null;
};

export type RideEvent = {
  id: string;
  org_id: string;
  rider_id: string;
  trip_id: string | null;
  stop_id: string | null;
  event_type: RideEventType;
  source: EventSource;
  occurred_at: string;
  recorded_by: string | null;
  note: string | null;
};

export type Severity = 'info' | 'warning' | 'critical';

export type AppNotification = {
  id: string;
  profile_id: string;
  title: string;
  body: string;
  severity: Severity;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type IncidentKind = 'sos' | 'accident' | 'breakdown' | 'route_change';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export type Incident = {
  id: string;
  org_id: string;
  trip_id: string | null;
  route_id: string | null;
  kind: IncidentKind;
  status: IncidentStatus;
  reported_by: string;
  rider_id: string | null;
  lat: number | null;
  lng: number | null;
  note: string | null;
  created_at: string;
};

export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'cancelled';

/** view: v_my_invoices */
export type Invoice = {
  id: string;
  org_id: string;
  rider_id: string;
  rider_name: string;
  class_section: string | null;
  period_label: string;
  amount_paise: number;
  currency: string;
  due_date: string;
  status: InvoiceStatus;
  paid_at: string | null;
  receipt_no: string | null;
};

export type RouteStop = {
  route_id: string;
  stop_id: string;
  seq: number;
  offset_minutes: number;
};

export type Route = {
  id: string;
  org_id: string;
  name: string;
  code: string;
  bus_id: string | null;
  driver_id: string | null;
  is_active: boolean;
};

export type Bus = {
  id: string;
  org_id: string;
  registration_no: string;
  display_name: string;
  capacity: number;
  is_active: boolean;
};

export type TripStopEvent = {
  id: string;
  trip_id: string;
  stop_id: string;
  seq: number;
  arrived_at: string;
};

export type BusLive = {
  bus_id: string;
  org_id: string;
  trip_id: string | null;
  route_id: string | null;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  speed_kmh: number | null;
  next_stop_id: string | null;
  eta_seconds: number | null;
  recorded_at: string;
};

/** view: v_riders_expanded */
export type RiderExpanded = {
  id: string;
  org_id: string;
  profile_id: string | null;
  full_name: string;
  kind: RiderKind;
  class_section: string | null;
  is_active: boolean;
  route_id: string | null;
  route_name: string | null;
  route_code: string | null;
  bus_id: string | null;
  bus_name: string | null;
  registration_no: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  pickup_stop_id: string | null;
  pickup_stop_name: string | null;
  drop_stop_id: string | null;
  drop_stop_name: string | null;
};

/** view: v_active_trips */
export type ActiveTrip = {
  trip_id: string;
  org_id: string;
  route_id: string;
  direction: TripDirection;
  status: TripStatus;
  started_at: string | null;
  service_date: string;
  route_name: string;
  route_code: string;
  bus_id: string;
  bus_name: string;
  driver_name: string;
  driver_phone: string | null;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  speed_kmh: number | null;
  eta_seconds: number | null;
  recorded_at: string | null;
  next_stop_id: string | null;
  next_stop_name: string | null;
};

/** view: v_trip_manifest */
export type ManifestRow = {
  trip_id: string;
  rider_id: string;
  full_name: string;
  class_section: string | null;
  seq: number;
  stop_id: string;
  stop_name: string;
  stop_arrived_at: string | null;
  marked_as: 'boarded' | 'absent' | null;
  marked_at: string | null;
};

export type IngestResult = {
  ok: boolean;
  stops_reached?: string[];
  next_stop_id?: string | null;
  eta_seconds?: number | null;
  applied?: number;
};

/** One buffered GPS fix, as sent to ingest_locations. */
export type LocationFix = {
  lat: number;
  lng: number;
  heading: number | null;
  speed_kmh: number | null;
  accuracy_m: number | null;
  recorded_at: string;
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type View<Row> = { Row: Row; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile>;
      stops: Table<Stop>;
      trips: Table<Trip>;
      bus_live: Table<BusLive>;
      ride_events: Table<
        RideEvent,
        {
          org_id: string;
          rider_id: string;
          trip_id: string;
          stop_id: string | null;
          event_type: RideEventType;
          source: EventSource;
          recorded_by: string;
          occurred_at?: string;
          note?: string | null;
        }
      >;
      notifications: Table<AppNotification>;
      route_stops: Table<RouteStop>;
      routes: Table<Route>;
      buses: Table<Bus>;
      trip_stop_events: Table<TripStopEvent>;
      incidents: Table<Incident>;
      device_tokens: Table<
        {
          id: string;
          profile_id: string;
          token: string;
          platform: 'ios' | 'android';
          created_at: string;
          last_seen_at: string;
        },
        { profile_id: string; token: string; platform: 'ios' | 'android'; last_seen_at?: string }
      >;
    };
    Views: {
      v_riders_expanded: View<RiderExpanded>;
      v_active_trips: View<ActiveTrip>;
      v_trip_manifest: View<ManifestRow>;
      v_my_invoices: View<Invoice>;
    };
    Functions: {
      ingest_location: {
        Args: {
          p_trip_id: string;
          p_lat: number;
          p_lng: number;
          p_heading?: number | null;
          p_speed_kmh?: number | null;
          p_accuracy_m?: number | null;
          p_recorded_at?: string;
        };
        Returns: IngestResult;
      };
      ingest_locations: {
        Args: { p_trip_id: string; p_fixes: LocationFix[] };
        Returns: IngestResult;
      };
      start_trip: { Args: { p_trip_id: string }; Returns: Trip };
      end_trip: { Args: { p_trip_id: string }; Returns: Trip };
      report_incident: {
        Args: {
          p_trip_id: string;
          p_kind: IncidentKind;
          p_note?: string | null;
          p_lat?: number | null;
          p_lng?: number | null;
        };
        Returns: Incident;
      };
      raise_sos: {
        Args: { p_lat?: number | null; p_lng?: number | null; p_note?: string | null };
        Returns: Incident;
      };
      acknowledge_incident: { Args: { p_incident_id: string }; Returns: Incident };
      resolve_incident: { Args: { p_incident_id: string }; Returns: Incident };
    };
    Enums: {
      user_role: UserRole;
      rider_type: RiderKind;
      trip_direction: TripDirection;
      trip_status: TripStatus;
      ride_event_type: RideEventType;
      event_source: EventSource;
    };
    CompositeTypes: Record<string, never>;
  };
};
