import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polyline, PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import type { RouteStopView } from '@/hooks/useLiveRoute';
import type { ActiveTrip } from '@/lib/types';
import { radius, useTheme } from '@/theme';

type Props = {
  stops: RouteStopView[];
  trip: ActiveTrip | null;
  /** The stop belonging to the person looking at the map -- drawn larger. */
  highlightStopId?: string | null;
  followBus?: boolean;
};

export function BusMap({ stops, trip, highlightStopId, followBus = true }: Props) {
  const t = useTheme();
  const mapRef = useRef<MapView>(null);
  const hasBus = trip?.lat != null && trip?.lng != null;

  // Frame the whole route on first render, so the user is never dropped onto a
  // grey ocean while the map works out where it is.
  const initialRegion: Region | undefined = (() => {
    const pts = stops.filter((s) => s.lat != null && s.lng != null);
    if (pts.length === 0) return undefined;

    const lats = pts.map((s) => s.lat!);
    const lngs = pts.map((s) => s.lng!);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      // 40% padding so the end stops are not glued to the screen edge.
      latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.4),
      longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.4),
    };
  })();

  useEffect(() => {
    if (!followBus || !hasBus || !mapRef.current) return;

    // Pan, don't zoom: yanking the zoom on every fix makes the map unusable if
    // the rider is trying to look at something else.
    mapRef.current.animateCamera(
      { center: { latitude: trip!.lat!, longitude: trip!.lng! } },
      { duration: 800 },
    );
  }, [followBus, hasBus, trip?.lat, trip?.lng, trip]);

  const line = stops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => ({ latitude: s.lat!, longitude: s.lng! }));

  return (
    <View style={styles.wrap}>
      <MapView
        ref={mapRef}
        // Force Google on Android so the rendering matches the key we ship. On
        // iOS this is ignored and Apple Maps is used, which needs no key.
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}>
        {line.length > 1 ? (
          <Polyline coordinates={line} strokeColor={t.brand} strokeWidth={4} />
        ) : null}

        {stops.map((s) => {
          if (s.lat == null || s.lng == null) return null;
          const mine = s.id === highlightStopId;
          const done = !!s.arrived_at;

          return (
            <Marker
              key={s.id}
              coordinate={{ latitude: s.lat, longitude: s.lng }}
              title={s.name}
              description={
                done
                  ? `Bus passed at ${new Date(s.arrived_at!).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : (s.address ?? undefined)
              }
              anchor={{ x: 0.5, y: 0.5 }}>
              <View
                style={[
                  styles.stopDot,
                  {
                    backgroundColor: done ? t.brand : t.surface,
                    borderColor: mine ? t.liveDeep : t.brand,
                    width: mine ? 22 : 14,
                    height: mine ? 22 : 14,
                    borderWidth: mine ? 4 : 3,
                  },
                ]}
              />
            </Marker>
          );
        })}

        {hasBus ? (
          <>
            {/* A soft halo makes the bus findable at a glance among the stops. */}
            <Circle
              center={{ latitude: trip!.lat!, longitude: trip!.lng! }}
              radius={90}
              fillColor="rgba(245, 158, 11, 0.18)"
              strokeColor="rgba(245, 158, 11, 0.45)"
              strokeWidth={1}
            />
            <Marker
              coordinate={{ latitude: trip!.lat!, longitude: trip!.lng! }}
              anchor={{ x: 0.5, y: 0.5 }}
              // Point the bus the way it is actually travelling. flat=true keeps
              // it rotating with the map instead of standing up like a pin.
              rotation={trip!.heading ?? 0}
              flat
              title={trip!.bus_name}
              description={`Driver: ${trip!.driver_name}`}>
              <View style={[styles.bus, { backgroundColor: t.live, borderColor: t.liveDeep }]}>
                <Text style={styles.busGlyph}>▲</Text>
              </View>
            </Marker>
          </>
        ) : null}
      </MapView>

      {!hasBus ? (
        <View style={[styles.badge, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={{ color: t.textMuted, fontSize: 13, fontWeight: '600' }}>
            Bus is not running right now
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, borderRadius: radius.lg, overflow: 'hidden' },
  stopDot: { borderRadius: 999 },
  bus: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  busGlyph: { color: '#fff', fontSize: 15, fontWeight: '900', marginTop: -1 },
  badge: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
