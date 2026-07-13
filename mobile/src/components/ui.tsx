import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { radius, spacing, useTheme, type Theme } from '@/theme';

export function Screen({
  children,
  scroll = false,
  padded = true,
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
}) {
  const t = useTheme();
  const inner = { padding: padded ? spacing.lg : 0, gap: spacing.md };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[inner, { paddingBottom: spacing.xxl }]}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, inner]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ fontSize: 26, fontWeight: '700', color: t.text, letterSpacing: -0.5 }}>
        {children}
      </Text>
      {sub ? <Text style={{ fontSize: 15, color: t.textMuted }}>{sub}</Text> : null}
    </View>
  );
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const t = useTheme();
  const s = useStyles(t);
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [s.card, style, pressed && { opacity: 0.75 }]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'live';
  disabled?: boolean;
  loading?: boolean;
}) {
  const t = useTheme();

  const bg: Record<string, string> = {
    primary: t.brand,
    secondary: t.surfaceAlt,
    danger: t.danger,
    live: t.liveDeep,
  };
  const fg: Record<string, string> = {
    primary: '#FFFFFF',
    secondary: t.text,
    danger: '#FFFFFF',
    live: '#FFFFFF',
  };

  const off = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        {
          backgroundColor: bg[variant],
          paddingVertical: spacing.lg,
          paddingHorizontal: spacing.xl,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 52,
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}>
      {loading ? (
        <ActivityIndicator color={fg[variant]} />
      ) : (
        <Text style={{ color: fg[variant], fontSize: 16, fontWeight: '600' }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Pill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'live' | 'good' | 'bad';
}) {
  const t = useTheme();
  const map = {
    neutral: { bg: t.surfaceAlt, fg: t.textMuted },
    live: { bg: t.liveSoft, fg: t.liveDeep },
    good: { bg: t.brandSoft, fg: t.brand },
    bad: { bg: t.dangerSoft, fg: t.danger },
  } as const;
  const c = map[tone];

  return (
    <View
      style={{
        backgroundColor: c.bg,
        paddingHorizontal: spacing.md,
        paddingVertical: 5,
        borderRadius: radius.pill,
        alignSelf: 'flex-start',
      }}>
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 }}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
        style,
      ]}>
      {children}
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        color: t.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
      }}>
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={{ fontSize: 15, color: muted ? t.textMuted : t.text }}>{children}</Text>;
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md }}>
      <ActivityIndicator color={t.brand} size="large" />
      {label ? <Text style={{ color: t.textMuted }}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm }}>
      <Text style={{ fontSize: 17, fontWeight: '600', color: t.text, textAlign: 'center' }}>
        {title}
      </Text>
      {hint ? (
        <Text style={{ fontSize: 14, color: t.textMuted, textAlign: 'center', lineHeight: 20 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function useStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      backgroundColor: t.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
  });
}
