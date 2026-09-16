import { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, Pressable, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import { account as accountApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Tag } from '../components/Tag';
import { colors, fonts, spacing } from '../theme';
import type { ConnectStatus } from '../api/types';
import { useAuth } from '../state/AuthContext';

// No more fabricated "linked apps" / "shared facts" panels - those backed
// endpoints (GET /account/linked-apps, GET /account/shared) that only ever
// existed on the bespoke backend this app used to point at. What's real
// here: the account's email-verification state, and Stripe Connect payout
// status/onboarding, both served by the actual backend.
export function AccountScreen() {
  const nav = useNavigation<any>();
  const { user, logout } = useAuth();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await accountApi.connectStatus());
    } catch (err) {
      Alert.alert('Could not load account', err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const connectPayouts = async () => {
    setBusy(true);
    try {
      const { onboardingUrl } = await accountApi.connectOnboard();
      await WebBrowser.openBrowserAsync(onboardingUrl);
      // Stripe's onboarding flow finishes in the browser, not in-app - reload
      // status when the user comes back rather than assuming it's done.
      await load();
    } catch (err) {
      Alert.alert('Could not start payouts setup', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Account</Text>
        <Text style={styles.back} onPress={() => nav.navigate('Home')}>
          ← Home
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.name}>{user?.name}</Text>
        <Text style={styles.email}>{user?.email}</Text>
        <View style={{ marginTop: 8 }}>
          <Tag label={user?.verified ? 'Email verified' : 'Not verified'} tone={user?.verified ? 'accent' : 'neutral'} />
        </View>
      </View>

      <Text style={styles.sectionTitle}>Payouts</Text>
      <View style={styles.section}>
        {loading ? (
          <Text style={styles.rowSub}>Loading…</Text>
        ) : status?.payoutsEnabled ? (
          <>
            <Tag label="Payouts enabled" tone="accent" />
            <Text style={[styles.rowSub, { marginTop: 8 }]}>You're set up to receive money from sales.</Text>
          </>
        ) : (
          <>
            <Tag label={status?.connected ? 'Setup incomplete' : 'Not connected'} tone="neutral" />
            <Text style={[styles.rowSub, { marginTop: 8 }]}>
              Finish setting up Stripe to get paid when something you list sells.
            </Text>
            <Pressable style={styles.button} onPress={connectPayouts} disabled={busy}>
              <Text style={styles.buttonLabel}>{busy ? 'Opening…' : 'Set up payouts'}</Text>
            </Pressable>
          </>
        )}
      </View>

      <Text style={styles.logout} onPress={logout}>
        Sign out
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingTop: spacing.xxl, paddingBottom: spacing.xl },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  title: { fontFamily: fonts.heading, fontSize: 26, color: colors.text },
  back: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.accent },
  section: { borderWidth: 2, borderColor: colors.text, padding: spacing.lg, marginBottom: spacing.xl, backgroundColor: colors.surface },
  name: { fontFamily: fonts.headingBold, fontSize: 16, color: colors.text },
  email: { fontFamily: fonts.body, fontSize: 12, color: colors.text, opacity: 0.6, marginTop: 2 },
  button: { backgroundColor: colors.accent, paddingVertical: 12, alignItems: 'center', marginTop: spacing.md },
  buttonLabel: { fontFamily: fonts.headingBold, fontSize: 13, color: colors.bg },
  sectionTitle: { fontFamily: fonts.bodyMedium, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: colors.text, opacity: 0.5, marginBottom: spacing.sm },
  rowSub: { fontFamily: fonts.body, fontSize: 12, color: colors.text, opacity: 0.7 },
  logout: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.5, textAlign: 'center', marginTop: spacing.xl },
});
