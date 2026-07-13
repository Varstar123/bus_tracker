import * as Location from 'expo-location';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { radius, spacing, useTheme } from '@/theme';

/**
 * The passenger panic button (deck p.13).
 *
 * Two deliberate frictions:
 *
 *   1. It always confirms. A false SOS pulls the school office away from a real
 *      one, so a pocket-press must not be able to fire it.
 *   2. It attaches a GPS fix, but never *waits* on one. A child in trouble does
 *      not have ten seconds for a satellite lock -- so we take whatever position
 *      is already cached and send immediately. A late alert with a perfect
 *      location is worth less than an instant one with an approximate location.
 */
export function SosButton() {
  const t = useTheme();
  const [sending, setSending] = useState(false);

  async function fire() {
    setSending(true);
    try {
      let lat: number | null = null;
      let lng: number | null = null;

      try {
        // Last known first -- it returns instantly. Only ask for a fresh fix if
        // the device has nothing cached at all.
        const cached = await Location.getLastKnownPositionAsync();
        const pos =
          cached ??
          (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      } catch {
        // No location permission, or GPS is off. Send the alert regardless --
        // the school still needs to know, and they know the route.
      }

      const { error } = await supabase.rpc('raise_sos', {
        p_lat: lat,
        p_lng: lng,
        p_note: null,
      });

      if (error) throw new Error(error.message);

      Alert.alert(
        'Alert sent',
        'The school office, your parents and the driver have been notified. Stay where you are if it is safe to do so.',
      );
    } catch (e) {
      Alert.alert(
        'Could not send alert',
        `${e instanceof Error ? e.message : 'Unknown error'}\n\nIf this is an emergency, call your school or the police directly.`,
      );
    } finally {
      setSending(false);
    }
  }

  function confirm() {
    Alert.alert(
      'Send emergency alert?',
      'This immediately notifies your school, your parents and the bus driver.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send SOS', style: 'destructive', onPress: () => void fire() },
      ],
    );
  }

  return (
    <Pressable
      onPress={confirm}
      disabled={sending}
      accessibilityRole="button"
      accessibilityLabel="Send emergency SOS alert"
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: t.danger, opacity: sending ? 0.6 : pressed ? 0.85 : 1 },
      ]}>
      <View style={styles.inner}>
        <Text style={styles.glyph}>!</Text>
        <View>
          <Text style={styles.title}>{sending ? 'Sending…' : 'Emergency SOS'}</Text>
          <Text style={styles.sub}>Alerts school, parents & driver</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    minHeight: 64,
    justifyContent: 'center',
  },
  inner: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  glyph: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#fff',
    textAlign: 'center',
    lineHeight: 29,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  sub: { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 1 },
});
