import { useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { ListingCard } from '../components/ListingCard';
import { listings as listingsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing } from '../theme';
import type { Listing } from '../api/types';
import { useListingActions } from './FeedScreen';

// The real backend searches listing text (title/description), not price -
// there's no maxPrice filter on GET /api/v1/listings (see listingsService.list).
// A price ceiling is a reasonable thing to want, but it doesn't exist
// server-side yet, so this searches for what the API actually supports
// rather than faking a filter that would silently do nothing.
export function SearchScreen() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Listing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const onPressListing = useListingActions();

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await listingsApi.feed({ q: q.trim() });
      setResults(res.listings);
    } catch (err) {
      Alert.alert('Search failed', err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Search</Text>
      <Text style={styles.label}>What are you looking for?</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={q}
          onChangeText={setQ}
          placeholder="e.g. stroller"
          placeholderTextColor={colors.neutral700}
          onSubmitEditing={search}
          returnKeyType="search"
        />
        <Text style={styles.go} onPress={search}>
          {loading ? '…' : 'Go →'}
        </Text>
      </View>

      <FlatList
        data={results ?? []}
        keyExtractor={(l) => String(l.id)}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={
          results !== null ? <Text style={styles.empty}>Nothing matched that search.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.cell}>
            <ListingCard listing={item} onPress={() => onPressListing(item)} />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl, paddingHorizontal: spacing.lg },
  title: { fontFamily: fonts.heading, fontSize: 26, color: colors.text, marginBottom: spacing.lg },
  label: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.text, opacity: 0.7, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  input: {
    flex: 1,
    borderWidth: 2,
    borderColor: colors.text,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  go: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.accent },
  grid: { paddingBottom: spacing.xl },
  column: { gap: spacing.md, paddingHorizontal: spacing.sm },
  cell: { flex: 1 },
  empty: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.6, textAlign: 'center', marginTop: spacing.xxl },
});
