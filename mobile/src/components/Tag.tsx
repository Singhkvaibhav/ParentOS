import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'accent' | 'neutral' }) {
  return (
    <View style={[styles.tag, tone === 'accent' ? styles.accent : styles.neutral]}>
      <Text style={[styles.label, tone === 'accent' && { color: colors.accentDark }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 8 },
  accent: { backgroundColor: colors.accentLight },
  neutral: { backgroundColor: colors.neutral200 },
  label: { fontFamily: fonts.bodyMedium, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.text },
});
