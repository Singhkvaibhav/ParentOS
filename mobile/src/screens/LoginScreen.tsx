import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../state/AuthContext';
import { colors, fonts, spacing } from '../theme';

export function LoginScreen({ onCreateAccount }: { onCreateAccount: () => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo1234');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      Alert.alert('Could not sign in', err.code
        ? err.message
        : `${err.message} — is the backend running and EXPO_PUBLIC_API_BASE_URL set correctly?`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Uusiki</Text>
      <Text style={styles.sub}>Part of ParentOS</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
      </View>

      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.buttonLabel}>Sign in</Text>}
      </Pressable>

      <Text style={styles.link} onPress={onCreateAccount}>
        New here? Create an account
      </Text>

      <Text style={styles.hint}>Seeded account: demo@example.com / demo1234</Text>
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
  hint: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.5, marginTop: spacing.md, textAlign: 'center', lineHeight: 16 },
});
