import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { auth as authApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing } from '../theme';
import { useAuth } from '../state/AuthContext';

// Step two: the code emailed by signup (or resend-code). Success returns a
// full session, same shape as login - handed straight to applySession so
// this flow ends signed in, not bounced back to a login screen.
export function VerifyScreen({ email, devCode, onBackToLogin }: { email: string; devCode: string | null; onBackToLogin: () => void }) {
  const { applySession } = useAuth();
  const [code, setCode] = useState(devCode ?? '');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const session = await authApi.verify(email, code.trim());
      await applySession(session);
    } catch (err) {
      Alert.alert('Could not verify', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      const res = await authApi.resendCode(email);
      if (res.devCode) setCode(res.devCode);
      Alert.alert('Code sent', res.message);
    } catch (err) {
      Alert.alert('Could not resend', err instanceof ApiError ? err.message : String(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Check your email</Text>
      <Text style={styles.sub}>Enter the code we sent to {email}</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Verification code</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
        />
      </View>

      {devCode && <Text style={styles.hint}>Dev mode — code prefilled: {devCode}</Text>}

      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.buttonLabel}>Verify</Text>}
      </Pressable>

      <Text style={styles.link} onPress={resend}>
        {resending ? 'Sending…' : "Didn't get a code? Resend"}
      </Text>
      <Text style={styles.link} onPress={onBackToLogin}>
        ← Back to sign in
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.xl, justifyContent: 'center' },
  brand: { fontFamily: fonts.heading, fontSize: 30, color: colors.text },
  sub: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.6, marginBottom: spacing.xxl },
  field: { marginBottom: spacing.lg },
  label: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.text, opacity: 0.7, marginBottom: 6 },
  input: {
    borderWidth: 2,
    borderColor: colors.text,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  hint: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.5, marginBottom: spacing.md },
  button: { backgroundColor: colors.accent, paddingVertical: 15, alignItems: 'center', marginTop: spacing.sm },
  buttonLabel: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.bg, letterSpacing: 0.3 },
  link: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.accent, textAlign: 'center', marginTop: spacing.lg },
});
