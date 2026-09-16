import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { colors, fonts, spacing } from '../theme';
import { useAuth } from '../state/AuthContext';

// The ParentOS shell landing screen. This is where the "← ParentOS" link in
// the Uusiki tabs brings people back to — the other half of the two-shell
// concept from the design canvas (Uusiki marketplace vs. the ParentOS home).
export function HomeScreen() {
  const { user, logout } = useAuth();
  const nav = useNavigation<any>();

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>ParentOS</Text>
      <Text style={styles.greeting}>Hi {user?.name?.split(' ')[0] ?? 'there'} 👋</Text>

      <Pressable style={styles.card} onPress={() => nav.navigate('UusikiShell')}>
        <Text style={styles.cardKicker}>Marketplace</Text>
        <Text style={styles.cardTitle}>Uusiki</Text>
        <Text style={styles.cardBody}>Buy and sell second-hand kids gear — browse, message sellers, and track orders.</Text>
        <Text style={styles.cardLink}>Open Uusiki →</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.cardKicker}>Account</Text>
        <Text style={styles.cardTitle}>Payouts &amp; verification</Text>
        <Text style={styles.cardBody}>Check your email verification and set up Stripe so you can get paid for sales.</Text>
        <Text style={styles.cardLink} onPress={() => nav.navigate('Account')}>
          Manage account →
        </Text>
      </View>

      <Text style={styles.logout} onPress={logout}>
        Sign out
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg, paddingTop: spacing.xxl },
  brand: { fontFamily: fonts.heading, fontSize: 30, color: colors.text },
  greeting: { fontFamily: fonts.body, fontSize: 14, color: colors.text, opacity: 0.7, marginTop: 4, marginBottom: spacing.xl },
  card: { borderWidth: 2, borderColor: colors.text, padding: spacing.lg, marginBottom: spacing.lg, backgroundColor: colors.surface },
  cardKicker: { fontFamily: fonts.bodyMedium, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: colors.text, opacity: 0.5 },
  cardTitle: { fontFamily: fonts.headingBold, fontSize: 20, color: colors.text, marginTop: 4 },
  cardBody: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.7, marginTop: 8, lineHeight: 18 },
  cardLink: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.accent, marginTop: spacing.md },
  logout: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.5, textAlign: 'center', marginTop: 'auto' },
});
