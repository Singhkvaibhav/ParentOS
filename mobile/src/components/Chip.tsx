import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, fonts } from '../theme';

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 2,
    borderColor: colors.text,
    paddingVertical: 7,
    paddingHorizontal: 13,
    marginRight: 8,
  },
  chipActive: { backgroundColor: colors.text },
  label: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.text },
  labelActive: { color: colors.bg },
});
