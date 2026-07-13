import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Body, Button, Screen, Title } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { radius, spacing, useTheme } from '@/theme';

export default function SignIn() {
  const t = useTheme();
  const { signIn, unprovisioned, signOut } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const { error: err } = await signIn(email, password);
    if (err) setError(err);
    setBusy(false);
  }

  // Authenticated, but their email was never on a roster. RLS means they can see
  // nothing at all, so say so plainly instead of showing an empty app.
  if (unprovisioned) {
    return (
      <Screen>
        <View style={styles.center}>
          <Title sub="Your login works, but this email is not on any school's transport roster.">
            Not registered yet
          </Title>
          <Body muted>
            Ask your school office to add you. They will need the exact email address you just
            used.
          </Body>
          <View style={{ height: spacing.lg }} />
          <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.center}>
        <View style={{ gap: spacing.xs, marginBottom: spacing.xl }}>
          <Text style={{ fontSize: 34, fontWeight: '800', color: t.brand, letterSpacing: -1 }}>
            BusTracker
          </Text>
          <Text style={{ fontSize: 16, color: t.textMuted }}>
            Live bus tracking for students, faculty and parents.
          </Text>
        </View>

        <View style={{ gap: spacing.md }}>
          <TextInput
            style={[styles.input, { borderColor: t.border, color: t.text, backgroundColor: t.surface }]}
            placeholder="Email"
            placeholderTextColor={t.textMuted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            inputMode="email"
          />
          <TextInput
            style={[styles.input, { borderColor: t.border, color: t.text, backgroundColor: t.surface }]}
            placeholder="Password"
            placeholderTextColor={t.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            onSubmitEditing={() => void submit()}
          />

          {error ? (
            <View style={[styles.error, { backgroundColor: t.dangerSoft }]}>
              <Text style={{ color: t.danger, fontSize: 14 }}>{error}</Text>
            </View>
          ) : null}

          <Button
            label="Sign in"
            onPress={() => void submit()}
            loading={busy}
            disabled={!email || !password}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', gap: spacing.md },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    fontSize: 16,
    minHeight: 52,
  },
  error: { padding: spacing.md, borderRadius: radius.sm },
});
