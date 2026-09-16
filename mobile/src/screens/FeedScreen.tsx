import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { initStripe, useStripe } from '@stripe/stripe-react-native';
import { Chip } from '../components/Chip';
import { ListingCard } from '../components/ListingCard';
import { listings as listingsApi, transactions as transactionsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing, categoryLabel } from '../theme';
import { useMarketplaceConfig } from '../hooks/useMarketplaceConfig';
import type { Listing } from '../api/types';
import { useAuth } from '../state/AuthContext';

// Shared by FeedScreen and SearchScreen — tapping a card offers the two
// real things a buyer can do next. There's no dedicated listing-detail
// screen yet; this keeps the interaction real (hits the actual API)
// without adding one.
//
// "Buy now" calls the real POST /api/v1/transactions/checkout, then pays the
// returned PaymentIntent with Stripe's own PaymentSheet - the same
// clientSecret/publishableKey pair the web checkout uses (see
// Checkout.jsx's loadStripe(data.publishableKey) for the pattern this
// mirrors). initStripe() is called with that key right before presenting
// the sheet rather than once at app start, since the key only exists once a
// checkout has actually begun.
//
// Apple Pay/Google Pay are offered alongside card entry - PaymentSheet adds
// them to its own UI once configured, no separate button needed. Google Pay
// works out of the box in its test environment; Apple Pay needs a real
// merchant identifier registered with Apple (see app.json's
// merchantIdentifier placeholder) before it'll actually appear on a device -
// it's harmless to leave configured in the meantime, PaymentSheet just
// won't offer it until that's real.
export function useListingActions() {
  const nav = useNavigation<any>();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { config } = useMarketplaceConfig();
  const deliveryFee = config ? `€${(config.deliveryFeeCents / 100).toFixed(0)}` : 'a small fee';

  // Guards against firing two checkouts for the same listing - e.g. tapping
  // a card again while the first "Buy now" is still awaiting the network,
  // which would reserve the listing twice and confuse whichever checkout
  // loses the race. A ref (not state) because it must block a second call
  // arriving before React re-renders, not just before the button visually
  // updates.
  const inFlight = useRef<Set<number>>(new Set());

  const pay = useCallback(
    async (listing: Listing, deliveryMethod: 'pickup' | 'delivery') => {
      if (inFlight.current.has(listing.id)) return;
      inFlight.current.add(listing.id);
      try {
        const { clientSecret, publishableKey, transaction } = await transactionsApi.checkout(listing.id, deliveryMethod);
        if (!publishableKey) {
          Alert.alert('Payments unavailable', "The server hasn't got Stripe configured right now — try again later.");
          return;
        }
        await initStripe({ publishableKey });
        const { error: initError } = await initPaymentSheet({
          paymentIntentClientSecret: clientSecret,
          merchantDisplayName: 'Uusiki',
          applePay: { merchantCountryCode: 'FI' },
          googlePay: { merchantCountryCode: 'FI', testEnv: __DEV__ },
        });
        if (initError) {
          Alert.alert('Could not start payment', initError.message);
          return;
        }
        const { error: presentError } = await presentPaymentSheet();
        if (presentError) {
          // Canceled is the common, silent case - the reservation this
          // made simply expires on its own (see RESERVATION_TTL_MINUTES),
          // same as abandoning the web checkout.
          if (presentError.code !== 'Canceled') Alert.alert('Payment failed', presentError.message);
          return;
        }
        Alert.alert('Payment sent', `€${(transaction.total_amount_cents / 100).toFixed(0)} — check the Orders tab once it settles.`);
      } catch (err) {
        Alert.alert('Could not buy', err instanceof ApiError ? err.message : String(err));
      } finally {
        inFlight.current.delete(listing.id);
      }
    },
    [initPaymentSheet, presentPaymentSheet]
  );

  return useCallback(
    (listing: Listing) => {
      Alert.alert(listing.title, `€${(listing.price_cents / 100).toFixed(0)} · ${listing.area}`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Message seller',
          onPress: () => nav.navigate('Thread', { listingId: listing.id, listingTitle: listing.title, otherPartyName: listing.seller_name }),
        },
        {
          text: 'Buy now',
          onPress: () =>
            Alert.alert('How will you get it?', `Delivery adds ${deliveryFee}.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Pickup', onPress: () => pay(listing, 'pickup') },
              { text: 'Delivery', onPress: () => pay(listing, 'delivery') },
            ]),
        },
      ]);
    },
    [nav, pay, deliveryFee]
  );
}

export function FeedScreen() {
  const { logout } = useAuth();
  const nav = useNavigation<any>();
  const { config } = useMarketplaceConfig();
  const categories = ['all', ...(config?.categories ?? [])];
  const [category, setCategory] = useState('all');
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const onPressListing = useListingActions();

  const load = useCallback(async (cat: string) => {
    const res = await listingsApi.feed({ category: cat });
    setItems(res.listings);
  }, []);

  useEffect(() => {
    setLoading(true);
    load(category)
      .catch((err) => Alert.alert('Could not load listings', err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [category, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(category).catch(() => {});
    setRefreshing(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Uusiki</Text>
          <Text style={styles.sub}>Second-hand kids gear</Text>
        </View>
        <Text style={styles.shellLink} onPress={() => nav.navigate('ParentosTabs')}>
          ← ParentOS
        </Text>
      </View>

      <FlatList
        horizontal
        data={categories}
        keyExtractor={(c) => c}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        renderItem={({ item }) => (
          <Chip label={item === 'all' ? 'All' : categoryLabel(item)} active={item === category} onPress={() => setCategory(item)} />
        )}
        style={styles.chipList}
      />

      <FlatList
        data={items}
        keyExtractor={(l) => String(l.id)}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.grid}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No listings in this category yet.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.cell}>
            <ListingCard listing={item} onPress={() => onPressListing(item)} />
          </View>
        )}
      />

      <Text style={styles.logout} onPress={logout}>
        Sign out
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  brand: { fontFamily: fonts.heading, fontSize: 26, color: colors.text },
  sub: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.6 },
  shellLink: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.accent, paddingTop: 6 },
  chipList: { flexGrow: 0, marginBottom: spacing.md },
  chipRow: { paddingHorizontal: spacing.lg },
  grid: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  column: { gap: spacing.md, paddingHorizontal: spacing.sm },
  cell: { flex: 1 },
  empty: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    opacity: 0.6,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  logout: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.text,
    opacity: 0.5,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
});
