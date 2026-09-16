import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { auth as authApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing } from '../theme';

// Step one of the real backend's signup flow: create the account, then wait
// for an emailed code (see VerifyScreen). There's no session yet at this
// point - the account exists but isn't verified, so nothing to log in with.
export function SignupScreen({
  onSignedUp,
  onBackToLogin,
}: {
  onSignedUp: (email: string, devCode: string | null) => void;
  onBackToLogin: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !email.trim() || password.length < 6) {
      Alert.alert('Missing info', 'Enter your name, email and a password of at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.signup(name.trim(), email.trim(), password);
      onSignedUp(email.trim(), res.devCode ?? null);
    } catch (err) {
      Alert.alert('Could not sign up', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Uusiki</Text>
      <Text style={styles.sub}>Create an account</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} autoCapitalize="words" />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
      </View>

      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.buttonLabel}>Sign up</Text>}
      </Pressable>

      <Text style={styles.link} onPress={onBackToLogin}>
        Already have an account? Sign in
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.xl, justifyContent: 'center' },
  brand: { fontFamily: fonts.heading, fontSize: 36, color: colors.text },
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
  button: { backgroundColor: colors.accent, paddingVertical: 15, alignItems: 'center', marginTop: spacing.sm },
  buttonLabel: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.bg, letterSpacing: 0.3 },
  link: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.accent, textAlign: 'center', marginTop: spacing.xl },
});
