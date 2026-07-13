import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  UserLocation,
  type CameraRef,
  type LngLat,
  type LngLatBounds,
} from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

import type { RouteStopView } from '@/hooks/useLiveRoute';
import type { ActiveTrip } from '@/lib/types';
import { radius, useTheme } from '@/theme';

/**
 * MapLibre + OpenFreeMap.
 *
 * No API key, no billing account, no rate limit. Google's Maps SDK is free for
 * mobile map loads, but it still refuses to hand you a working key until a card
 * is on file -- which is a bad trade for a school project. OpenFreeMap serves
 * OpenStreetMap vector tiles to anyone, so there is nothing to sign up for.
 *
 * OSM data is ODbL: attribution is a licence condition, not a nicety. That is
 * why `attribution` stays on below -- do not turn it off.
 */
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

type Props = {
  stops: RouteStopView[];
  trip: ActiveTrip | null;
  /** The stop belonging to the person looking at the map -- drawn larger. */
  highlightStopId?: string | null;
  followBus?: boolean;
};

export function BusMap({ stops, trip, highlightStopId, followBus = true }: Props) {
  const t = useTheme();
  const scheme = useColorScheme();
  const camera = useRef<CameraRef>(null);

  const hasBus = trip?.lat != null && trip?.lng != null;

  // MapLibre is [longitude, latitude] -- the opposite of the {latitude, longitude}
  // objects most RN map libraries use. Getting this backwards silently puts your
  // Bangalore bus in the Indian Ocean, so every conversion goes through here.
  const points = useMemo<{ id: string; lngLat: LngLat; stop: RouteStopView }[]>(
    () =>
      stops
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ id: s.id, lngLat: [s.lng!, s.lat!] as LngLat, stop: s })),
    [stops],
  );

  const bounds = useMemo<LngLatBounds | null>(() => {
    if (points.length === 0) return null;

    const lngs = points.map((p) => p.lngLat[0]);
    const lats = points.map((p) => p.lngLat[1]);

    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }, [points]);

  // The route drawn as a line. Rebuilt only when the stops change, not on every
  // GPS fix -- the route is static for the whole trip.
  const routeLine = useMemo(
    () => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: points.map((p) => p.lngLat),
      },
    }),
    [points],
  );

  // Frame the whole route once, so the user never lands on a grey void while the
  // map works out where it is.
  useEffect(() => {
    if (!bounds || !camera.current) return;
    camera.current.fitBounds(bounds, {
      padding: { top: 60, right: 60, bottom: 60, left: 60 },
      duration: 0,
    });
  }, [bounds]);

  useEffect(() => {
    if (!followBus || !hasBus || !camera.current) return;

    // Pan, don't zoom. Yanking the zoom on every fix makes the map unusable if
    // the rider is trying to look at something else.
    camera.current.easeTo({ center: [trip!.lng!, trip!.lat!], duration: 800 });
  }, [followBus, hasBus, trip?.lat, trip?.lng, trip]);

  return (
    <View style={styles.wrap}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={scheme === 'dark' ? STYLE_DARK : STYLE_LIGHT}
        logo={false}
        // OSM's licence requires this. It is also just correct.
        attribution
        attributionPosition={{ bottom: 8, right: 8 }}
        compass={false}>
        <Camera ref={camera} />

        <UserLocation />

        {points.length > 1 ? (
          <GeoJSONSource id="route" data={routeLine}>
            <Layer
              id="route-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': t.brand, 'line-width': 4, 'line-opacity': 0.85 }}
            />
          </GeoJSONSource>
        ) : null}

        {points.map(({ id, lngLat, stop }) => {
          const mine = id === highlightStopId;
          const done = !!stop.arrived_at;

          return (
            <Marker key={id} lngLat={lngLat} anchor="center">
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
          <Marker lngLat={[trip!.lng!, trip!.lat!]} anchor="center">
            <View style={styles.busWrap}>
              {/* A soft halo makes the bus findable at a glance among the stops. */}
              <View style={styles.halo} />
              <View
                style={[
                  styles.bus,
                  {
                    backgroundColor: t.live,
                    borderColor: t.liveDeep,
                    // Point the bus the way it is actually travelling.
                    transform: [{ rotate: `${trip!.heading ?? 0}deg` }],
                  },
                ]}>
                <Text style={styles.busGlyph}>▲</Text>
              </View>
            </View>
          </Marker>
        ) : null}
      </Map>

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
  busWrap: { alignItems: 'center', justifyContent: 'center', width: 64, height: 64 },
  halo: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
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
