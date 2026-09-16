import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Chip } from '../components/Chip';
import { listings as listingsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing, categoryLabel, AREA_DATA } from '../theme';
import { useMarketplaceConfig } from '../hooks/useMarketplaceConfig';

const CITIES = Object.keys(AREA_DATA);

export function SellScreen() {
  const nav = useNavigation<any>();
  const { config } = useMarketplaceConfig();
  const [title, setTitle] = useState('');
  const [sizeOrAge, setSizeOrAge] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [condition, setCondition] = useState<string | null>(null);
  const [city, setCity] = useState(CITIES[0]);
  const [area, setArea] = useState(AREA_DATA[CITIES[0]][0]);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const categories = config?.categories ?? [];
  const conditions = config?.conditions ?? [];
  const subcategories = category ? config?.subcategories?.[category] ?? [] : [];

  const selectCategory = (c: string) => {
    setCategory(c);
    setSubcategory(null); // a previous category's subcategory may not exist under the new one
  };

  const reset = () => {
    setTitle('');
    setSizeOrAge('');
    setDescription('');
    setPrice('');
  };

  const submit = async () => {
    if (!title.trim() || !category || !condition || !price.trim()) {
      Alert.alert('Missing info', 'Fill in title, category, condition and price.');
      return;
    }
    const priceCents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      Alert.alert('Invalid price', 'Enter a price like 15 or 15.50.');
      return;
    }
    setBusy(true);
    try {
      await listingsApi.create({
        title: title.trim(),
        category,
        subcategory,
        condition,
        priceCents,
        sizeOrAge: sizeOrAge.trim(),
        city,
        area,
        description: description.trim(),
      });
      Alert.alert('Listed!', 'Your item is live in Browse.', [
        { text: 'OK', onPress: () => { reset(); nav.navigate('Browse'); } },
      ]);
    } catch (err) {
      Alert.alert('Could not list item', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sell an item</Text>

      <Field label="Title">
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Winter overalls, size 86" placeholderTextColor={colors.neutral700} />
      </Field>
      <Field label="Size / age">
        <TextInput style={styles.input} value={sizeOrAge} onChangeText={setSizeOrAge} placeholder="86 cm (12-18 mo)" placeholderTextColor={colors.neutral700} />
      </Field>
      <Field label="Description">
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Condition details, smoke-free home, etc."
          placeholderTextColor={colors.neutral700}
          multiline
        />
      </Field>

      <Field label="Category">
        <View style={styles.chipRow}>
          {categories.map((c) => (
            <Chip key={c} label={categoryLabel(c)} active={c === category} onPress={() => selectCategory(c)} />
          ))}
        </View>
      </Field>

      {subcategories.length > 0 && (
        <Field label="Subcategory (optional)">
          <View style={styles.chipRow}>
            {subcategories.map((s) => (
              <Chip key={s} label={s} active={s === subcategory} onPress={() => setSubcategory(s === subcategory ? null : s)} />
            ))}
          </View>
        </Field>
      )}

      <Field label="Condition">
        <View style={styles.chipRow}>
          {conditions.map((c) => (
            <Chip key={c} label={c} active={c === condition} onPress={() => setCondition(c)} />
          ))}
        </View>
      </Field>

      <Field label="City">
        <View style={styles.chipRow}>
          {CITIES.map((c) => (
            <Chip key={c} label={c} active={c === city} onPress={() => { setCity(c); setArea(AREA_DATA[c][0]); }} />
          ))}
        </View>
      </Field>
      <Field label="Area">
        <View style={styles.chipRow}>
          {AREA_DATA[city].map((a) => (
            <Chip key={a} label={a} active={a === area} onPress={() => setArea(a)} />
          ))}
        </View>
      </Field>

      <Field label="Price (€)">
        <TextInput style={styles.input} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="15" placeholderTextColor={colors.neutral700} />
      </Field>

      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        <Text style={styles.buttonLabel}>{busy ? 'Listing…' : 'List item'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  title: { fontFamily: fonts.heading, fontSize: 26, color: colors.text, marginBottom: spacing.lg },
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
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: colors.accent, paddingVertical: 15, alignItems: 'center', marginTop: spacing.md },
  buttonLabel: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.bg, letterSpacing: 0.3 },
});
